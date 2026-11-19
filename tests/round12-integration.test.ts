/** Cross-agent wiring: command names reach their implementations; CPU-path drop causes. */
import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolveCommand } from "../lib/commands/registry";
import { iperf3Command } from "../lib/commands/iperf3";
import { hping3Command } from "../lib/commands/nettools";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(40_000_000);
  resetAll();
});
afterEach(() => vi.useRealTimers());

describe("round 12 integration", () => {
  it("iperf3 and hping3 resolve to the real implementations", () => {
    expect(resolveCommand("iperf3")).toBe(iperf3Command);
    expect(resolveCommand("hping3")).toBe(hping3Command);
  });

  it("qos lab: iperf3 -s / -c through the store reaches ~1G", () => {
    S().loadFeatureLab("qos");
    advance(3_000);
    out(S().execCommand(byName("H3").id, "iperf3 -s"));
    expect(out(S().execCommand(byName("H1").id, "iperf3 -c 192.168.3.10 -t 2"))).toMatch(/9\d\d Mbits\/sec.*receiver/);
  });

  it("ss -tan shows an nc listener", () => {
    S().loadFeatureLab("ospf");
    S().execCommand(byName("H3").id, "nc -l -k 7777");
    expect(out(S().execCommand(byName("H3").id, "ss -tan"))).toMatch(/LISTEN.*7777/);
  });

  it("disabled feature drops at the CPU are not counted as CoPP", () => {
    S().loadFeatureLab("ospf");
    advance(20_000);
    const s1 = byName("S1").id;
    S().execCommand(s1, "exit");
    S().execCommand(s1, "config feature state bgp disabled"); // OSPF lives in the bgp container
    advance(15_000);
    expect(S().events.concat(S().controlEvents).some((e) => /no listener \(feature bgp disabled\)/.test(e.message))).toBe(true);
  });
});
