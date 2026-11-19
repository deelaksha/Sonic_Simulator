/**
 * UDLD (RFC 5171) between SW1 Ethernet5 and SW2 Ethernet5 on the l2-protect
 * lab, with err-disable + recovery (SW1: errdisable recovery cause udld,
 * interval 30). A one-way link is simulated by a test-only data-plane hook that
 * drops SW1's UDLD PDUs on egress (SW1 → SW2 direction lost).
 */
import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "../lib/labs";
import { registerDataPlaneHook } from "../lib/control/hooks";
import { UDLD_MAC, decodeUdld, encodeUdld, peekUdld } from "../lib/protocols/udld-daemon";
import { isErrdisabled } from "../lib/protocols/errdisable";
import { peekSyslog } from "../lib/control/syslog";
import { normalizeMac } from "../lib/models/mac";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";

const id = (n: string) => byName(n).id;
const sh = (dev: string, cmd: string) => out(S().execCommand(id(dev), cmd));
const klish = (dev: string, lines: string[]) => S().runCliScript(id(dev), ["configure terminal", ...lines, "end"]);
const port = (dev: string, name: string) => byName(dev).interfaces.find((i) => i.name === name)!;
const status = (dev: string) => peekUdld(byName(dev))?.ports.Ethernet5?.status;
const logs = (dev: string) => (peekSyslog(byName(dev))?.lines ?? []).map((l) => l.message).join("\n");

let oneWay = false;
registerDataPlaneHook({
  id: "test-oneway",
  portEgress: (_ctx, device, iface, frame) => !(oneWay && device.name === "SW1" && iface.name === "Ethernet5" && normalizeMac(frame.ethernet.dstMac) === UDLD_MAC),
});

beforeEach(() => {
  oneWay = false;
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
  S().loadFeatureLab("l2-protect");
});
afterEach(() => {
  oneWay = false;
  vi.useRealTimers();
});

describe("UDLD wire format", () => {
  it("PDU round-trips: LLC/SNAP 0x0111, ver 1, TLVs, IP-style checksum", () => {
    const b = encodeUdld({ op: 1, flags: 1, deviceId: "3c2c.992d.8201", portId: "Ethernet0", echo: [["3c2c.992d.8235", "Ethernet4"]], msgTime: 1, timeout: 3, name: "sonic", seq: 7 });
    expect(b.slice(0, 8)).toEqual([0xaa, 0xaa, 0x03, 0x00, 0x00, 0x0c, 0x01, 0x11]);
    expect(b[8]).toBe(0x21); // ver 1 | opcode 1 (Probe)
    const p = decodeUdld(b)!;
    expect(p).toMatchObject({ op: 1, deviceId: "3c2c.992d.8201", portId: "Ethernet0", echo: [["3c2c.992d.8235", "Ethernet4"]], msgTime: 1, timeout: 3, name: "sonic", seq: 7 });
    b[20] ^= 0xff;
    expect(decodeUdld(b)).toBeUndefined(); // bad checksum
  });
});

describe("UDLD neighbors", () => {
  it("both ends become Bidirectional; show udld neighbors / statistics; PDUs never bridged", () => {
    advance(3000);
    expect(status("SW1")).toBe("Bidirectional");
    expect(status("SW2")).toBe("Bidirectional");
    const o = sh("SW1", "show udld neighbors");
    expect(o.split("\n")[0]).toBe("Port           Device Name     Device ID         Port ID         Neighbor State");
    expect(o).toMatch(/^Ethernet5      SW2             [0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}    Ethernet5       Bidirectional$/m);
    expect(sh("SW1", "show udld statistics interface Ethernet5")).toMatch(/UDLD Interface statistics for Ethernet5\nFrames transmitted:\s+\d+\nFrames received:\s+\d+\nFrames with error:\s+0/);
    // UDLD frames reach no host (trapped to the CPU, not flooded into VLAN 10).
    expect(S().captures.some((c) => byName("Client").id === c.deviceId && normalizeMac(c.frame.ethernet.dstMac) === UDLD_MAC)).toBe(false);
  });

  it("tcpdump decodes UDLD probes", () => {
    advance(2000);
    S().execCommand(id("SW1"), "exit");
    S().execCommand(id("SW1"), "sudo tcpdump -i Ethernet5 -nn");
    advance(1100);
    S().stopLiveCapture(id("SW1"));
    const lines = (S().terminals[id("SW1")] ?? []).map((l) => l.text).join("\n");
    expect(lines).toMatch(/UDLDv1, Code Probe message \(1\), Flags \[RT\] \(0x01\), length \d+/);
  });
});

describe("unidirectional link → err-disable → recovery", () => {
  it("SW1 hears SW2 but is never echoed: Ethernet5 err-disabled (carrier down on both ends), recovered after 30 s", () => {
    oneWay = true;
    advance(5000);
    expect(isErrdisabled(byName("SW1"), "Ethernet5")).toBe(true);
    expect(status("SW1")).toBe("Unidirectional");
    expect(port("SW1", "Ethernet5").operState).toBe("down");
    expect(port("SW1", "Ethernet5").adminState).toBe("up");
    expect(port("SW2", "Ethernet5").operState).toBe("down");
    expect(sh("SW1", "show udld interface Ethernet5")).toMatch(/Status:\s+Unidirectional/);
    expect(logs("SW1")).toContain("udld error detected on Ethernet5, putting Ethernet5 in err-disable state");
    expect(sh("SW1", "show errdisable recovery")).toMatch(/udld\s+enabled/);

    oneWay = false; // the fibre is repaired
    advance(31_000);
    expect(isErrdisabled(byName("SW1"), "Ethernet5")).toBe(false);
    expect(port("SW2", "Ethernet5").operState).toBe("up");
    expect(logs("SW1")).toContain("Attempting to recover from udld err-disable state on Ethernet5");
    advance(3000);
    expect(status("SW1")).toBe("Bidirectional");
  });

  it("a link that breaks after being bidirectional is detected; without recovery the port stays down", () => {
    klish("SW1", ["no errdisable recovery cause udld"]);
    advance(3000);
    expect(status("SW1")).toBe("Bidirectional");
    oneWay = true;
    advance(6000);
    expect(isErrdisabled(byName("SW1"), "Ethernet5")).toBe(true);
    expect(status("SW2")).toBeUndefined(); // SW2's port lost carrier: UDLD state reset
    oneWay = false;
    advance(60_000);
    expect(isErrdisabled(byName("SW1"), "Ethernet5")).toBe(true);
    expect(port("SW1", "Ethernet5").operState).toBe("down");
  });

  it("aggressive mode: losing a bidirectional neighbour err-disables the port", () => {
    klish("SW2", ["udld aggressive"]);
    advance(3000);
    oneWay = true; // SW2 stops hearing SW1
    advance(4000);
    expect(isErrdisabled(byName("SW2"), "Ethernet5")).toBe(true);
    expect(sh("SW2", "show udld interface Ethernet5")).toMatch(/Mode:\s+Aggressive/);
  });
});
