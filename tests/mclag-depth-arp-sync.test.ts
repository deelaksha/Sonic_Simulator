/**
 * MCLAG ARP sync over ICCP (iccpd ARP Information TLV), mclagdctl dumps, the
 * Click `config mclag` surface, and `config feature state iccpd`.
 */
import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { registerLab } from "../lib/labs/registry";
import { buildMclagLab } from "../lib/labs/mclag-lab";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";
import { mclagRuntime } from "../lib/protocols/mclag-daemon";

registerLab("test-mclag-svi", (api) => {
  const t = buildMclagLab(api);
  api.runCliScript(t.p1, ["configure terminal", "interface Vlan 10", "ip address 192.168.10.1/24", "end"]);
  api.runCliScript(t.p2, ["configure terminal", "interface Vlan 10", "ip address 192.168.10.2/24", "end"]);
  api.finish("mclag + SVIs", t.p1);
});

const run = (dev: string, cmd: string) => out(S().execCommand(byName(dev).id, cmd));
let inBash = new Set<string>();
/** Run in the device's bash shell (switches start in KLISH: `exit` once). */
const bash = (dev: string, cmd: string) => {
  if (!inBash.has(dev)) S().execCommand(byName(dev).id, "exit");
  inBash.add(dev);
  return run(dev, cmd);
};
const arp = (dev: string, ip: string) => byName(dev).arpTable.find((e) => e.ip === ip);

beforeEach(() => {
  inBash = new Set();
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  resetAll();
});
afterEach(() => vi.useRealTimers());

describe("MCLAG ARP sync", () => {
  beforeEach(() => {
    S().loadFeatureLab("test-mclag-svi");
    advance(5000);
    expect(mclagRuntime(byName("P1"))?.session).toBe(true);
  });

  it("H1's ARP learned on P1's Vlan10 appears on P2 (same interface, H1's MAC); mclagdctl shows L / R", () => {
    const h1 = byName("H1");
    expect(arp("P2", "192.168.10.11")).toBeUndefined();
    expect(run("H1", "ping -c 1 192.168.10.1")).toMatch(/1 received/);
    expect(arp("P1", "192.168.10.11")?.mac.toUpperCase()).toBe(h1.interfaces[0].mac.toUpperCase());
    advance(200);
    const synced = arp("P2", "192.168.10.11");
    expect(synced?.mac.toUpperCase()).toBe(h1.interfaces[0].mac.toUpperCase());
    expect(byName("P2").interfaces.find((i) => i.id === synced!.interfaceId)!.name).toBe("Vlan10");
    // Own SVI addresses are never installed from the peer.
    expect(arp("P2", "192.168.10.2")).toBeUndefined();
    // ARP table on P2 (Click `show arp`).
    expect(bash("P2", "show arp")).toMatch(/192\.168\.10\.11\s+\S+\s+\S+\s+10\n/);
    const p1 = bash("P1", "mclagdctl dump arp -i 10");
    expect(p1.split("\n")[0]).toBe("No.   IP                  MAC                 DEV                 Flag");
    expect(p1).toMatch(new RegExp(`1     192\\.168\\.10\\.11\\s+${h1.interfaces[0].mac.toLowerCase()}   Vlan10\\s+L`));
    expect(bash("P2", "mclagdctl dump arp -i 10")).toMatch(/192\.168\.10\.11\s+\S+   Vlan10\s+R/);
    // ARP Information TLV (0x1036) went over the ICCP TCP session.
    const iccp = S().captures.filter((c) => c.deviceId === byName("P1").id && c.dir === "tx" && c.frame.tcp?.dstPort === 8888 && c.frame.rawL3);
    const hasArpTlv = iccp.some((c) => {
      const b = c.frame.rawL3!;
      for (let i = 0; i + 1 < b.length; i++) if (b[i] === 0x10 && b[i + 1] === 0x36) return true;
      return false;
    });
    expect(hasArpTlv).toBe(true);
  });

  it("deleting the entry on P1 withdraws it from P2; mclagdctl dump mac lists synced MACs", () => {
    run("H1", "ping -c 1 192.168.10.1");
    advance(200);
    expect(arp("P2", "192.168.10.11")).toBeDefined();
    bash("P1", "sudo ip neigh del 192.168.10.11 dev Vlan10");
    advance(200);
    expect(arp("P1", "192.168.10.11")).toBeUndefined();
    expect(arp("P2", "192.168.10.11")).toBeUndefined();
    const mac = bash("P2", "mclagdctl dump mac -i 10");
    expect(mac.split("\n")[1]).toBe("No.   TYPE MAC                 VID  DEV                 ORIGIN-DEV          AGE  ");
    expect(bash("P1", "mclagdctl dump state -i 10")).toContain("The MCLAG's keepalive is: OK\nMCLAG info sync is: completed\nDomain id: 10");
  });

  it("feature iccpd disabled: session down, nothing sent; mclagdctl cannot connect", () => {
    bash("P1", "sudo config feature state iccpd disabled");
    advance(300);
    expect(mclagRuntime(byName("P1"))).toBeUndefined();
    const sent = () => S().captures.filter((c) => c.deviceId === byName("P1").id && c.dir === "tx" && c.frame.tcp?.dstPort === 8888).length;
    const n = sent();
    advance(3000);
    expect(sent()).toBe(n);
    expect(bash("P1", "mclagdctl dump state -i 10")).toContain("Connection refused");
    bash("P1", "sudo config feature state iccpd enabled");
    advance(5000);
    expect(mclagRuntime(byName("P1"))?.session).toBe(true);
  });
});

describe("Click config mclag (sonic-utilities config/mclag.py)", () => {
  it("add/member/keepalive/session-timeout drive iccpd like the KLISH mode; del removes members", () => {
    S().loadFeatureLab("mclag");
    // Rebuild the domain on both peers through Click.
    for (const [p, src, peer] of [["P1", "10.0.0.1", "10.0.0.2"], ["P2", "10.0.0.2", "10.0.0.1"]]) {
      expect(bash(p, "sudo config mclag del 10")).toContain("MCLAG Domain delete takes care of deleting all associated MCLAG Interfaces");
      expect(run(p, "sudo config mclag add 20 " + src + " " + peer + " Ethernet1")).toBe("");
      expect(run(p, "sudo config mclag add 21 " + src + " " + peer)).toContain("only one mclag Domain can be configured. Already one domain 20 configured");
      expect(run(p, "sudo config mclag add 5000 " + src + " " + peer)).toContain("5000 invalid domain ID, valid range is 1 to 4095");
      expect(run(p, "sudo config mclag member add 20 PortChannel1")).toBe("");
      expect(run(p, "sudo config mclag keepalive-interval 20 10")).toContain("MCLAG Keepalive:10 Session_timeout:15 values not satisfying session_timeout >= (3 * KA)");
      expect(run(p, "sudo config mclag session-timeout 20 9")).toBe("");
      expect(run(p, "sudo config mclag keepalive-interval 20 3")).toBe("");
    }
    advance(6000);
    const rt = mclagRuntime(byName("P1"))!;
    expect(rt.domain).toBe("20");
    expect(rt.session).toBe(true);
    expect(rt.remoteIfs.PortChannel1).toBe("up");
    expect(bash("P1", "mclagdctl dump state -i 20")).toContain("Keepalive time: 3\nsesssion Timeout : 9");
    bash("P1", "sudo config mclag member del 20 PortChannel1");
    advance(200);
    expect(bash("P1", "mclagdctl dump state -i 20")).toContain("MCLAG Interface: \n");
  });
});
