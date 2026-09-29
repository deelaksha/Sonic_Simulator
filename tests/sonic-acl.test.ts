import { describe, it, expect } from "vitest";
import { createDevice, resetMacCounter } from "../lib/models/factory";
import { NetworkState } from "../lib/models/topology";
import { Simulation, SimEvent, CaptureRecord, resetIds } from "../lib/engine";
import { execute, CommandContext } from "../lib/commands";
import { Device } from "../lib/models/device";
import { peekFeatureState } from "../lib/models/feature-state";

interface AclState {
  tables: { name: string; type?: string; stage?: string; ports: string[] }[];
  rules: Record<string, { seq: number; action: string; match: string }[]>;
}

function build(): { state: NetworkState; sw: Device } {
  resetMacCounter(1);
  resetIds();
  const sw = createDevice({ id: "sw1", type: "switch", name: "SW1", x: 0, y: 0, ports: 4 });
  const state: NetworkState = { devices: { sw1: sw }, connections: [] };
  return { state, sw };
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

const text = (r: { output: { text: string }[] }): string => r.output.map((o) => o.text).join("\n");
const hasError = (r: { output: { kind?: string }[] }): boolean => r.output.some((o) => o.kind === "error");
const acl = (sw: Device): AclState | undefined => peekFeatureState<AclState>(sw, "acl");

describe("SONiC ACL feature (config-plane; forms from acl.txt)", () => {
  it("config acl table add creates a table; show acl table reflects it", () => {
    const { state, sw } = build();
    execute("config acl table add IPV4ACL ip ingress", ctxFor(state, sw));
    execute("sudo config acl table add MACACL mac", ctxFor(state, sw)); // sudo passthrough + default stage
    expect(acl(sw)!.tables.map((t) => t.name).sort()).toEqual(["IPV4ACL", "MACACL"]);

    const out = text(execute("show acl table", ctxFor(state, sw)));
    expect(out).toContain("IPV4ACL");
    expect(out).toContain("ip");
    expect(out).toContain("ingress");
    expect(out).toContain("MACACL");
    expect(out).toContain("mac");
  });

  it("config acl rule add stores a rule; show acl rule renders it (maps to `seq N permit ...`)", () => {
    const { state, sw } = build();
    execute("config acl table add IPV4ACL ip", ctxFor(state, sw));
    execute("config acl rule add IPV4ACL 10 permit icmp host 10.1.1.1 host 20.2.2.2", ctxFor(state, sw));
    execute("config acl rule add IPV4ACL 20 deny tcp 192.168.1.0/24 any eq 80", ctxFor(state, sw));

    const rules = acl(sw)!.rules["IPV4ACL"];
    expect(rules.map((r) => r.seq)).toEqual([10, 20]);

    const out = text(execute("show acl rule IPV4ACL", ctxFor(state, sw)));
    expect(out).toContain("seq 10 permit icmp host 10.1.1.1 host 20.2.2.2");
    expect(out).toContain("seq 20 deny tcp 192.168.1.0/24 any eq 80");
  });

  it("rejects a rule for a non-existent table", () => {
    const { state, sw } = build();
    const res = execute("config acl rule add NOSUCH 10 permit ip any any", ctxFor(state, sw));
    expect(hasError(res)).toBe(true);
    expect(text(res)).toContain("not found");
  });

  it("rejects out-of-range seq (TC-22/TC-23: 1-65535)", () => {
    const { state, sw } = build();
    execute("config acl table add T ip", ctxFor(state, sw));
    expect(hasError(execute("config acl rule add T 0 permit ip any any", ctxFor(state, sw)))).toBe(true);
    expect(hasError(execute("config acl rule add T 65536 permit ip any any", ctxFor(state, sw)))).toBe(true);
    expect(acl(sw)!.rules["T"].length).toBe(0);
  });

  it("rejects an invalid action", () => {
    const { state, sw } = build();
    execute("config acl table add T ip", ctxFor(state, sw));
    expect(hasError(execute("config acl rule add T 10 allow ip any any", ctxFor(state, sw)))).toBe(true);
  });

  it("same-seq DIFFERENT content is rejected but original is kept (TC-27); identical re-add is a no-op", () => {
    const { state, sw } = build();
    execute("config acl table add T ip", ctxFor(state, sw));
    execute("config acl rule add T 200 permit icmp any any", ctxFor(state, sw));

    const dup = execute("config acl rule add T 200 permit tcp any any", ctxFor(state, sw));
    expect(hasError(dup)).toBe(true);
    expect(text(dup)).toContain("already exists");

    const same = execute("config acl rule add T 200 permit icmp any any", ctxFor(state, sw));
    expect(hasError(same)).toBe(false);

    expect(acl(sw)!.rules["T"]).toEqual([{ seq: 200, action: "permit", match: "icmp any any" }]);
  });

  it("re-using a name with a DIFFERENT type is rejected (TC-30); same-type re-declare is a no-op", () => {
    const { state, sw } = build();
    execute("config acl table add DUP ip", ctxFor(state, sw));
    const bad = execute("config acl table add DUP mac", ctxFor(state, sw));
    expect(hasError(bad)).toBe(true);
    expect(text(bad)).toContain("same name and different type");

    expect(hasError(execute("config acl table add DUP ip", ctxFor(state, sw)))).toBe(false);
    expect(acl(sw)!.tables.filter((t) => t.name === "DUP")).toHaveLength(1);
  });

  it("config acl bind records the port; show acl table shows the binding", () => {
    const { state, sw } = build();
    execute("config acl table add IPV4ACL ip", ctxFor(state, sw));
    execute("config acl bind IPV4ACL Ethernet0 ingress", ctxFor(state, sw));
    expect(acl(sw)!.tables.find((t) => t.name === "IPV4ACL")!.ports).toEqual(["Ethernet0"]);
    expect(text(execute("show acl table IPV4ACL", ctxFor(state, sw)))).toContain("Ethernet0");
  });

  it("binding a non-existent ACL (TC-44) or an invalid port is rejected", () => {
    const { state, sw } = build();
    expect(hasError(execute("config acl bind GHOST Ethernet0", ctxFor(state, sw)))).toBe(true);
    execute("config acl table add IPV4ACL ip", ctxFor(state, sw));
    expect(hasError(execute("config acl bind IPV4ACL Ethernet99", ctxFor(state, sw)))).toBe(true);
  });

  it("deleting a table cascades its rules and bindings away (TC-46)", () => {
    const { state, sw } = build();
    execute("config acl table add IPV4ACL ip", ctxFor(state, sw));
    execute("config acl rule add IPV4ACL 10 permit ip any any", ctxFor(state, sw));
    execute("config acl bind IPV4ACL Ethernet0", ctxFor(state, sw));

    execute("config acl table del IPV4ACL", ctxFor(state, sw));
    expect(acl(sw)!.tables.length).toBe(0);
    expect(acl(sw)!.rules["IPV4ACL"]).toBeUndefined();
    expect(text(execute("show acl table", ctxFor(state, sw)))).toContain("No ACL tables configured");
  });

  it("deleting a non-existent rule or table is idempotent (TC-47/TC-48)", () => {
    const { state, sw } = build();
    execute("config acl table add T ip", ctxFor(state, sw));
    expect(hasError(execute("config acl rule del T 999", ctxFor(state, sw)))).toBe(false);
    expect(hasError(execute("config acl table del NOSUCH", ctxFor(state, sw)))).toBe(false);
  });

  it("config acl rule del removes a single rule", () => {
    const { state, sw } = build();
    execute("config acl table add T ip", ctxFor(state, sw));
    execute("config acl rule add T 10 permit ip any any", ctxFor(state, sw));
    execute("config acl rule add T 20 deny ip any any", ctxFor(state, sw));
    execute("config acl rule del T 10", ctxFor(state, sw));
    expect(acl(sw)!.rules["T"].map((r) => r.seq)).toEqual([20]);
  });
});
