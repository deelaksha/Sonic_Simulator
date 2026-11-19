/**
 * SPAN on the l2-protect lab: SW1 mirrors Client's port Ethernet0 to the
 * Analyzer (Ethernet4, isolated VLAN 999). Copies are visible in the
 * Analyzer's tcpdump; direction rx / tx / both selects what is copied
 * (mirrororch.cpp:817-818 ingress/egress mirror session).
 */
import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "../lib/labs";
import { resetAll } from "./helpers";
import { S, byName, out } from "./control-helpers";

const id = (n: string) => byName(n).id;
const sh = (dev: string, cmd: string) => out(S().execCommand(id(dev), cmd));
const klish = (dev: string, lines: string[]) => S().runCliScript(id(dev), ["configure terminal", ...lines, "end"]);
/** DHCP message types the Analyzer received as SPAN copies. */
const mirrored = () =>
  S()
    .captures.filter((c) => c.deviceId === id("Analyzer") && c.dir === "rx")
    .map((c) => c.frame.dhcp?.messageType ?? c.frame.meta.summary);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
  S().loadFeatureLab("l2-protect");
});
afterEach(() => vi.useRealTimers());

describe("SPAN", () => {
  it("direction both: the Analyzer's tcpdump shows the Client's whole DORA; show mirror-session is active", () => {
    expect(sh("SW1", "show mirror-session")).toContain("SPAN1     active    Ethernet4       Ethernet0       both");
    S().execCommand(id("Analyzer"), "tcpdump -i eth0 -nn");
    expect(sh("Client", "dhclient")).toContain("DHCPACK of 192.168.10.");
    S().stopLiveCapture(id("Analyzer"));
    const lines = (S().terminals[id("Analyzer")] ?? []).map((l) => l.text).join("\n");
    expect(lines).toMatch(/0\.0\.0\.0\.68 > 255\.255\.255\.255\.67/); // DISCOVER / REQUEST received on Ethernet0
    expect(lines).toMatch(/192\.168\.10\.1\.67 > 255\.255\.255\.255\.68/); // OFFER / ACK sent out of Ethernet0
    expect(mirrored()).toEqual(["discover", "offer", "request", "ack"]);
  });

  it("direction rx copies only frames received on the source port", () => {
    klish("SW1", ["mirror-session SPAN1", "destination Ethernet4 source Ethernet0 direction rx"]);
    sh("Client", "dhclient");
    expect(mirrored()).toEqual(["discover", "request"]);
  });

  it("direction tx copies only frames sent out of the source port", () => {
    klish("SW1", ["mirror-session SPAN1", "destination Ethernet4 source Ethernet0 direction tx"]);
    sh("Client", "dhclient");
    expect(mirrored()).toEqual(["offer", "ack"]);
  });

  it("no mirror-session stops the copies", () => {
    klish("SW1", ["no mirror-session SPAN1"]);
    sh("Client", "dhclient");
    expect(mirrored()).toEqual([]);
  });

  it("the Analyzer port is isolated: without a session it sees none of the Client's broadcasts", () => {
    klish("SW1", ["no mirror-session SPAN1"]);
    sh("Attacker", "arping -b -c 3 192.168.10.1");
    expect(S().captures.some((c) => c.deviceId === id("Analyzer"))).toBe(false);
  });
});

describe("Click config/show mirror_session (sonic-utilities)", () => {
  it("span add stores the session; show mirror_session prints both tables in tabulate layout", () => {
    S().execCommand(id("SW1"), "exit"); // KLISH → bash
    sh("SW1", "sudo config mirror_session remove SPAN1");
    expect(sh("SW1", "sudo config mirror_session span add M2 Ethernet4 Ethernet0 rx")).toBe("");
    const o = sh("SW1", "show mirror_session");
    expect(o).toBe(
      [
        "ERSPAN Sessions",
        "Name    Status    SRC IP    DST IP    GRE    DSCP    TTL    Queue    Policer    Monitor Port    SRC Port    Direction",
        "------  --------  --------  --------  -----  ------  -----  -------  ---------  --------------  ----------  -----------",
        "",
        "SPAN Sessions",
        "Name    Status    DST Port    SRC Port    Direction    Queue    Policer",
        "------  --------  ----------  ----------  -----------  -------  ---------",
        "M2      active    Ethernet4   Ethernet0   rx",
      ].join("\n"),
    );
    sh("Client", "dhclient");
    expect(mirrored()).toEqual(["discover", "request"]);
  });

  it("validation follows validate_mirror_session_config", () => {
    S().execCommand(id("SW1"), "exit");
    expect(sh("SW1", "sudo config mirror_session span add SPAN1 Ethernet4")).toBe("Error: SPAN1 already exists");
    expect(sh("SW1", "sudo config mirror_session span add X Ethernet6")).toBe("Error: Destination Interface Ethernet6 is a L3 interface");
    expect(sh("SW1", "sudo config mirror_session span add X Ethernet4 Ethernet4")).toBe("Error: Destination Interface cant be same as Source Interface");
    expect(sh("SW1", "sudo config mirror_session span add X Ethernet4 Ethernet0 sideways")).toBe("Error: Direction sideways is invalid");
    expect(sh("SW1", "sudo config mirror_session span add X Ethernet99")).toBe("Error: Destination Interface Ethernet99 is invalid");
  });

  it("an ERSPAN session without a route to its destination is inactive", () => {
    S().execCommand(id("SW1"), "exit");
    sh("SW1", "sudo config mirror_session erspan add E1 1.1.1.1 172.31.0.9 8 64");
    expect(sh("SW1", "show mirror_session E1")).toContain("E1      inactive  1.1.1.1   172.31.0.9");
  });
});
