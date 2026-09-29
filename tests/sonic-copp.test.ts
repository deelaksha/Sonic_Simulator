import { describe, it, expect } from "vitest";
import { createDevice, resetMacCounter } from "../lib/models/factory";
import { NetworkState } from "../lib/models/topology";
import { Simulation, SimEvent, CaptureRecord, resetIds } from "../lib/engine";
import { execute, CommandContext } from "../lib/commands";
import { Device } from "../lib/models/device";
import { peekFeatureState } from "../lib/models/feature-state";

interface CoppState {
  actions: { name: string; trapAction?: string; trapQueue?: number; trapPriority?: number; cir?: number; cbs?: number }[];
  classifiers: { name: string; protocols: string[] }[];
  bindings: { classifier: string; action: string; priority: number }[];
}

function build(): NetworkState {
  resetMacCounter(1);
  resetIds();
  const sw1 = createDevice({ id: "sw1", type: "switch", name: "SW1", x: 0, y: 0, ports: 4 });
  return { devices: { sw1 }, connections: [] };
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

function copp(sw: Device): CoppState | undefined {
  return peekFeatureState<CoppState>(sw, "copp");
}

describe("SONiC CoPP feature (control-plane policing, config-plane)", () => {
  it("config copp action set stores trap-action/queue/priority/police (copp-action + set + police)", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config copp action add cli-test-lacp", ctxFor(state, sw));
    execute("config copp action set cli-test-lacp trap-action trap", ctxFor(state, sw));
    execute("sudo config copp action set cli-test-lacp trap-queue 5", ctxFor(state, sw)); // sudo passthrough
    execute("config copp action set cli-test-lacp trap-priority 100", ctxFor(state, sw));
    execute("config copp action set cli-test-lacp police cir 6000 cbs 6000", ctxFor(state, sw));

    const g = copp(sw)!.actions.find((a) => a.name === "cli-test-lacp")!;
    expect(g.trapAction).toBe("trap");
    expect(g.trapQueue).toBe(5);
    expect(g.trapPriority).toBe(100);
    expect(g.cir).toBe(6000);
    expect(g.cbs).toBe(6000);
  });

  it("show copp actions renders the configured group (matches copp.txt TC-5 shape)", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config copp action add cli-test-lacp", ctxFor(state, sw));
    execute("config copp action set cli-test-lacp trap-action trap", ctxFor(state, sw));
    execute("config copp action set cli-test-lacp trap-priority 100", ctxFor(state, sw));
    execute("config copp action set cli-test-lacp trap-queue 5", ctxFor(state, sw));
    execute("config copp action set cli-test-lacp police cir 6000 cbs 6000", ctxFor(state, sw));

    const out = text(execute("show copp actions", ctxFor(state, sw)));
    expect(out).toContain("CoPP action group cli-test-lacp");
    expect(out).toContain("trap-action trap");
    expect(out).toContain("trap-priority 100");
    expect(out).toContain("trap-queue 5");
    expect(out).toContain("police cir 6000 cbs 6000");
  });

  it("every COPP_TRAP_ACTION enum value is accepted, unknown one rejected (copp.txt 320-327)", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config copp action add a1", ctxFor(state, sw));
    for (const act of ["drop", "forward", "copy", "copy_cancel", "log", "deny", "transit", "trap"]) {
      const res = execute(`config copp action set a1 trap-action ${act}`, ctxFor(state, sw));
      expect(res.output.some((o) => o.kind === "error")).toBe(false);
    }
    expect(copp(sw)!.actions[0].trapAction).toBe("trap");
    const bad = execute("config copp action set a1 trap-action permit", ctxFor(state, sw));
    expect(bad.output.some((o) => o.kind === "error")).toBe(true);
  });

  it("rejects out-of-range trap-queue/trap-priority and bad police rates (TC-26/27/28/29/24)", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config copp action add a1", ctxFor(state, sw));
    const err = (cmd: string) => execute(cmd, ctxFor(state, sw)).output.some((o) => o.kind === "error");
    expect(err("config copp action set a1 trap-queue 32")).toBe(true); // >max 31
    expect(err("config copp action set a1 trap-priority 1024")).toBe(true); // >max 1023
    expect(err("config copp action set a1 police cir 0 cbs 6000")).toBe(true); // <min
    expect(err("config copp action set a1 police cir 4294967296 cbs 1")).toBe(true); // >uint32 max
    expect(err("config copp action set a1 police cir 1000kbps cbs 1")).toBe(true); // unit suffix rejected
    // boundaries accepted
    expect(err("config copp action set a1 trap-queue 31")).toBe(false);
    expect(err("config copp action set a1 trap-priority 1023")).toBe(false);
    // nothing bad was stored from the rejected police attempts
    expect(copp(sw)!.actions[0].cir).toBeUndefined();
  });

  it("set on a non-existent action group errors", () => {
    const state = build();
    const sw = state.devices.sw1;
    const res = execute("config copp action set ghost trap-action trap", ctxFor(state, sw));
    expect(res.output.some((o) => o.kind === "error")).toBe(true);
  });

  it("classifier match protocol: supported added, unsupported and already-claimed rejected (TC-34/35)", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config copp classifier add cli-test-lacp", ctxFor(state, sw));
    execute("config copp classifier match cli-test-lacp lacp", ctxFor(state, sw));
    expect(copp(sw)!.classifiers[0].protocols).toEqual(["lacp"]);

    const bogus = execute("config copp classifier match cli-test-lacp bogusproto123", ctxFor(state, sw));
    expect(bogus.output.some((o) => o.kind === "error")).toBe(true);
    expect(text(bogus)).toContain("not a supported COPP protocol");

    // bgp claimed by classifier 'bgp'; claiming it from another classifier is rejected (TC-34)
    execute("config copp classifier add bgp", ctxFor(state, sw));
    execute("config copp classifier match bgp bgp", ctxFor(state, sw));
    const claimed = execute("config copp classifier match cli-test-lacp bgp", ctxFor(state, sw));
    expect(claimed.output.some((o) => o.kind === "error")).toBe(true);
    expect(text(claimed)).toContain("already claimed");
  });

  it("show copp classifiers reflects protocols; no-match removes one (TC-6/TC-36)", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config copp classifier add c1", ctxFor(state, sw));
    execute("config copp classifier match c1 ssh", ctxFor(state, sw));
    execute("config copp classifier match c1 isis", ctxFor(state, sw));
    execute("config copp classifier no-match c1 isis", ctxFor(state, sw));
    const out = text(execute("show copp classifiers", ctxFor(state, sw)));
    expect(out).toContain("Classifier c1 match-type copp");
    expect(out).toContain("protocol ssh");
    expect(out).not.toContain("protocol isis");
  });

  it("bind classifier to action shows a Flow/Action in show copp policy (TC-7)", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config copp action add cli-test-lacp", ctxFor(state, sw));
    execute("config copp action set cli-test-lacp trap-action trap", ctxFor(state, sw));
    execute("config copp classifier add cli-test-lacp", ctxFor(state, sw));
    execute("config copp classifier match cli-test-lacp lacp", ctxFor(state, sw));
    execute("config copp bind cli-test-lacp cli-test-lacp 100", ctxFor(state, sw));

    const out = text(execute("show copp policy", ctxFor(state, sw)));
    expect(out).toContain("Policy copp-system-policy Type copp");
    expect(out).toContain("Flow cli-test-lacp");
    expect(out).toContain("Action cli-test-lacp");
    expect(out).toContain("trap-action trap");

    expect(copp(sw)!.bindings[0]).toEqual({ classifier: "cli-test-lacp", action: "cli-test-lacp", priority: 100 });
  });

  it("bind rejects unknown classifier or action", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config copp action add a1", ctxFor(state, sw));
    expect(execute("config copp bind noclass a1", ctxFor(state, sw)).output.some((o) => o.kind === "error")).toBe(true);
    execute("config copp classifier add c1", ctxFor(state, sw));
    expect(execute("config copp bind c1 noaction", ctxFor(state, sw)).output.some((o) => o.kind === "error")).toBe(true);
  });

  it("del removes group/classifier, drops dangling bindings, and missing del is a no-op (TC-31)", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config copp action add a1", ctxFor(state, sw));
    execute("config copp classifier add c1", ctxFor(state, sw));
    execute("config copp bind c1 a1", ctxFor(state, sw));
    expect(copp(sw)!.bindings).toHaveLength(1);

    execute("config copp action del a1", ctxFor(state, sw));
    expect(copp(sw)!.actions).toHaveLength(0);
    expect(copp(sw)!.bindings).toHaveLength(0); // dangling binding dropped

    execute("config copp classifier del c1", ctxFor(state, sw));
    expect(copp(sw)!.classifiers).toHaveLength(0);

    // deleting a non-existent group is an idempotent no-op, not an error (TC-31)
    const noop = execute("config copp action del nonexist", ctxFor(state, sw));
    expect(noop.output.some((o) => o.kind === "error")).toBe(false);
  });

  it("show copp protocols lists supported protocols; empty views print no-config messages", () => {
    const state = build();
    const sw = state.devices.sw1;
    const protos = text(execute("show copp protocols", ctxFor(state, sw)));
    expect(protos).toContain("Class-map match-type copp protocols");
    expect(protos).toContain("protocol arp_req");
    expect(protos).toContain("protocol lacp");

    expect(text(execute("show copp actions", ctxFor(state, sw)))).toContain("No CoPP action groups configured");
    expect(text(execute("show copp classifiers", ctxFor(state, sw)))).toContain("No CoPP classifiers configured");
    expect(text(execute("show copp policy", ctxFor(state, sw)))).toContain("No CoPP policy bindings configured");
    expect(text(execute("show copp", ctxFor(state, sw)))).toContain("No CoPP configuration");
  });

  it("re-setting a field overwrites (modify), and re-add is idempotent", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config copp action add a1", ctxFor(state, sw));
    execute("config copp action set a1 trap-action drop", ctxFor(state, sw));
    execute("config copp action set a1 trap-action forward", ctxFor(state, sw));
    execute("config copp action add a1", ctxFor(state, sw)); // idempotent re-add
    expect(copp(sw)!.actions).toHaveLength(1);
    expect(copp(sw)!.actions[0].trapAction).toBe("forward");
  });
});
