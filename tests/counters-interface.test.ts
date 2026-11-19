import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";
import { pollCounters, peekCounters } from "../lib/protocols/counters-daemon";
import { createDevice } from "../lib/models/factory";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(30_000_000);
  resetAll();
});
afterEach(() => vi.useRealTimers());

const HDR = /^\s+IFACE\s+STATE\s+RX_OK\s+RX_BPS\s+RX_UTIL\s+RX_ERR\s+RX_DRP\s+RX_OVR\s+TX_OK\s+TX_BPS\s+TX_UTIL\s+TX_ERR\s+TX_DRP\s+TX_OVR$/;

/** Cells of the portstat row for one port. */
function row(text: string, port: string): string[] {
  const l = text.split("\n").find((x) => x.trim().startsWith(port + " "))!;
  return l.trim().split(/\s{2,}/);
}

function ospf() {
  S().loadFeatureLab("ospf");
  advance(25_000);
  const s1 = byName("S1").id;
  S().execCommand(s1, "exit"); // Click shell
  return s1;
}

describe("show interfaces counters (portstat)", () => {
  it("renders the portstat layout and OK counters equal the interface model", () => {
    const s1 = ospf();
    S().execCommand(byName("H1").id, "ping -c 3 192.168.3.10");
    const text = out(S().execCommand(s1, "show interfaces counters"));
    const lines = text.split("\n");
    expect(lines[0]).toMatch(HDR);
    expect(lines[1]).toMatch(/^-+( {2}-+){13}$/);
    for (const i of byName("S1").interfaces.filter((x) => !x.management && !x.logical)) {
      const r = row(text, i.name);
      expect(r[0]).toBe(i.name);
      expect(r[1]).toBe(i.adminState === "down" ? "X" : i.operState === "up" ? "U" : "D");
      expect(Number(r[2])).toBe(i.statistics.rxFrames);
      expect(Number(r[8])).toBe(i.statistics.txFrames);
    }
    // the pings crossed S1 Ethernet2 (H1) → counters moved
    expect(Number(row(text, "Ethernet2")[2])).toBeGreaterThanOrEqual(3);
  });

  it("rates are N/A until two polls, then computed from the 1 s samples", () => {
    S().loadFeatureLab("ospf");
    const s1 = byName("S1").id;
    S().execCommand(s1, "exit");
    expect(row(out(S().execCommand(s1, "show interfaces counters")), "Ethernet0")[3]).toBe("N/A");
    advance(2_500);
    S().execCommand(byName("H1").id, "ping -c 3 192.168.3.10");
    advance(1_100);
    const r = row(out(S().execCommand(s1, "show interfaces counters rates")), "Ethernet2");
    expect(r[3]).toMatch(/^\d+\.\d\d (B|KB|MB)\/s$/);
    expect(parseFloat(r[3])).toBeGreaterThan(0);
    expect(r[4]).toMatch(/^\d+\.\d\d\/s$/);
    expect(r[5]).toMatch(/^\d+\.\d\d%$/);
  });

  it("port_rates.lua: first delta unsmoothed, then EMA with alpha 0.18", () => {
    const sw = createDevice({ id: "sw", type: "switch", name: "SW", x: 0, y: 0, ports: 2 });
    const st = sw.interfaces[0].statistics;
    pollCounters(sw, 0);
    expect(peekCounters(sw)!.ports.Ethernet0.rxBps).toBeUndefined();
    st.rxBytes += 1000;
    st.rxFrames += 10;
    pollCounters(sw, 1000);
    expect(peekCounters(sw)!.ports.Ethernet0.rxBps).toBe(1000);
    expect(peekCounters(sw)!.ports.Ethernet0.rxPps).toBe(10);
    pollCounters(sw, 2000); // idle second
    expect(peekCounters(sw)!.ports.Ethernet0.rxBps).toBeCloseTo(820);
  });

  it("sonic-clear counters snapshots: later shows display deltas since the clear", () => {
    const s1 = ospf();
    S().execCommand(byName("H1").id, "ping -c 2 192.168.3.10");
    expect(out(S().execCommand(s1, "sonic-clear counters"))).toBe("Cleared counters");
    let text = out(S().execCommand(s1, "show interfaces counters"));
    expect(text.split("\n")[0]).toMatch(/^Last cached time was \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}$/);
    expect(row(text, "Ethernet2")[2]).toBe("0");
    const before = byName("S1").interfaces.find((i) => i.name === "Ethernet2")!.statistics.rxFrames;
    S().execCommand(byName("H1").id, "ping -c 2 192.168.3.10");
    const after = byName("S1").interfaces.find((i) => i.name === "Ethernet2")!.statistics.rxFrames;
    text = out(S().execCommand(s1, "show interfaces counters"));
    expect(Number(row(text, "Ethernet2")[2])).toBe(after - before);
    expect(out(S().execCommand(s1, "show interfaces counters detailed Ethernet2"))).toMatch(/Time Since Counters Last Cleared\.+ \d{4}-/);
  });

  it("detailed / errors / -a / -i / -p views", () => {
    const s1 = ospf();
    S().execCommand(byName("H1").id, "ping -c 2 192.168.3.10");
    const e2 = byName("S1").interfaces.find((i) => i.name === "Ethernet2")!;
    const det = out(S().execCommand(s1, "show interfaces counters detailed Ethernet2"));
    expect(det).toContain(`Total Packets Received Without Errors.......... ${e2.statistics.rxFrames}`);
    expect(det).toContain("Packets Received 64 Octets..................... N/A");
    expect(det.split("\n").pop()).toBe("Time Since Counters Last Cleared............... None");
    expect(out(S().execCommand(s1, "show interfaces counters errors")).split("\n")[0]).toMatch(/^\s+IFACE\s+STATE\s+RX_ERR\s+RX_DRP\s+RX_OVR\s+TX_ERR\s+TX_DRP\s+TX_OVR$/);
    const all = out(S().execCommand(s1, "show interfaces counters -a -i Ethernet1-2")).split("\n");
    expect(all[0]).toMatch(/RX_PPS.*TX_PPS.*TRIM$/);
    expect(all.slice(2).map((l) => l.trim().split(/\s+/)[0])).toEqual(["Ethernet1", "Ethernet2"]);
    advance(3_000);
    expect(out(S().execCommand(s1, "show interfaces counters -p 2"))).toMatch(/^The rates are calculated within 2 seconds period/);
  });

  it("KLISH show interface counters and clear counters share the portstat state", () => {
    S().loadFeatureLab("ospf");
    advance(25_000);
    const s1 = byName("S1").id; // KLISH by default
    S().execCommand(byName("H1").id, "ping -c 2 192.168.3.10");
    let text = out(S().execCommand(s1, "show interface counters"));
    expect(text.split("\n")[0]).toMatch(HDR);
    expect(Number(row(text, "Ethernet2")[2])).toBeGreaterThan(0);
    S().execCommand(s1, "clear counters interface all");
    text = out(S().execCommand(s1, "show interface counters"));
    expect(row(text, "Ethernet2")[2]).toBe("0");
    expect(out(S().execCommand(s1, "show interface counters Ethernet 2")).split("\n")).toHaveLength(3);
    expect(out(S().execCommand(s1, "show interface counters rate"))).toMatch(/Interface\s+Rate interval\s+RX_MBPS/);
  });
});
