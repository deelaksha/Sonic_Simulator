/** iperf3 output/argument handling and the queuestat / pfcstat / watermarkstat show layouts. */
import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";
import { iperf, sw } from "./qos-helpers";
import { tabulate } from "../lib/commands/sonic/qos-rate";
import { useLabStore } from "../lib/store/lab-store";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(50_000_000);
  resetAll();
  S().loadFeatureLab("qos");
});
afterEach(() => vi.useRealTimers());

const H1 = () => byName("H1").id;
const S1 = () => byName("S1").id;

describe("iperf3 client/server", () => {
  it("needs a listening server", () => {
    expect(iperf(H1(), "iperf3 -c 192.168.3.10")).toMatch(/unable to connect to server.*Connection refused/);
    expect(iperf(byName("H3").id, "iperf3 -s")).toContain("Server listening on 5201 (test #1)");
    expect(iperf(H1(), "iperf3 -c 192.168.3.10 -p 5202")).toMatch(/Connection refused/);
    expect(iperf(H1(), "iperf3 -c 192.168.9.9")).toMatch(/Connection refused/);
  });

  it("TCP report has iperf3 headers, interval lines, sender/receiver summary", () => {
    iperf(byName("H3").id, "iperf3 -s");
    const lines = iperf(H1(), "iperf3 -c 192.168.3.10 -t 2").split("\n");
    expect(lines[0]).toBe("Connecting to host 192.168.3.10, port 5201");
    expect(lines[1]).toMatch(/^\[  5\] local 192\.168\.1\.10 port \d+ connected to 192\.168\.3\.10 port 5201$/);
    expect(lines[2]).toBe("[ ID] Interval           Transfer     Bitrate         Retr");
    expect(lines[3]).toBe("[  5]   0.00-1.00   sec   112 MBytes   941 Mbits/sec    0");
    expect(lines[5]).toBe("- - - - - - - - - - - - - - - - - - - - - - - - -");
    expect(lines[6]).toBe("[ ID] Interval           Transfer     Bitrate         Retr");
    expect(lines[7]).toBe("[  5]   0.00-2.00   sec   224 MBytes   941 Mbits/sec    0             sender");
    expect(lines[8]).toBe("[  5]   0.00-2.00   sec   224 MBytes   941 Mbits/sec                  receiver");
    expect(lines).toContain("iperf Done.");
  });

  it("UDP defaults to 1 Mbit/s and reports Lost/Total datagrams", () => {
    iperf(byName("H3").id, "iperf3 -s");
    const r = iperf(H1(), "iperf3 -c 192.168.3.10 -u -t 1");
    expect(r).toContain("[ ID] Interval           Transfer     Bitrate         Total Datagrams");
    expect(r).toContain("[ ID] Interval           Transfer     Bitrate         Jitter    Lost/Total Datagrams");
    expect(r).toMatch(/\[  5\]   0\.00-1\.00   sec   123 KBytes  1\.00 Mbits\/sec  0\.000 ms  0\/86 \(0%\)  sender/);
    expect(r).toMatch(/0\/86 \(0%\)  receiver/);
  });

  it("-P runs parallel streams with ids 5,7 and [SUM] lines that share the link", () => {
    iperf(byName("H3").id, "iperf3 -s");
    const r = iperf(H1(), "iperf3 -c 192.168.3.10 -P 2 -t 1");
    expect(r).toMatch(/\[  7\] local/);
    expect(r).toMatch(/\[  5\]   0\.00-1\.00   sec  56\.1 MBytes   471 Mbits\/sec/);
    expect(r).toMatch(/\[SUM\]   0\.00-1\.00   sec   112 MBytes   941 Mbits\/sec\s+0\s+sender/);
  });

  it("rejects bad options and non-host devices", () => {
    expect(iperf(H1(), "iperf3 -c 192.168.3.10 -x")).toMatch(/unrecognized option '-x'/);
    expect(iperf(H1(), "iperf3")).toMatch(/must either be a client \(-c\) or server \(-s\)/);
    expect(iperf(H1(), "iperf3 -c 192.168.3.10 -S 300")).toMatch(/bad TOS/);
    expect(iperf(S1(), "iperf3 -s")).toMatch(/command not found/);
  });
});

describe("show queue counters / watermark / pfc counters", () => {
  it("tabulate matches python-tabulate 'simple' right-aligned output", () => {
    const t = tabulate([["Ethernet0", "UC0", 41, 96, 70, 98]], ["Port", "TxQ", "Counter/pkts", "Counter/bytes", "Drop/pkts", "Drop/bytes"]);
    expect(t.map((l) => l.text)).toEqual([
      "     Port  TxQ  Counter/pkts  Counter/bytes  Drop/pkts  Drop/bytes",
      "---------  ---  ------------  -------------  ---------  ----------",
      "Ethernet0  UC0            41             96         70          98",
    ]);
  });

  it("queue counters: one block per port, UC0-7 + MC8-15, counts from the model", () => {
    iperf(byName("H3").id, "iperf3 -s");
    iperf(H1(), "iperf3 -c 192.168.3.10 -u -b 100M -S 184 -t 1");
    advance(1500);
    const lines = sw(S1(), "show queue counters Ethernet2").split("\n");
    expect(lines[0]).toBe("For namespace :");
    expect(lines[1]).toBe("     Port   TxQ  Counter/pkts  Counter/bytes  Drop/pkts  Drop/bytes");
    expect(lines[2]).toBe("---------  ----  ------------  -------------  ---------  ----------");
    expect(lines.slice(3, 19).map((l) => l.trim().split(/\s+/)[1])).toEqual([...Array(8)].map((_, i) => `UC${i}`).concat([...Array(8)].map((_, i) => `MC${i + 8}`)));
    // 100 Mbit/s of 1460 B payload = 8561.6 datagrams in 1 s, 1506 B frames.
    expect(lines[8]).toBe("Ethernet2   UC5          8561       12892866          0           0");
    const all = sw(S1(), "show queue counters");
    expect(all.match(/For namespace :/g)).toHaveLength(4);
    expect(sw(S1(), "show queue counters Ethernet9")).toBe("Port doesn't exist! Ethernet9");
  });

  it("CPU queues render features[\"cpu-queues\"]", () => {
    const s1 = byName("S1");
    const draft = structuredClone(S().network);
    (draft.devices[s1.id].config.features ??= {})["cpu-queues"] = { "4": { pkts: 7, bytes: 640, dropPkts: 1, dropBytes: 64 } };
    useLabStore.setState({ network: draft });
    const r = sw(S1(), "show queue counters CPU");
    expect(r).toMatch(/CPU\s+MC4\s+7\s+640\s+1\s+64/);
    expect(r).toMatch(/CPU\s+MC0\s+0\s+0\s+0\s+0/);
  });

  it("watermark and pfc counter layouts (watermarkstat / pfcstat)", () => {
    const wm = sw(S1(), "show queue watermark unicast").split("\n");
    expect(wm[0]).toBe("Egress shared pool occupancy per unicast queue:");
    expect(wm[1]).toBe("     Port  UC0  UC1  UC2  UC3  UC4  UC5  UC6  UC7");
    const pfc = sw(S1(), "show pfc counters").split("\n");
    expect(pfc[0]).toBe("  Port Rx  PFC0  PFC1  PFC2  PFC3  PFC4  PFC5  PFC6  PFC7");
    expect(pfc[1]).toBe("---------  ----  ----  ----  ----  ----  ----  ----  ----");
    expect(pfc).toContain("  Port Tx  PFC0  PFC1  PFC2  PFC3  PFC4  PFC5  PFC6  PFC7");
  });

  it("works from the KLISH prompt too (Click fallback) and binds WRED in show qos interface", () => {
    sw(S1(), "config qos interface bind Ethernet2 wred-policy LAB-WRED");
    expect(sw(S1(), "show qos interface Ethernet2")).toContain("wred-policy: LAB-WRED");
    expect(sw(S1(), "config qos wred-policy del LAB-WRED")).toMatch(/in use by Ethernet2/);
    sw(S1(), "sonic-cli");
    expect(out(S().execCommand(S1(), "show queue counters Ethernet2"))).toContain("For namespace :");
  });
});
