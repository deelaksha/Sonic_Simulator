/**
 * VRRP on plain routers (eth0/eth1 routed ports, acceptsVMac path in router.ts),
 * store-level on fake time. Replaces the old instant-election tests: real VRRP
 * (RFC 5798, FRR vrrpd) only fails over after Master_Down_Interval, so the
 * former "shut the master → re-elected immediately" assertions no longer hold.
 *
 *   PC1 10.0.0.10 ── SW1 ── R1 eth0 10.0.0.2 / R2 eth0 10.0.0.3   (vrid 1, VIP 10.0.0.1)
 *                           R1 eth1 10.9.9.2 / R2 eth1 10.9.9.3   (vrid 2, VIP 10.9.9.1) ── SW2 ── SRV 10.9.9.9
 */
import "../lib/commands/sonic-cli/features";
import "../lib/labs";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { registerLab } from "../lib/labs";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";
import { electMaster, runtimeOf } from "../lib/protocols/vrrp";

registerLab("vrrp-routers-test", (api) => {
  api.newLab();
  const pc1 = api.addDevice("pc", { x: 40, y: 180 });
  const sw1 = api.addDevice("switch", { x: 240, y: 180 }, 4);
  const r1 = api.addDevice("router", { x: 440, y: 90 }, 2);
  const r2 = api.addDevice("router", { x: 440, y: 270 }, 2);
  const sw2 = api.addDevice("switch", { x: 640, y: 180 }, 4);
  const srv = api.addDevice("server", { x: 840, y: 180 });
  [["PC1", pc1], ["SW1", sw1], ["R1", r1], ["R2", r2], ["SW2", sw2], ["SRV", srv]].forEach(([n, d]) => api.rename(d, n));
  api.setInterfaceIp(pc1, `${pc1}-if0`, "10.0.0.10", 24);
  api.setDefaultGateway(pc1, "10.0.0.1");
  api.setInterfaceIp(r1, `${r1}-if0`, "10.0.0.2", 24);
  api.setInterfaceIp(r1, `${r1}-if1`, "10.9.9.2", 24);
  api.setInterfaceIp(r2, `${r2}-if0`, "10.0.0.3", 24);
  api.setInterfaceIp(r2, `${r2}-if1`, "10.9.9.3", 24);
  api.setInterfaceIp(srv, `${srv}-if0`, "10.9.9.9", 24);
  api.setDefaultGateway(srv, "10.9.9.1");
  api.connect(pc1, `${pc1}-if0`, sw1, `${sw1}-if0`);
  api.connect(r1, `${r1}-if0`, sw1, `${sw1}-if1`);
  api.connect(r2, `${r2}-if0`, sw1, `${sw1}-if2`);
  api.connect(r1, `${r1}-if1`, sw2, `${sw2}-if0`);
  api.connect(r2, `${r2}-if1`, sw2, `${sw2}-if1`);
  api.connect(srv, `${srv}-if0`, sw2, `${sw2}-if2`);
  for (const [r, prio] of [[r1, 110], [r2, 100]] as const) {
    api.exec(r, "config interface vrrp ip add eth0 1 10.0.0.1");
    api.exec(r, "config interface vrrp ip add eth1 2 10.9.9.1");
    api.exec(r, `config interface vrrp priority eth0 1 ${prio}`);
    api.exec(r, `config interface vrrp priority eth1 2 ${prio}`);
  }
  api.finish("VRRP routers test", pc1);
});

const id = (n: string) => byName(n).id;
const role = (n: string, iface = "eth0", vrid = 1) => runtimeOf(byName(n), iface, vrid)?.state;
const ping = (n: string, ip: string) => out(S().execCommand(id(n), `ping -c 1 ${ip}`));
const downLan = (n: string) => {
  S().setAdminState(id(n), `${id(n)}-if0`, false);
  S().setAdminState(id(n), `${id(n)}-if1`, false);
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
  S().loadFeatureLab("vrrp-routers-test");
});
afterEach(() => vi.useRealTimers());

describe("VRRP on routers (fake time)", () => {
  it("no Master before Master_Down_Interval; then the highest priority is Master and answers the VIP", () => {
    advance(1000);
    expect(electMaster(S().network, "10.0.0.1")).toBeUndefined();
    expect(ping("PC1", "10.0.0.1")).toContain("0 received");
    advance(3000);
    expect(electMaster(S().network, "10.0.0.1")?.device.name).toBe("R1");
    expect(role("R2")).toBe("Backup");
    expect(ping("PC1", "10.0.0.1")).toContain("1 received");
    expect(ping("PC1", "10.9.9.9")).toContain("1 received"); // via the virtual gateways on both sides
  });

  it("FAILOVER: R1's interfaces go down → R2 takes over both VIPs after Master_Down_Interval; traffic continues", () => {
    advance(5000);
    expect(ping("PC1", "10.9.9.9")).toContain("1 received");
    downLan("R1");
    advance(2000);
    expect(role("R2")).toBe("Backup"); // still within 3.6 s
    advance(2000);
    expect(electMaster(S().network, "10.0.0.1")?.device.name).toBe("R2");
    expect(electMaster(S().network, "10.9.9.1")?.device.name).toBe("R2");
    expect(ping("PC1", "10.0.0.1")).toContain("1 received");
    expect(ping("PC1", "10.9.9.9")).toContain("1 received");
  });

  it("FAILBACK: restoring R1 preempts back to Master", () => {
    advance(5000);
    downLan("R1");
    advance(4000);
    expect(role("R2")).toBe("Master");
    S().setAdminState(id("R1"), `${id("R1")}-if0`, true);
    S().setAdminState(id("R1"), `${id("R1")}-if1`, true);
    advance(4000);
    expect(electMaster(S().network, "10.0.0.1")?.device.name).toBe("R1");
    expect(role("R2")).toBe("Backup");
    expect(ping("PC1", "10.9.9.9")).toContain("1 received");
  });

  it("address owner (VIP = interface address) runs at priority 255 and is Master at startup", () => {
    S().execCommand(id("R2"), "config interface vrrp ip add eth0 1 10.0.0.3");
    S().execCommand(id("R1"), "config interface vrrp ip add eth0 1 10.0.0.3");
    advance(200);
    expect(role("R2")).toBe("Master"); // vrrp_startup: owner → Master immediately
    advance(5000);
    expect(role("R1")).toBe("Backup"); // 255 beats 110
    expect(out(S().execCommand(id("R2"), "show vrrp interface eth0"))).toContain(" Effective Priority (v4)                 255");
  });

  it("`vrrp` reports live roles and a VRRP_FAILOVER event when the master changed", () => {
    advance(5000);
    expect(out(S().execCommand(id("R1"), "vrrp"))).toMatch(/VIP 10\.0\.0\.1 \(VRID 1\) — Master: R1/);
    downLan("R1");
    advance(4000);
    S().execCommand(id("R2"), "vrrp");
    const failover = S().events.find((e) => e.type === "VRRP_FAILOVER" && /R1.*R2/.test(e.message));
    expect(failover).toBeTruthy();
  });

  it("`show vrrp` (Click → FRR detail) flips Backup → Master on failover", () => {
    advance(5000);
    expect(out(S().execCommand(id("R1"), "show vrrp"))).toContain(" Status (v4)                             Master");
    expect(out(S().execCommand(id("R2"), "show vrrp"))).toContain(" Status (v4)                             Backup");
    downLan("R1");
    advance(4000);
    expect(out(S().execCommand(id("R2"), "show vrrp"))).toContain(" Status (v4)                             Master");
  });
});
