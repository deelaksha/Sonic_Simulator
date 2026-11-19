/**
 * lldpd organisational TLVs (802.1 PVID / VLAN name, 802.3 link aggregation +
 * MAC/PHY, LLDP-MED network policy), their lldpctl detail lines, the Scapy
 * decode, and `config feature state lldp disabled|enabled`.
 */
import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { ScapyEngine } from "../lib/packetgen/engine";
import { frameToBytes } from "../lib/sflow/wire";
import { nodePacketEngine } from "./packet-engine-node";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";
import { lldpRuntime, parseLldpdu } from "../lib/protocols/lldp-daemon";

const run = (dev: string, cmd: string) => out(S().execCommand(byName(dev).id, cmd));
const bash = (dev: string, cmd: string) => {
  S().execCommand(byName(dev).id, "exit");
  return run(dev, cmd);
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  resetAll();
});
afterEach(() => vi.useRealTimers());

describe("LLDP org TLVs on the VRRP lab (ACC Ethernet1 ↔ S1 Ethernet0, access VLAN 10, 1G)", () => {
  beforeEach(() => {
    S().loadFeatureLab("vrrp");
    advance(7000);
  });

  it("S1 learns ACC's 802.1 PVID / VLAN name and 802.3 MAC/PHY; lldpctl prints them", () => {
    const nb = lldpRuntime(byName("S1"))!.neighbors.Ethernet0[0];
    expect(nb.sysName).toBe("ACC");
    expect(nb.pvid).toBe(10);
    expect(nb.vlans).toEqual([{ vid: 10, name: "vlan10" }]);
    expect(nb.aggStatus).toBe(1);
    expect(nb.macphy).toEqual({ autonegSupport: false, autonegEnabled: false, advertised: 0, mau: 30 });
    expect(nb.mfs).toBeUndefined(); // lldpd 1.0.16 never advertises MFS
    const text = bash("S1", "show lldp neighbors Ethernet0");
    expect(text).toContain("    PMD autoneg:  supported: no, enabled: no\n      MAU oper type: 1000BaseTFD - Four-pair Category 5 UTP, full duplex mode");
    expect(text).toContain("\n  VLAN:         10, pvid: yes vlan10\n");
    expect(text).not.toContain("MFS:");
  });

  it("network-policy profile bound on ACC Ethernet1 → LLDP-MED capabilities + policy on S1", () => {
    S().runCliScript(byName("ACC").id, [
      "configure terminal",
      "network-policy profile 1", "voice vlan 100 cos 5 dscp 46", "voice-signaling vlan 100 cos 3 dscp 24", "exit",
      "interface Ethernet 1", "network-policy 1",
      "end",
    ]);
    advance(31_000);
    const nb = lldpRuntime(byName("S1"))!.neighbors.Ethernet0[0];
    expect(nb.medType).toBe(4);
    expect(nb.medPolicies).toEqual([
      { type: 1, unknown: false, tagged: true, vid: 100, priority: 5, dscp: 46 },
      { type: 2, unknown: false, tagged: true, vid: 100, priority: 3, dscp: 24 },
    ]);
    const text = bash("S1", "show lldp neighbors Ethernet0");
    expect(text).toContain(
      [
        "  LLDP-MED:     ",
        "    Device Type:  Network Connectivity Device",
        "    Capability:   Capabilities, yes",
        "    Capability:   Policy, yes",
        "    LLDP-MED Network Policy for: Voice, Defined: yes",
        "      VLAN:         100",
        "      Priority:     Voice",
        "      PCP:          5",
        "      DSCP Value:   46",
        "    LLDP-MED Network Policy for: Voice Signaling, Defined: yes",
      ].join("\n"),
    );
  });

  it("config feature state lldp disabled: shutdown LLDPDU, runtime cleared, no TX; enabled again relearns", () => {
    expect(lldpRuntime(byName("ACC"))!.neighbors.Ethernet1?.[0].sysName).toBe("S1");
    bash("S1", "sudo config feature state lldp disabled");
    advance(200);
    expect(lldpRuntime(byName("S1"))).toBeUndefined();
    // ACC got S1's TTL-0 LLDPDU and dropped the neighbour at once (lldpd.c:666).
    expect(lldpRuntime(byName("ACC"))!.neighbors.Ethernet1).toBeUndefined();
    const before = S().captures.filter((c) => c.deviceId === byName("S1").id && c.dir === "tx" && c.frame.ethernet.typeCode === 0x88cc).length;
    advance(61_000);
    const after = S().captures.filter((c) => c.deviceId === byName("S1").id && c.dir === "tx" && c.frame.ethernet.typeCode === 0x88cc).length;
    expect(after).toBe(before);
    expect(lldpRuntime(byName("S1"))).toBeUndefined(); // received LLDPDUs are ignored too
    run("S1", "sudo config feature state lldp enabled");
    advance(31_000); // S1 sends after its 5 s pause; it hears ACC at ACC's next 30 s interval
    expect(lldpRuntime(byName("S1"))!.neighbors.Ethernet0[0].sysName).toBe("ACC");
    expect(lldpRuntime(byName("ACC"))!.neighbors.Ethernet1[0].sysName).toBe("S1");
  });
});

describe("LLDP 802.3 link aggregation on LAG members", () => {
  it("a PortChannel member advertises status 3 + the PortChannel ifindex", () => {
    S().loadFeatureLab("lacp");
    advance(8000);
    const rt = Object.values(S().network.devices)
      .map((d) => lldpRuntime(d))
      .flatMap((r) => Object.values(r?.neighbors ?? {}).flat());
    const agg = rt.filter((n) => n.aggStatus === 3);
    expect(agg.length).toBeGreaterThan(0);
    expect(agg[0].aggId).toBeGreaterThan(0);
  });
});

describe("Scapy decodes the org TLVs (scapy.contrib.lldp)", () => {
  let engine: ScapyEngine;
  beforeAll(async () => {
    engine = await nodePacketEngine();
  }, 120_000);

  it("LLDPDU from ACC carries the 802.1/802.3 organisation-specific TLVs", async () => {
    S().loadFeatureLab("vrrp");
    advance(7000);
    const acc = byName("ACC");
    const cap = S().captures.find(
      (c) => c.deviceId === acc.id && c.dir === "tx" && c.frame.ethernet.typeCode === 0x88cc && parseLldpdu(c.frame.rawL3!)?.nb.pvid === 10,
    )!;
    expect(cap).toBeDefined();
    const d = await engine.dissect(frameToBytes(cap.frame));
    const orgs = d.layers.filter((l) => /Organi[sz]ation/i.test(l.proto));
    expect(orgs.length).toBeGreaterThanOrEqual(4);
    expect(d.show).toMatch(/org_code\s*=\s*(0x80c2|IEEE 802\.1|.*802\.1)/i);
    expect(d.show).toMatch(/org_code\s*=\s*(0x120f|IEEE 802\.3|.*802\.3)/i);
    expect(d.layers.map((l) => l.proto)).toContain("LLDPDUEndOfLLDPDU");
  }, 60_000);
});
