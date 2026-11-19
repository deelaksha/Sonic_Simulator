/**
 * Storm control on the l2-protect lab: SW1 Ethernet3 (Attacker) has
 * `storm-control broadcast 100` (kbps). The policer (policerorch.cpp:199-268:
 * BYTES meter, CIR = kbps*1000/8, red = drop) passes broadcast below the rate
 * and drops the excess of a broadcast storm; drops are counted per port/type
 * and as STORM_CONTROL port drops.
 */
import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "../lib/labs";
import { peekStormState } from "../lib/protocols/storm-control";
import { peekDrops } from "../lib/control/drops";
import { resetAll } from "./helpers";
import { S, byName, out } from "./control-helpers";

const id = (n: string) => byName(n).id;
const sh = (dev: string, cmd: string) => out(S().execCommand(id(dev), cmd));
const klish = (dev: string, lines: string[]) => S().runCliScript(id(dev), ["configure terminal", ...lines, "end"]);
const port = (dev: string, name: string) => byName(dev).interfaces.find((i) => i.name === name)!;
const stormDrops = () => peekStormState(byName("SW1"))?.drops["Ethernet3|broadcast"] ?? 0;

/** Broadcast ARP request from the Attacker as raw bytes (60 B + FCS = 64 B on the wire). */
function arpBroadcast(): number[] {
  const mac = byName("Attacker").interfaces[0].mac.split(":").map((h) => parseInt(h, 16));
  const ip = (s: string) => s.split(".").map(Number);
  const b = [255, 255, 255, 255, 255, 255, ...mac, 0x08, 0x06, 0, 1, 0x08, 0, 6, 4, 0, 1, ...mac, ...ip("192.168.10.66"), 0, 0, 0, 0, 0, 0, ...ip("192.168.10.200")];
  while (b.length < 60) b.push(0);
  return b;
}

function storm(count: number, intervalMs: number, runMs: number): number {
  const before = port("SW1", "Ethernet3").statistics.rxFrames;
  S().startTraffic({ srcDeviceId: id("Attacker"), dstIp: "", protocol: "engine", srcPort: 0, dstPort: 0, size: 0, count, intervalMs, continuous: false, packet: { bytes: arpBroadcast(), summary: "ARP broadcast" } });
  vi.advanceTimersByTime(runMs);
  return port("SW1", "Ethernet3").statistics.rxFrames - before;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
  S().loadFeatureLab("l2-protect");
});
afterEach(() => {
  S().stopTraffic();
  vi.useRealTimers();
});

describe("storm-control broadcast", () => {
  it("broadcast below the rate passes untouched (10 pps x 64 B ≈ 5 kbps < 100 kbps)", () => {
    const rx = storm(30, 100, 3500);
    expect(rx).toBe(30);
    expect(stormDrops()).toBe(0);
  });

  it("a broadcast storm is policed to CIR: the excess is dropped and counted", () => {
    const rx = storm(4000, 0, 1000); // 200 frames every 50 ms ≈ 2 Mbps for one second
    expect(rx).toBe(4000);
    const passed = rx - stormDrops();
    // bucket depth max(CIR x 100 ms, 1522 B) + CIR (12500 B/s) over ~1 s, 64-byte frames
    expect(passed).toBeGreaterThan(150);
    expect(passed).toBeLessThanOrEqual(Math.ceil((1522 + 12500 * 1.05) / 64));
    expect(peekDrops(byName("SW1"))!["Ethernet3"].STORM_CONTROL).toBe(stormDrops());
    expect(port("SW1", "Ethernet3").statistics.rxDropped).toBe(stormDrops());
  });

  it("unicast is not metered by the broadcast policer; removing storm-control stops the drops", () => {
    expect(sh("Attacker", "ping -c 3 192.168.10.1")).toContain("3 received");
    klish("SW1", ["interface Ethernet 3", "no storm-control broadcast"]);
    storm(2000, 0, 500);
    expect(stormDrops()).toBe(0);
  });

  it("arping -b storm from the Attacker loses most replies at the policer", () => {
    const o = sh("Attacker", "arping -b -c 100 192.168.10.1");
    const got = Number(o.match(/Received (\d+) response/)![1]);
    expect(got).toBeLessThan(40);
    expect(stormDrops()).toBe(100 - got);
  });
});

describe("show storm-control", () => {
  it("KLISH show lists the PORT_STORM_CONTROL rows", () => {
    expect(sh("SW1", "show storm-control")).toBe(
      [
        "-----------------------------------------------------",
        "Interface Name      Storm-type          Rate (kbps)",
        "-----------------------------------------------------",
        "Ethernet3           broadcast           100",
      ].join("\n"),
    );
  });

  it("Click: config interface storm-control add/del and show storm-control (tabulate grid)", () => {
    S().execCommand(id("SW1"), "exit");
    expect(sh("SW1", "sudo config interface storm-control add Ethernet0 unknown-unicast 2000")).toBe("");
    expect(sh("SW1", "show storm-control")).toBe(
      [
        "+------------------+-----------------+---------------+",
        "| Interface Name   | Storm Type      |   Rate (kbps) |",
        "+==================+=================+===============+",
        "| Ethernet0        | unknown-unicast |          2000 |",
        "+------------------+-----------------+---------------+",
        "| Ethernet3        | broadcast       |           100 |",
        "+------------------+-----------------+---------------+",
      ].join("\n"),
    );
    expect(sh("SW1", "show storm-control interface Ethernet3")).toContain("| Ethernet3        | broadcast    |           100 |");
    expect(sh("SW1", "sudo config interface storm-control add PortChannel1 broadcast 10")).toContain("Storm-control is supported only on Ethernet interfaces");
    expect(sh("SW1", "sudo config interface storm-control del Ethernet0 unknown-unicast")).toBe("Error: Unable to delete unknown-unicast storm-control from interface Ethernet0");
    expect(sh("SW1", "show storm-control")).not.toContain("Ethernet0");
  });
});
