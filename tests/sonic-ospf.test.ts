import { describe, it, expect } from "vitest";
import { createDevice, resetMacCounter } from "../lib/models/factory";
import { NetworkState } from "../lib/models/topology";
import { Simulation, SimEvent, CaptureRecord, resetIds } from "../lib/engine";
import { execute, CommandContext } from "../lib/commands";
import { Device } from "../lib/models/device";
import { peekFeatureState } from "../lib/models/feature-state";

function build(): NetworkState {
  resetMacCounter(1);
  resetIds();
  const r1 = createDevice({ id: "r1", type: "router", name: "R1", x: 0, y: 0, ports: 4 });
  r1.interfaces[0].ipv4 = [{ address: "150.150.100.20", prefix: 24 }];
  return { devices: { r1 }, connections: [] };
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

interface OspfState {
  routerId: string | undefined;
  networks: { network: string; area: string }[];
  areas: { id: string; type?: string }[];
}

function text(res: { output: { text: string }[] }): string {
  return res.output.map((o) => o.text).join("\n");
}

describe("SONiC OSPF feature (config-plane)", () => {
  it("router-id + network/area are stored and reflected by show ip ospf", () => {
    const state = build();
    const r1 = state.devices.r1;
    execute("config router ospf router-id 1.1.1.1", ctxFor(state, r1));
    execute("config router ospf network 150.150.100.0/24 area 0", ctxFor(state, r1));
    execute("sudo config router ospf network 9.9.9.9/32 area 9", ctxFor(state, r1)); // sudo passthrough

    const st = peekFeatureState<OspfState>(r1, "ospf");
    expect(st?.routerId).toBe("1.1.1.1");
    // `area 0` / `area 9` are normalized to dotted form.
    expect(st?.networks).toEqual([
      { network: "150.150.100.0/24", area: "0.0.0.0" },
      { network: "9.9.9.9/32", area: "0.0.0.9" },
    ]);

    const t = text(execute("show ip ospf", ctxFor(state, r1)));
    expect(t).toContain("Router ID: 1.1.1.1");
    expect(t).toContain("Number of areas attached to this router: 2");
    expect(t).toContain("Area ID: 0.0.0.0 (Backbone)");
    expect(t).toContain("Area ID: 0.0.0.9");
  });

  it("rejects a zero router-id (nothing stored)", () => {
    const state = build();
    const r1 = state.devices.r1;
    const res = execute("config router ospf router-id 0.0.0.0", ctxFor(state, r1));
    expect(res.output.some((o) => o.kind === "error")).toBe(true);
    expect(text(res)).toContain("Router ID must be a non-zero IPv4 address");
    expect(peekFeatureState<OspfState>(r1, "ospf")?.routerId).toBeUndefined();
  });

  it("no network <cidr> area <id> withdraws the network", () => {
    const state = build();
    const r1 = state.devices.r1;
    execute("config router ospf network 60.60.60.0/24 area 0", ctxFor(state, r1));
    execute("config router ospf network 9.9.9.9/32 area 9", ctxFor(state, r1));
    execute("config router ospf no network 60.60.60.0/24 area 0", ctxFor(state, r1));

    const st = peekFeatureState<OspfState>(r1, "ospf");
    expect(st?.networks).toEqual([{ network: "9.9.9.9/32", area: "0.0.0.9" }]);
    // deleting an absent network is a silent no-op (no error line)
    const res = execute("config router ospf no network 1.2.3.0/24 area 0", ctxFor(state, r1));
    expect(res.output.some((o) => o.kind === "error")).toBe(false);
  });

  it("area type (stub) is stored and shown", () => {
    const state = build();
    const r1 = state.devices.r1;
    execute("config router ospf area 19 stub", ctxFor(state, r1));
    expect(peekFeatureState<OspfState>(r1, "ospf")?.areas).toEqual([{ id: "0.0.0.19", type: "stub" }]);
    const t = text(execute("show ip ospf", ctxFor(state, r1)));
    expect(t).toContain("Area ID: 0.0.0.19 [stub]");
  });

  it("neighbor and route views render placeholders (no fabricated adjacency)", () => {
    const state = build();
    const r1 = state.devices.r1;
    execute("config router ospf router-id 1.1.1.1", ctxFor(state, r1));
    execute("config router ospf network 150.150.100.0/24 area 0", ctxFor(state, r1));

    // Not converged yet → no fabricated adjacency/routes (real packet-plane now
    // populates these only after `ospf converge`).
    const nbr = text(execute("show ip ospf neighbor", ctxFor(state, r1)));
    expect(nbr).toContain("No OSPF neighbors found.");
    expect(nbr).toContain("ospf converge");

    const route = text(execute("show ip ospf route", ctxFor(state, r1)));
    expect(route).toContain("OSPF network routing table");
    expect(route).toContain("no OSPF routes");
  });

  it("regression: show ip route / show ip arp are NOT shadowed by ip ospf", () => {
    const state = build();
    const r1 = state.devices.r1;
    // Make sure `show ip ospf route` really is the OSPF handler...
    expect(text(execute("show ip ospf route", ctxFor(state, r1)))).toContain("OSPF network routing table");

    // ...while the reserved sibling paths resolve to their own handlers.
    const rt = execute("show ip route", ctxFor(state, r1));
    expect(rt.output.some((o) => o.kind === "error" && o.text.includes("unknown command"))).toBe(false);
    expect(text(rt)).not.toContain("OSPF network routing table");

    const arp = execute("show ip arp", ctxFor(state, r1));
    expect(arp.output.some((o) => o.kind === "error" && o.text.includes("unknown command"))).toBe(false);
    expect(text(arp)).not.toContain("OSPF network routing table");
    expect(text(arp)).not.toContain("No OSPF neighbors");
  });
});
