/**
 * Static LAG (PORTCHANNEL static "true", teamd loadbalance runner): no LACPDUs,
 * members forward while their link is up; and `config feature state teamd`.
 */
import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { registerLab } from "../lib/labs/registry";
import { buildLacpLab } from "../lib/labs/lacp-lab";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";
import { lacpRuntime } from "../lib/protocols/lacp-daemon";

registerLab("test-static-lag", (api) => {
  const t = buildLacpLab(api);
  // Replace the LACP PortChannel1 by a static PortChannel5 on both switches.
  for (const s of [t.s1, t.s2]) {
    api.runCliScript(s, ["configure terminal", "interface Ethernet 0", "no channel-group", "exit", "interface Ethernet 1", "no channel-group", "exit", "no interface PortChannel 1", "end"]);
    api.exec(s, "exit"); // KLISH → bash
    api.exec(s, "sudo config portchannel add PortChannel5 --static true");
    api.exec(s, "sudo config portchannel member add PortChannel5 Ethernet0");
    api.exec(s, "sudo config portchannel member add PortChannel5 Ethernet1");
    api.runCliScript(s, ["configure terminal", "interface PortChannel 5", "switchport access Vlan 10", "end"]);
  }
  api.finish("static LAG test", t.s1);
});

const bash = (dev: string, cmd: string) => {
  S().execCommand(byName(dev).id, "exit");
  return out(S().execCommand(byName(dev).id, cmd));
};
const ping = (from: string, ip: string) => out(S().execCommand(byName(from).id, `ping -c 1 ${ip}`));
const lacpdus = () => S().captures.filter((c) => c.dir === "tx" && c.frame.ethernet.typeCode === 0x8809).length;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  resetAll();
  S().loadFeatureLab("test-static-lag");
  advance(3000);
});
afterEach(() => vi.useRealTimers());

describe("static PortChannel (no LACP)", () => {
  it("members are enabled on link up without any LACPDU; teamshow shows NONE(Up) and (S) members", () => {
    expect(lacpdus()).toBe(0);
    const s1 = byName("S1");
    expect(s1.interfaces.find((i) => i.name === "PortChannel5")!.operState).toBe("up");
    expect(Object.values(lacpRuntime(s1)!.lags.PortChannel5.ports).every((p) => p.enabled)).toBe(true);
    const t = bash("S1", "show interfaces portchannel");
    expect(t).toMatch(/5\s+PortChannel5\s+NONE\(Up\)\s+Ethernet0\(S\) Ethernet1\(S\)/);
    expect(ping("H1", "192.168.10.13")).toMatch(/1 received/);
    // KLISH summary marks the LAG STATIC.
    S().execCommand(s1.id, "sonic-cli");
    expect(out(S().execCommand(s1.id, "show PortChannel summary"))).toMatch(/PortChannel5\s+Eth \(U\)\s+STATIC\s+Ethernet0\(P\), Ethernet1\(P\)/);
  });

  it("a member with link down is deselected; the LAG stays up on the other member", () => {
    // Pull the Ethernet0 cable: both ends lose carrier (a static LAG has no other failure detection).
    const s1 = byName("S1");
    const e0 = s1.interfaces.find((i) => i.name === "Ethernet0")!;
    const conn = S().network.connections.find((c) => (c.a.deviceId === s1.id && c.a.interfaceId === e0.id) || (c.b.deviceId === s1.id && c.b.interfaceId === e0.id))!;
    S().disconnect(conn.id);
    advance(200);
    const t = bash("S1", "show interfaces portchannel");
    expect(t).toMatch(/NONE\(Up\)\s+Ethernet0\(D\) Ethernet1\(S\)/);
    expect(ping("H1", "192.168.10.13")).toMatch(/1 received/);
    expect(lacpdus()).toBe(0);
  });

  it("feature teamd disabled: PortChannel loses carrier and stops forwarding; enabled restores it", () => {
    bash("S1", "sudo config feature state teamd disabled");
    advance(200);
    const s1 = byName("S1");
    expect(lacpRuntime(s1)).toBeUndefined();
    expect(s1.interfaces.find((i) => i.name === "PortChannel5")!.operState).toBe("down");
    expect(ping("H1", "192.168.10.13")).toMatch(/0 received/);
    bash("S1", "sudo config feature state teamd enabled");
    advance(200);
    expect(byName("S1").interfaces.find((i) => i.name === "PortChannel5")!.operState).toBe("up");
    expect(ping("H1", "192.168.10.13")).toMatch(/1 received/);
  });
});

describe("feature teamd on an LACP LAG", () => {
  it("teamd exit sends a final LACPDU without Sync; the partner's member falls out", () => {
    S().loadFeatureLab("lacp");
    advance(4000);
    expect(byName("S2").interfaces.find((i) => i.name === "PortChannel1")!.operState).toBe("up");
    bash("S1", "sudo config feature state teamd disabled");
    advance(200);
    const p = lacpRuntime(byName("S2"))!.lags.PortChannel1.ports.Ethernet0;
    expect(p.enabled).toBe(false); // partner no longer in Sync
    advance(4000);
    expect(byName("S2").interfaces.find((i) => i.name === "PortChannel1")!.operState).toBe("down");
  });
});
