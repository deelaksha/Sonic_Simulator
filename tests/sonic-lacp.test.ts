import { describe, it, expect } from "vitest";
import { createDevice, resetMacCounter } from "../lib/models/factory";
import { NetworkState } from "../lib/models/topology";
import { Simulation, SimEvent, CaptureRecord, resetIds } from "../lib/engine";
import { execute, CommandContext } from "../lib/commands";
import { Device } from "../lib/models/device";
import { peekFeatureState } from "../lib/models/feature-state";

interface LacpState {
  portchannels: { name: string; members: string[]; minLinks?: number; fallback?: boolean; mode?: string }[];
}

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

describe("SONiC LACP / PortChannel feature (config-plane)", () => {
  it("config portchannel add creates the LAG in switch state (sudo passthrough)", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config portchannel add PortChannel10", ctxFor(state, sw));
    execute("sudo config portchannel add PortChannel20", ctxFor(state, sw));
    const st = peekFeatureState<LacpState>(sw, "lacp")!;
    expect(st.portchannels.map((p) => p.name).sort()).toEqual(["PortChannel10", "PortChannel20"]);
    expect(st.portchannels[0].mode).toBe("LACP");
  });

  it("--min-links and --fallback are stored and rendered", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config portchannel add PortChannel10 --min-links 2 --fallback enable", ctxFor(state, sw));
    const st = peekFeatureState<LacpState>(sw, "lacp")!;
    expect(st.portchannels[0].minLinks).toBe(2);
    expect(st.portchannels[0].fallback).toBe(true);
    const out = text(execute("show portchannel summary", ctxFor(state, sw)));
    expect(out).toContain("PortChannel10");
    expect(out).toContain("LACP");
    expect(out).toContain("enabled");
    expect(out).toContain("2");
  });

  it("member add/del validates interface and show reflects membership", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config portchannel add PortChannel10", ctxFor(state, sw));
    execute("config portchannel member add PortChannel10 Ethernet0", ctxFor(state, sw));
    execute("config portchannel member add PortChannel10 Ethernet1", ctxFor(state, sw));

    let out = text(execute("show portchannel", ctxFor(state, sw)));
    expect(out).toContain("PortChannel10");
    expect(out).toContain("Ethernet0");
    expect(out).toContain("Ethernet1");

    execute("config portchannel member del PortChannel10 Ethernet1", ctxFor(state, sw));
    out = text(execute("show portchannel summary", ctxFor(state, sw)));
    expect(out).toContain("Ethernet0");
    expect(out).not.toContain("Ethernet1");
    expect(peekFeatureState<LacpState>(sw, "lacp")!.portchannels[0].members).toEqual(["Ethernet0"]);
  });

  it("rejects a member interface that does not exist (interfaceByName)", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config portchannel add PortChannel10", ctxFor(state, sw));
    const res = execute("config portchannel member add PortChannel10 Ethernet99", ctxFor(state, sw));
    expect(res.output.some((o) => o.kind === "error")).toBe(true);
    expect(peekFeatureState<LacpState>(sw, "lacp")!.portchannels[0].members).toHaveLength(0);
  });

  it("rejects an interface already a member of another PortChannel", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config portchannel add PortChannel10", ctxFor(state, sw));
    execute("config portchannel add PortChannel20", ctxFor(state, sw));
    execute("config portchannel member add PortChannel10 Ethernet0", ctxFor(state, sw));
    const res = execute("config portchannel member add PortChannel20 Ethernet0", ctxFor(state, sw));
    expect(res.output.some((o) => o.kind === "error")).toBe(true);
  });

  it("rejects an out-of-range LAG id (256 max, TC-40)", () => {
    const state = build();
    const sw = state.devices.sw1;
    const res = execute("config portchannel add PortChannel999", ctxFor(state, sw));
    expect(res.output.some((o) => o.kind === "error")).toBe(true);
    expect(peekFeatureState<LacpState>(sw, "lacp")?.portchannels ?? []).toHaveLength(0);
  });

  it("rejects out-of-range min-links (0 and 1025, TC-38/TC-39)", () => {
    const state = build();
    const sw = state.devices.sw1;
    expect(execute("config portchannel add PortChannel10 --min-links 0", ctxFor(state, sw)).output.some((o) => o.kind === "error")).toBe(true);
    expect(execute("config portchannel add PortChannel11 --min-links 1025", ctxFor(state, sw)).output.some((o) => o.kind === "error")).toBe(true);
    expect(peekFeatureState<LacpState>(sw, "lacp")?.portchannels ?? []).toHaveLength(0);
  });

  it("accepts min-links boundary 1024 (TC-37)", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config portchannel add PortChannel50 --min-links 1024", ctxFor(state, sw));
    expect(peekFeatureState<LacpState>(sw, "lacp")!.portchannels[0].minLinks).toBe(1024);
  });

  it("rejects an invalid --fallback value", () => {
    const state = build();
    const sw = state.devices.sw1;
    const res = execute("config portchannel add PortChannel10 --fallback maybe", ctxFor(state, sw));
    expect(res.output.some((o) => o.kind === "error")).toBe(true);
    expect(peekFeatureState<LacpState>(sw, "lacp")?.portchannels ?? []).toHaveLength(0);
  });

  it("rejects a duplicate PortChannel add", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config portchannel add PortChannel10", ctxFor(state, sw));
    const res = execute("config portchannel add PortChannel10", ctxFor(state, sw));
    expect(res.output.some((o) => o.kind === "error")).toBe(true);
    expect(peekFeatureState<LacpState>(sw, "lacp")!.portchannels).toHaveLength(1);
  });

  it("config portchannel del removes the LAG; empty summary prints SONiC no-LAG message (TC-30)", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config portchannel add PortChannel10", ctxFor(state, sw));
    execute("config portchannel del PortChannel10", ctxFor(state, sw));
    expect(peekFeatureState<LacpState>(sw, "lacp")!.portchannels).toHaveLength(0);
    expect(text(execute("show portchannel summary", ctxFor(state, sw)))).toContain("No PortChannels configured");
  });

  it("does not fabricate LACP negotiated state: an un-negotiated member is deselected/not synced", () => {
    // LACP now runs in lib/protocols/lacp-daemon.ts; without a partner (no daemon tick
    // here) the member must show D* (teamshow: deselected, not synced), never S.
    const state = build();
    const sw = state.devices.sw1;
    execute("config portchannel add PortChannel10", ctxFor(state, sw));
    execute("config portchannel member add PortChannel10 Ethernet0", ctxFor(state, sw));
    const out = text(execute("show portchannel summary", ctxFor(state, sw)));
    expect(out).toContain("Ethernet0(D*)");
    expect(out).not.toContain("Ethernet0(S)");
  });

  it("config portchannel add creates the PortChannel interface (oper down) and del removes it", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config portchannel add PortChannel10 --fast-rate true", ctxFor(state, sw));
    const pc = sw.interfaces.find((i) => i.name === "PortChannel10");
    expect(pc?.logical).toBe(true);
    expect(pc?.operState).toBe("down");
    expect(peekFeatureState<LacpState>(sw, "lacp")!.portchannels[0]).toMatchObject({ fastRate: true });
    execute("config portchannel member add PortChannel10 Ethernet0", ctxFor(state, sw));
    // sonic-utilities config/main.py: members must be removed first.
    expect(text(execute("config portchannel del PortChannel10", ctxFor(state, sw)))).toContain("contains members");
    execute("config portchannel member del PortChannel10 Ethernet0", ctxFor(state, sw));
    execute("config portchannel del PortChannel10", ctxFor(state, sw));
    expect(sw.interfaces.some((i) => i.name === "PortChannel10")).toBe(false);
  });

  it("rejects a non-Ethernet member and an invalid --fast-rate", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config portchannel add PortChannel10", ctxFor(state, sw));
    expect(execute("config portchannel member add PortChannel10 PortChannel10", ctxFor(state, sw)).output.some((o) => o.kind === "error")).toBe(true);
    expect(execute("config portchannel add PortChannel11 --fast-rate maybe", ctxFor(state, sw)).output.some((o) => o.kind === "error")).toBe(true);
  });
});
