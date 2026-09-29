import { describe, it, expect } from "vitest";
import { createDevice, resetMacCounter } from "../lib/models/factory";
import { NetworkState } from "../lib/models/topology";
import { Simulation, SimEvent, CaptureRecord, resetIds } from "../lib/engine";
import { execute, CommandContext } from "../lib/commands";
import { Device } from "../lib/models/device";
import { peekFeatureState } from "../lib/models/feature-state";

interface BgpState {
  localAs: number | undefined;
  routerId: string | undefined;
  neighbors: { peer: string; remoteAs?: number; description?: string; ebgpMultihop?: number }[];
  networks: string[];
}

function build() {
  resetMacCounter(1);
  resetIds();
  const r1 = createDevice({ id: "r1", type: "router", name: "R1", x: 0, y: 0, ports: 4 });
  const state: NetworkState = { devices: { r1 }, connections: [] };
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

function bgp(dev: Device): BgpState | undefined {
  return peekFeatureState<BgpState>(dev, "bgp");
}

describe("SONiC BGP feature (config-plane; source bgp.txt)", () => {
  it("config router bgp <as> sets the local AS", () => {
    const state = build();
    const r1 = state.devices.r1;
    execute("config router bgp 65001", ctxFor(state, r1));
    expect(bgp(r1)?.localAs).toBe(65001);
  });

  it("rejects an out-of-range AS (bgp.txt TC-66/TC-67)", () => {
    const state = build();
    const r1 = state.devices.r1;
    expect(execute("config router bgp 0", ctxFor(state, r1)).output.some((o) => o.kind === "error")).toBe(true);
    expect(execute("config router bgp 4294967296", ctxFor(state, r1)).output.some((o) => o.kind === "error")).toBe(true);
    expect(bgp(r1)?.localAs).toBeUndefined();
  });

  it("config router bgp router-id stores the router-id", () => {
    const state = build();
    const r1 = state.devices.r1;
    execute("config router bgp 65001", ctxFor(state, r1));
    execute("config router bgp router-id 1.1.1.1", ctxFor(state, r1));
    expect(bgp(r1)?.routerId).toBe("1.1.1.1");
  });

  it("neighbor config requires BGP to be enabled first", () => {
    const state = build();
    const r1 = state.devices.r1;
    const res = execute("config router bgp neighbor 30.1.1.2 remote-as 65002", ctxFor(state, r1));
    expect(res.output.some((o) => o.kind === "error")).toBe(true);
    expect(bgp(r1)?.neighbors ?? []).toHaveLength(0);
  });

  it("config router bgp neighbor <ip> remote-as <as> stores the neighbor", () => {
    const state = build();
    const r1 = state.devices.r1;
    execute("config router bgp 65001", ctxFor(state, r1));
    execute("config router bgp neighbor 30.1.1.2 remote-as 65002", ctxFor(state, r1));
    const nb = bgp(r1)?.neighbors ?? [];
    expect(nb).toHaveLength(1);
    expect(nb[0]).toMatchObject({ peer: "30.1.1.2", remoteAs: 65002 });
  });

  it("rejects an out-of-range remote-as and ebgp-multihop (bgp.txt TC-53/54/66/67)", () => {
    const state = build();
    const r1 = state.devices.r1;
    execute("config router bgp 65001", ctxFor(state, r1));
    expect(
      execute("config router bgp neighbor 30.1.1.2 remote-as 0", ctxFor(state, r1)).output.some((o) => o.kind === "error"),
    ).toBe(true);
    expect(
      execute("config router bgp neighbor 30.1.1.2 ebgp-multihop 256", ctxFor(state, r1)).output.some((o) => o.kind === "error"),
    ).toBe(true);
    expect(bgp(r1)?.neighbors[0]?.remoteAs).toBeUndefined();
    expect(bgp(r1)?.neighbors[0]?.ebgpMultihop).toBeUndefined();
  });

  it("show ip bgp summary reflects local AS, router-id and the neighbor table", () => {
    const state = build();
    const r1 = state.devices.r1;
    execute("config router bgp 65001", ctxFor(state, r1));
    execute("config router bgp router-id 1.1.1.1", ctxFor(state, r1));
    execute("config router bgp neighbor 30.1.1.2 remote-as 65002", ctxFor(state, r1));
    const out = text(execute("show ip bgp summary", ctxFor(state, r1)));
    expect(out).toContain("local AS number 65001");
    expect(out).toContain("1.1.1.1");
    expect(out).toContain("30.1.1.2");
    expect(out).toContain("Total number of neighbors 1");
    // Not converged → honest "Idle" state, never a fabricated "Established".
    expect(out).not.toContain("Established");
    expect(out).toContain("Total number of neighbors established 0");
  });

  it("baseline summary reports AS 0 and no neighbors (bgp.txt TC-2)", () => {
    const state = build();
    const r1 = state.devices.r1;
    const out = text(execute("show bgp summary", ctxFor(state, r1)));
    expect(out).toContain("local AS number 0");
    expect(out).toContain("% No BGP neighbors configured");
  });

  it("show ip bgp neighbors renders external vs internal link from config only", () => {
    const state = build();
    const r1 = state.devices.r1;
    execute("config router bgp 65001", ctxFor(state, r1));
    execute("config router bgp neighbor 30.1.1.2 remote-as 65002", ctxFor(state, r1)); // eBGP
    execute("config router bgp neighbor 30.1.1.3 remote-as 65001", ctxFor(state, r1)); // iBGP
    const out = text(execute("show ip bgp neighbors", ctxFor(state, r1)));
    expect(out).toContain("BGP neighbor is 30.1.1.2, remote AS 65002, local AS 65001, external link");
    expect(out).toContain("BGP neighbor is 30.1.1.3, remote AS 65001, local AS 65001, internal link");
    expect(out).toContain("BGP state = Idle"); // not converged → honest Idle, not fabricated Established
  });

  it("network is originated into the local BGP table (show ip bgp), normalized to network address", () => {
    const state = build();
    const r1 = state.devices.r1;
    execute("config router bgp 65001", ctxFor(state, r1));
    execute("config router bgp network 30.1.1.3/24", ctxFor(state, r1));
    expect(bgp(r1)?.networks).toEqual(["30.1.1.0/24"]);
    const out = text(execute("show ip bgp", ctxFor(state, r1)));
    expect(out).toContain("30.1.1.0/24");
    expect(out).toContain("Total number of routes: 1");
  });

  it("config router bgp no neighbor <ip> deletes the neighbor", () => {
    const state = build();
    const r1 = state.devices.r1;
    execute("config router bgp 65001", ctxFor(state, r1));
    execute("config router bgp neighbor 30.1.1.2 remote-as 65002", ctxFor(state, r1));
    execute("config router bgp no neighbor 30.1.1.2", ctxFor(state, r1));
    expect(bgp(r1)?.neighbors ?? []).toHaveLength(0);
    const out = text(execute("show ip bgp summary", ctxFor(state, r1)));
    expect(out).toContain("% No BGP neighbors configured");
  });

  it("config router bgp no removes the whole BGP instance", () => {
    const state = build();
    const r1 = state.devices.r1;
    execute("config router bgp 65001", ctxFor(state, r1));
    execute("config router bgp neighbor 30.1.1.2 remote-as 65002", ctxFor(state, r1));
    execute("config router bgp no", ctxFor(state, r1));
    expect(bgp(r1)?.localAs).toBeUndefined();
    expect(bgp(r1)?.neighbors ?? []).toHaveLength(0);
  });

  it("regression: show ip route and show ip arp still resolve to their own handlers, not BGP", () => {
    const state = build();
    const r1 = state.devices.r1;
    // show ip route -> static-route handler ("(no routes)" for an empty table),
    // never the BGP RIB header.
    const routeOut = text(execute("show ip route", ctxFor(state, r1)));
    expect(routeOut).toContain("(no routes)");
    expect(routeOut).not.toContain("BGP table version");
    // show ip arp -> arp/nd handler.
    const arpOut = text(execute("show ip arp", ctxFor(state, r1)));
    expect(arpOut).toContain("No ARP entries found.");
    expect(arpOut).not.toContain("BGP");
  });
});
