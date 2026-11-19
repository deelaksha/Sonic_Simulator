import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(30_000_000);
  resetAll();
});
afterEach(() => vi.useRealTimers());

function lab() {
  S().loadFeatureLab("lacp");
  advance(5_000);
  const s1 = byName("S1").id;
  S().execCommand(byName("H1").id, "ping -c 1 192.168.10.13");
  return s1;
}

describe("FDB aging", () => {
  it("dynamic entries age out after the aging time; static entries stay", () => {
    const s1 = lab();
    S().execCommand(s1, "exit");
    expect(out(S().execCommand(s1, "show mac aging-time"))).toBe("Aging time for switch is 600 seconds");
    expect(out(S().execCommand(s1, "config mac aging_time 20"))).toBe("");
    expect(out(S().execCommand(s1, "show mac aging-time"))).toBe("Aging time for switch is 20 seconds");
    S().execCommand(s1, "config mac add 10 00:AA:BB:CC:DD:EE Ethernet3");
    // pin a static entry with a timestamp too: `static` must win over age
    byName("S1").macTable.push({ mac: "00:AA:BB:CC:DD:EF", interfaceId: byName("S1").interfaces[3].id, vlan: 10, lastSeenMs: Date.now(), static: true });
    const dyn = () => byName("S1").macTable.filter((e) => !e.static && e.mac.startsWith("02:"));
    expect(dyn().length).toBeGreaterThan(0);
    const newest = Math.max(...dyn().map((e) => e.lastSeenMs!));
    advance(newest + 20_000 - Date.now() - 200);
    expect(dyn().length).toBeGreaterThan(0); // not yet
    advance(30_000);
    // hosts are idle (no refresh after ~10 s), so their entries are gone
    expect(dyn()).toHaveLength(0);
    const text = out(S().execCommand(s1, "show mac"));
    expect(text).toMatch(/10\s+00:AA:BB:CC:DD:EE\s+Ethernet3\s+Static/); // config mac add → static
    expect(text).toMatch(/10\s+00:AA:BB:CC:DD:EF\s+Ethernet3\s+Static/);
    expect(out(S().execCommand(s1, "show mac count"))).toBe("Total number of entries 2");
  });

  it("aging time 0 disables aging", () => {
    const s1 = lab();
    S().execCommand(s1, "exit");
    S().execCommand(s1, "config mac aging_time 0");
    const n = byName("S1").macTable.length;
    advance(700_000, 1000);
    expect(byName("S1").macTable.length).toBe(n);
    expect(out(S().execCommand(s1, "config mac aging_time 2000000"))).toMatch(/not in the range 0<=x<=1000000/);
  });

  it("KLISH mac address-table aging-time configures the same timer", () => {
    const s1 = lab();
    S().runCliScript(s1, ["configure terminal", "mac address-table aging-time 15", "end"]);
    expect(out(S().execCommand(s1, "show mac address-table aging-time"))).toBe("Aging-Time: 15 seconds");
    expect(out(S().execCommand(s1, "show running-configuration"))).toContain("mac address-table aging-time 15");
    advance(40_000);
    expect(byName("S1").macTable.filter((e) => !e.static)).toHaveLength(0);
    S().runCliScript(s1, ["configure terminal", "no mac address-table aging-time", "end"]);
    expect(out(S().execCommand(s1, "show mac address-table aging-time"))).toBe("Aging-Time: 600 seconds");
  });

  it("sonic-clear fdb all flushes dynamic entries only; show mac format and filters", () => {
    const s1 = lab();
    S().execCommand(s1, "exit");
    S().execCommand(s1, "config mac add 10 00:AA:BB:CC:DD:EE Ethernet3");
    byName("S1").macTable.find((e) => e.mac === "00:AA:BB:CC:DD:EE")!.static = true;
    const lines = out(S().execCommand(s1, "show mac")).split("\n");
    expect(lines[0]).toMatch(/^ {2}No\. {4}Vlan {2}MacAddress {9}Port +Type$/);
    expect(lines[2]).toMatch(/^ {4}1 {6}10 {2}[0-9A-F:]{17} {2}\S+/);
    expect(out(S().execCommand(s1, "show mac -t static"))).toMatch(/00:AA:BB:CC:DD:EE[\s\S]*Total number of entries 1$/);
    expect(out(S().execCommand(s1, "show mac -v 99"))).toMatch(/Total number of entries 0$/);
    expect(out(S().execCommand(s1, "sonic-clear fdb all"))).toBe("FDB entries are cleared.");
    expect(byName("S1").macTable.map((e) => e.mac)).toEqual(["00:AA:BB:CC:DD:EE"]);
  });
});
