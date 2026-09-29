import { describe, it, expect } from "vitest";
import { createDevice, resetMacCounter } from "../lib/models/factory";
import { NetworkState } from "../lib/models/topology";
import { Simulation, SimEvent, CaptureRecord, resetIds } from "../lib/engine";
import { execute, CommandContext } from "../lib/commands";
import { Device } from "../lib/models/device";
import { peekFeatureState } from "../lib/models/feature-state";

function build() {
  resetMacCounter(1);
  resetIds();
  const sw1 = createDevice({ id: "sw1", type: "switch", name: "SW1", x: 0, y: 0, ports: 4 });
  const state: NetworkState = { devices: { sw1 }, connections: [] };
  return state;
}

function ctxFor(state: NetworkState, device: Device): CommandContext {
  const captures: CaptureRecord[] = [];
  return {
    device,
    network: state,
    captures,
    runSim<T>(fn: (sim: Simulation) => T): { value: T; events: SimEvent[] } {
      const sim = new Simulation(state);
      const value = fn(sim);
      captures.push(...sim.captures);
      return { value, events: sim.events };
    },
  };
}

function text(res: { output: { text: string }[] }): string {
  return res.output.map((o) => o.text).join("\n");
}

interface FbsPeek {
  classifiers: { name: string; matches: { field: string; value: string }[] }[];
  policies: { name: string; type: string; flows: { classifier: string; priority: number; actions: { name: string; detail: string }[] }[] }[];
  bindings: { policy: string; iface: string; direction: string }[];
}

describe("SONiC FBS feature (config-plane; source fbs.txt)", () => {
  it("classifier add + match stores criteria (class-map / match)", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config fbs classifier add CLASS_DSCP", ctxFor(state, sw));
    execute("config fbs classifier match CLASS_DSCP dscp 46", ctxFor(state, sw));
    execute("sudo config fbs classifier match CLASS_DSCP src-ip 10.0.0.0/24", ctxFor(state, sw)); // sudo passthrough
    const st = peekFeatureState<FbsPeek>(sw, "fbs")!;
    expect(st.classifiers.map((c) => c.name)).toEqual(["CLASS_DSCP"]);
    expect(st.classifiers[0].matches).toEqual([
      { field: "dscp", value: "46" },
      { field: "src-ip", value: "10.0.0.0/24" },
    ]);
  });

  it("rejects out-of-range and unknown match fields", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config fbs classifier add C1", ctxFor(state, sw));
    expect(execute("config fbs classifier match C1 dscp 99", ctxFor(state, sw)).output.some((o) => o.kind === "error")).toBe(true);
    expect(execute("config fbs classifier match C1 bogus 1", ctxFor(state, sw)).output.some((o) => o.kind === "error")).toBe(true);
    expect(execute("config fbs classifier match NOPE dscp 1", ctxFor(state, sw)).output.some((o) => o.kind === "error")).toBe(true);
  });

  it("policy add + flow + actions builds a policy-map with flows/actions", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config fbs classifier add CLASS_DSCP", ctxFor(state, sw));
    execute("config fbs policy add POLICY_QOS qos", ctxFor(state, sw));
    execute("config fbs policy flow add POLICY_QOS CLASS_DSCP 100", ctxFor(state, sw));
    execute("config fbs policy flow action POLICY_QOS CLASS_DSCP set-dscp 46", ctxFor(state, sw));
    execute("config fbs policy flow action POLICY_QOS CLASS_DSCP police cir 1000 cbs 10000", ctxFor(state, sw));
    const st = peekFeatureState<FbsPeek>(sw, "fbs")!;
    const p = st.policies[0];
    expect(p.type).toBe("qos");
    expect(p.flows[0].classifier).toBe("CLASS_DSCP");
    expect(p.flows[0].priority).toBe(100);
    expect(p.flows[0].actions).toEqual([
      { name: "set-dscp", detail: "46" },
      { name: "police", detail: "cir 1000 cbs 10000" },
    ]);
  });

  it("flow add rejects unknown policy/classifier and bad priority", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config fbs policy add P qos", ctxFor(state, sw));
    expect(execute("config fbs policy flow add NOPE C 10", ctxFor(state, sw)).output.some((o) => o.kind === "error")).toBe(true);
    expect(execute("config fbs policy flow add P NOPE 10", ctxFor(state, sw)).output.some((o) => o.kind === "error")).toBe(true);
    execute("config fbs classifier add C", ctxFor(state, sw));
    expect(execute("config fbs policy flow add P C x", ctxFor(state, sw)).output.some((o) => o.kind === "error")).toBe(true);
  });

  it("bind attaches a policy to an interface; unknown iface/policy rejected", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config fbs classifier add C", ctxFor(state, sw));
    execute("config fbs policy add P qos", ctxFor(state, sw));
    execute("config fbs policy flow add P C 10", ctxFor(state, sw));
    execute("config fbs bind P Ethernet0 in", ctxFor(state, sw));
    const st = peekFeatureState<FbsPeek>(sw, "fbs")!;
    expect(st.bindings).toEqual([{ policy: "P", iface: "Ethernet0", direction: "in" }]);
    expect(execute("config fbs bind P NoSuchIf in", ctxFor(state, sw)).output.some((o) => o.kind === "error")).toBe(true);
    expect(execute("config fbs bind NOPE Ethernet0 in", ctxFor(state, sw)).output.some((o) => o.kind === "error")).toBe(true);
    expect(execute("config fbs bind P Ethernet0 sideways", ctxFor(state, sw)).output.some((o) => o.kind === "error")).toBe(true);
  });

  it("full lifecycle: create classifier + policy + bind -> show reflects state", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config fbs classifier add CLASS_DSCP", ctxFor(state, sw));
    execute("config fbs classifier match CLASS_DSCP dscp 10", ctxFor(state, sw));
    execute("config fbs policy add POLICY_QOS qos", ctxFor(state, sw));
    execute("config fbs policy flow add POLICY_QOS CLASS_DSCP 100", ctxFor(state, sw));
    execute("config fbs policy flow action POLICY_QOS CLASS_DSCP set-dscp 46", ctxFor(state, sw));
    execute("config fbs bind POLICY_QOS Ethernet0 in", ctxFor(state, sw));

    const cls = text(execute("show fbs classifier", ctxFor(state, sw)));
    expect(cls).toContain("Class-map CLASS_DSCP match-type fields");
    expect(cls).toContain("dscp 10");
    expect(cls).toContain("Referenced in flows:");
    expect(cls).toContain("policy POLICY_QOS at priority 100");

    const pol = text(execute("show fbs policy POLICY_QOS", ctxFor(state, sw)));
    expect(pol).toContain("Policy POLICY_QOS Type QOS");
    expect(pol).toContain("Flow CLASS_DSCP at priority 100");
    expect(pol).toContain("set-dscp 46");

    const bind = text(execute("show fbs bindings", ctxFor(state, sw)));
    expect(bind).toContain("Ethernet0");
    expect(bind).toContain("qos policy POLICY_QOS at ingress");

    const summary = text(execute("show fbs", ctxFor(state, sw)));
    expect(summary).toContain("FBS classifiers : 1");
    expect(summary).toContain("FBS policies    : 1");
    expect(summary).toContain("FBS bindings    : 1");
  });

  it("del cascades: classifier del removes flows; policy del removes bindings", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config fbs classifier add C", ctxFor(state, sw));
    execute("config fbs policy add P qos", ctxFor(state, sw));
    execute("config fbs policy flow add P C 10", ctxFor(state, sw));
    execute("config fbs bind P Ethernet0 in", ctxFor(state, sw));

    execute("config fbs classifier del C", ctxFor(state, sw));
    let st = peekFeatureState<FbsPeek>(sw, "fbs")!;
    expect(st.classifiers.length).toBe(0);
    expect(st.policies[0].flows.length).toBe(0); // dangling flow dropped

    execute("config fbs policy del P", ctxFor(state, sw));
    st = peekFeatureState<FbsPeek>(sw, "fbs")!;
    expect(st.policies.length).toBe(0);
    expect(st.bindings.length).toBe(0); // dangling binding dropped

    // deleting again is an idempotent no-op (not an error)
    const again = execute("config fbs policy del P", ctxFor(state, sw));
    expect(again.output.some((o) => o.kind === "error")).toBe(false);
    expect(text(execute("show fbs", ctxFor(state, sw)))).toContain("No FBS configuration");
  });
});
