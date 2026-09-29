import { describe, it, expect } from "vitest";
import { createDevice, resetMacCounter } from "../lib/models/factory";
import { NetworkState } from "../lib/models/topology";
import { Simulation, SimEvent, CaptureRecord, resetIds } from "../lib/engine";
import { execute, CommandContext } from "../lib/commands";
import { Device } from "../lib/models/device";

function build(): { state: NetworkState; dev: Device } {
  resetMacCounter(1);
  resetIds();
  const r1 = createDevice({ id: "r1", type: "router", name: "R1", x: 0, y: 0 });
  const state: NetworkState = { devices: { r1 }, connections: [] };
  return { state, dev: r1 };
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
function hasError(res: { output: { kind?: string }[] }): boolean {
  return res.output.some((o) => o.kind === "error");
}

describe("SONiC prefix-list feature (source: prefixlist.txt, IPv4)", () => {
  it("baseline view is empty", () => {
    const { state, dev } = build();
    expect(text(execute("show ip prefix-list", ctxFor(state, dev)))).toContain("No IP prefix-list configured");
  });

  it("adds entries and renders them sorted by seq with ge/le normalization (TC-7)", () => {
    const { state, dev } = build();
    // Inserted out of seq order to prove sorting.
    execute("config ip prefix-list AGTPL4 seq 30 permit 10.0.0.0/8 ge 8 le 32", ctxFor(state, dev));
    execute("config ip prefix-list AGTPL4 seq 5 permit 10.0.0.0/8", ctxFor(state, dev));
    execute("config ip prefix-list AGTPL4 seq 10 permit 172.16.0.0/12 ge 20", ctxFor(state, dev));
    execute("config ip prefix-list AGTPL4 seq 15 permit 192.168.0.0/16 le 28", ctxFor(state, dev));
    execute("config ip prefix-list AGTPL4 seq 20 permit 10.10.0.0/16 ge 24 le 28", ctxFor(state, dev));
    execute("config ip prefix-list AGTPL4 seq 25 deny 100.64.0.0/10", ctxFor(state, dev));
    const lines = text(execute("show ip prefix-list AGTPL4", ctxFor(state, dev))).split("\n");
    expect(lines).toEqual([
      "IP prefix list AGTPL4:",
      "seq 5 permit 10.0.0.0/8",
      "seq 10 permit 172.16.0.0/12 ge 20 le 32", // ge without le implies le 32
      "seq 15 permit 192.168.0.0/16 le 28",
      "seq 20 permit 10.10.0.0/16 ge 24 le 28",
      "seq 25 deny 100.64.0.0/10",
      "seq 30 permit 10.0.0.0/8 le 32", // ge == prefix-len (8) is hidden
    ]);
  });

  it("show ip prefix-list (no name) lists all configured lists", () => {
    const { state, dev } = build();
    execute("config ip prefix-list A seq 5 permit 10.0.0.0/8", ctxFor(state, dev));
    execute("config ip prefix-list B seq 5 permit 172.16.0.0/12", ctxFor(state, dev));
    const t = text(execute("show ip prefix-list", ctxFor(state, dev)));
    expect(t).toContain("IP prefix list A:");
    expect(t).toContain("IP prefix list B:");
    expect(t).toContain("seq 5 permit 10.0.0.0/8");
    expect(t).toContain("seq 5 permit 172.16.0.0/12");
  });

  it("rejects invalid input: missing seq, bad cidr, out-of-range ge, and bad ranges (TC-13..17)", () => {
    const { state, dev } = build();
    expect(hasError(execute("config ip prefix-list B permit 200.0.0.0/8", ctxFor(state, dev)))).toBe(true); // no seq (TC-13)
    expect(hasError(execute("config ip prefix-list B seq 5 permit 10.999.0.0/8", ctxFor(state, dev)))).toBe(true); // bad cidr
    expect(hasError(execute("config ip prefix-list B seq 6 permit 10.0.0.0/33", ctxFor(state, dev)))).toBe(true); // bad prefix-len
    expect(hasError(execute("config ip prefix-list B seq 10 permit 10.10.0.0/16 ge 33", ctxFor(state, dev)))).toBe(true); // ge>32 (TC-14)
    expect(hasError(execute("config ip prefix-list B seq 15 permit 10.10.0.0/16 le 33", ctxFor(state, dev)))).toBe(true); // le>32 (TC-15)
    expect(hasError(execute("config ip prefix-list B seq 20 permit 10.10.0.0/16 ge 28 le 24", ctxFor(state, dev)))).toBe(true); // ge>le (TC-16)
    expect(hasError(execute("config ip prefix-list B seq 25 permit 192.168.0.0/16 ge 8", ctxFor(state, dev)))).toBe(true); // ge<len (TC-17)
    // Nothing above was accepted, so the list must not exist (TC-19).
    expect(text(execute("show ip prefix-list B", ctxFor(state, dev)))).toContain("No IP prefix-list configured");
  });

  it("rejects re-using a seq with a different prefix; identical re-add is a no-op (TC-22/23)", () => {
    const { state, dev } = build();
    execute("config ip prefix-list AGTX seq 5 permit 10.0.0.0/8", ctxFor(state, dev));
    expect(hasError(execute("config ip prefix-list AGTX seq 5 permit 20.0.0.0/8", ctxFor(state, dev)))).toBe(true);
    const t = text(execute("show ip prefix-list AGTX", ctxFor(state, dev)));
    expect(t).toContain("seq 5 permit 10.0.0.0/8");
    expect(t).not.toContain("20.0.0.0"); // seq 5 unchanged (TC-23)
    // Identical re-add succeeds without error and does not duplicate the entry.
    expect(hasError(execute("config ip prefix-list AGTX seq 5 permit 10.0.0.0/8", ctxFor(state, dev)))).toBe(false);
    expect(text(execute("show ip prefix-list AGTX", ctxFor(state, dev))).split("\n")).toEqual([
      "IP prefix list AGTX:",
      "seq 5 permit 10.0.0.0/8",
    ]);
  });

  it("deletes by full key, rejects seq-only delete, and auto-removes an emptied list (TC-24/25/26)", () => {
    const { state, dev } = build();
    execute("config ip prefix-list AGTX seq 5 permit 10.0.0.0/8", ctxFor(state, dev));
    execute("config ip prefix-list AGTX seq 10 permit 172.16.0.0/12", ctxFor(state, dev));
    // Deleting by seq only is rejected (TC-24).
    expect(hasError(execute("config no ip prefix-list AGTX seq 10", ctxFor(state, dev)))).toBe(true);
    // Full-key delete of seq 10 succeeds (TC-25).
    execute("config no ip prefix-list AGTX seq 10 permit 172.16.0.0/12", ctxFor(state, dev));
    const t = text(execute("show ip prefix-list AGTX", ctxFor(state, dev)));
    expect(t).toContain("seq 5 permit 10.0.0.0/8");
    expect(t).not.toContain("172.16.0.0");
    // Deleting the last entry auto-removes the whole list (TC-26).
    execute("config no ip prefix-list AGTX seq 5 permit 10.0.0.0/8", ctxFor(state, dev));
    expect(text(execute("show ip prefix-list AGTX", ctxFor(state, dev)))).toContain("No IP prefix-list configured");
  });

  it("no ip prefix-list <name> removes the whole list (TC-27)", () => {
    const { state, dev } = build();
    execute("config ip prefix-list AGTX seq 5 permit 10.0.0.0/8", ctxFor(state, dev));
    execute("config ip prefix-list AGTX seq 10 permit 172.16.0.0/12", ctxFor(state, dev));
    execute("config no ip prefix-list AGTX", ctxFor(state, dev));
    expect(text(execute("show ip prefix-list", ctxFor(state, dev)))).toContain("No IP prefix-list configured");
  });

  it("does not shadow the reserved ip paths (show ip route / show ip arp still resolve)", () => {
    const { state, dev } = build();
    execute("config ip prefix-list AGTX seq 5 permit 10.0.0.0/8", ctxFor(state, dev));
    const route = text(execute("show ip route", ctxFor(state, dev)));
    expect(route).not.toContain("IP prefix list"); // routed to the static-route handler, not prefix-list
    const arp = text(execute("show ip arp", ctxFor(state, dev)));
    expect(arp).toContain("No ARP entries found."); // routed to the ARP handler
  });
});
