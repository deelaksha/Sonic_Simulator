import { describe, it, expect } from "vitest";
import { createDevice, resetMacCounter } from "../lib/models/factory";
import { NetworkState } from "../lib/models/topology";
import { Simulation, SimEvent, CaptureRecord, resetIds } from "../lib/engine";
import { execute, CommandContext } from "../lib/commands";
import { Device } from "../lib/models/device";
import { peekFeatureState } from "../lib/models/feature-state";

interface BfdPeer {
  peer: string;
  local?: string;
  interface?: string;
  multihop?: boolean;
  rxInterval?: number;
  txInterval?: number;
  multiplier?: number;
  shutdown?: boolean;
}
interface BfdState {
  peers: BfdPeer[];
}

function build(): NetworkState {
  resetMacCounter(1);
  resetIds();
  const r1 = createDevice({ id: "r1", type: "router", name: "R1", x: 0, y: 0, ports: 4 });
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

const peers = (d: Device) => peekFeatureState<BfdState>(d, "bfd")?.peers ?? [];
const textOf = (out: { text: string }[]) => out.map((o) => o.text).join("\n");
const isError = (res: { output: { kind?: string }[] }) => res.output.some((o) => o.kind === "error");

// `show bfd ...` renders FRR 10.3 bfdd_vty.c text (vtysh form) from the live
// sessions; expectations that quoted the old config-only rendering were moved
// to the source text (bfdd_vty.c line refs below).
describe("SONiC BFD feature (config + FRR show form)", () => {
  it("config bfd peer add creates a peer with bfd.txt defaults", () => {
    const state = build();
    const r1 = state.devices.r1;
    execute("config bfd peer add 10.10.10.1 interface Ethernet4", ctxFor(state, r1));
    expect(peers(r1).map((p) => p.peer)).toEqual(["10.10.10.1"]);

    const res = execute("show bfd peers", ctxFor(state, r1));
    const text = textOf(res.output);
    expect(text).toContain("peer 10.10.10.1 vrf default interface Ethernet4");
    // Defaults from bfd.txt TC-6: detect-multiplier 3, rx/tx 300ms.
    expect(text).toContain("Detect-multiplier: 3");
    expect(text).toContain("Receive interval: 300ms");
    expect(text).toContain("Transmission interval: 300ms");
  });

  it("intervals + multiplier setters are reflected by show", () => {
    const state = build();
    const r1 = state.devices.r1;
    execute("config bfd peer add 10.10.10.2 interface Ethernet8 local-address 10.0.0.1", ctxFor(state, r1));
    execute("config bfd peer transmit-interval 10.10.10.2 200", ctxFor(state, r1));
    execute("config bfd peer receive-interval 10.10.10.2 200", ctxFor(state, r1));
    execute("config bfd peer detect-multiplier 10.10.10.2 4", ctxFor(state, r1));

    const res = execute("show bfd peer 10.10.10.2", ctxFor(state, r1));
    const text = textOf(res.output);
    expect(text).toContain("peer 10.10.10.2 local-address 10.0.0.1 vrf default interface Ethernet8");
    expect(text).toContain("Detect-multiplier: 4");
    expect(text).toContain("Receive interval: 200ms");
    expect(text).toContain("Transmission interval: 200ms");
  });

  it("config bfd peer del removes the peer", () => {
    const state = build();
    const r1 = state.devices.r1;
    execute("config bfd peer add 10.10.10.1 interface Ethernet4", ctxFor(state, r1));
    execute("config bfd peer del 10.10.10.1", ctxFor(state, r1));
    expect(peers(r1).length).toBe(0);
    // bfdd_vty.c:508 prints only the header when there are no sessions.
    const res = execute("show bfd peers", ctxFor(state, r1));
    expect(textOf(res.output)).toBe("BFD Peers:");
  });

  it("rejects invalid / malformed peer IPs (bfd.txt TC-68..72)", () => {
    const state = build();
    const r1 = state.devices.r1;
    for (const bad of ["999.999.999.999", "256.1.1.1", "01.2.3.4", "10.0.0.2.5", "not.an.ip"]) {
      expect(isError(execute(`config bfd peer add ${bad} interface Ethernet4`, ctxFor(state, r1)))).toBe(true);
    }
    expect(peers(r1).length).toBe(0);
  });

  it("detect-multiplier enforces 2-128 (bfd.txt TC-49..53)", () => {
    const state = build();
    const r1 = state.devices.r1;
    execute("config bfd peer add 10.10.10.1 interface Ethernet4", ctxFor(state, r1));
    expect(isError(execute("config bfd peer detect-multiplier 10.10.10.1 0", ctxFor(state, r1)))).toBe(true);
    expect(isError(execute("config bfd peer detect-multiplier 10.10.10.1 1", ctxFor(state, r1)))).toBe(true);
    expect(isError(execute("config bfd peer detect-multiplier 10.10.10.1 129", ctxFor(state, r1)))).toBe(true);
    expect(isError(execute("config bfd peer detect-multiplier 10.10.10.1 4x", ctxFor(state, r1)))).toBe(true);
    expect(isError(execute("config bfd peer detect-multiplier 10.10.10.1 2", ctxFor(state, r1)))).toBe(false);
    expect(isError(execute("config bfd peer detect-multiplier 10.10.10.1 128", ctxFor(state, r1)))).toBe(false);
    expect(peers(r1)[0].multiplier).toBe(128);
  });

  it("intervals reject 0 and negatives (bfd.txt TC-58, TC-61, TC-77)", () => {
    const state = build();
    const r1 = state.devices.r1;
    execute("config bfd peer add 10.10.10.1 interface Ethernet4", ctxFor(state, r1));
    expect(isError(execute("config bfd peer receive-interval 10.10.10.1 0", ctxFor(state, r1)))).toBe(true);
    expect(isError(execute("config bfd peer transmit-interval 10.10.10.1 0", ctxFor(state, r1)))).toBe(true);
    expect(isError(execute("config bfd peer receive-interval 10.10.10.1 -1", ctxFor(state, r1)))).toBe(true);
    expect(isError(execute("config bfd peer receive-interval 10.10.10.1 600", ctxFor(state, r1)))).toBe(false);
  });

  it("a multihop peer requires a local-address (bfd.txt TC-88)", () => {
    const state = build();
    const r1 = state.devices.r1;
    expect(isError(execute("config bfd peer add 10.0.0.10 multihop", ctxFor(state, r1)))).toBe(true);
    expect(peers(r1).length).toBe(0);

    execute("config bfd peer add 192.168.50.50 multihop local-address 192.168.50.1", ctxFor(state, r1));
    const res = execute("show bfd peer 192.168.50.50", ctxFor(state, r1));
    // _display_peer_header (bfdd_vty.c:122-133): multihop precedes local-address; no interface.
    expect(textOf(res.output)).toContain("peer 192.168.50.50 multihop local-address 192.168.50.1 vrf default");
    expect(textOf(res.output)).toContain("Minimum TTL: 254");
  });

  it("setters on an unknown peer error out", () => {
    const state = build();
    const r1 = state.devices.r1;
    expect(isError(execute("config bfd peer detect-multiplier 9.9.9.9 3", ctxFor(state, r1)))).toBe(true);
  });

  it("shutdown / no-shutdown drive the session state (bfd.txt TC-17, TC-18)", () => {
    const state = build();
    const r1 = state.devices.r1;
    execute("config bfd peer add 10.10.10.1 interface Ethernet4", ctxFor(state, r1));
    execute("config bfd peer shutdown 10.10.10.1", ctxFor(state, r1));
    // bfdd_vty.c:172-173: an AdminDown session prints "Status: shutdown".
    expect(textOf(execute("show bfd peer 10.10.10.1", ctxFor(state, r1)).output)).toContain("Status: shutdown");
    execute("config bfd peer no-shutdown 10.10.10.1", ctxFor(state, r1));
    expect(textOf(execute("show bfd peer 10.10.10.1", ctxFor(state, r1)).output)).toContain("Status: down");
  });

  it("re-adding an existing peer updates in place (bfd.txt TC-110)", () => {
    const state = build();
    const r1 = state.devices.r1;
    execute("config bfd peer add 10.0.0.2 interface Ethernet4", ctxFor(state, r1));
    execute("config bfd peer add 10.0.0.2 interface Ethernet8", ctxFor(state, r1));
    expect(peers(r1).length).toBe(1);
    expect(peers(r1)[0].interface).toBe("Ethernet8");
  });

  it("a configured peer is a live session: Down with a discriminator until packets are exchanged", () => {
    const state = build();
    const r1 = state.devices.r1;
    execute("config bfd peer add 10.10.10.1 interface Ethernet4", ctxFor(state, r1));
    const text = textOf(execute("show bfd peers", ctxFor(state, r1)).output);
    expect(text).toMatch(/\t\tID: [1-9]\d*\n\t\tRemote ID: 0\n/);
    expect(text).toContain("\t\tStatus: down");
    expect(text).toContain("\t\tPeer Type: configured");
  });

  it("show bfd peer for an unknown IP reports not found (bfd.txt TC-47)", () => {
    const state = build();
    const r1 = state.devices.r1;
    const res = execute("show bfd peer 192.168.210.2", ctxFor(state, r1));
    // _find_peer_or_error (bfdd_vty.c:876-887).
    expect(textOf(res.output)).toBe("% Unable to find 'peer 192.168.210.2'");
  });
});
