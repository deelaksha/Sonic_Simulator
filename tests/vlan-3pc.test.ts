/**
 * VLAN isolation the way a learner builds it: three PCs cabled to a new switch from the
 * editor (auto-DHCP gives them one /24), then VLANs set in KLISH on the switch.
 * PC1+PC2 in VLAN 10, PC3 in VLAN 20: same subnet, but only same-VLAN pings work.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { resetAll } from "./helpers";
import { S, advance, out } from "./control-helpers";

const dev = (id: string) => S().network.devices[id];
const ip = (id: string) => dev(id).interfaces.find((i) => !i.management)!.ipv4[0]?.address;

function build() {
  const sw = S().addDevice("switch", { x: 0, y: 0 }, 4);
  const ports = dev(sw).interfaces.filter((i) => !i.management);
  const pcs = [0, 1, 2].map((n) => {
    const pc = S().addDevice("pc", { x: 0, y: 0 });
    S().connect(pc, `${pc}-if0`, sw, ports[n].id, { autoDhcp: true });
    return pc;
  });
  return { sw, pcs, ports: ports.map((p) => p.name) };
}

const klish = (sw: string, lines: string[]) => {
  const errs = S().runCliScript(sw, lines, { silent: true });
  expect(errs.map((e) => e.text)).toEqual([]);
};
const ping = (from: string, to: string) => out(S().execCommand(from, `ping -c 2 ${ip(to)}`));

describe("VLANs with three PCs on one switch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    resetAll();
  });

  it("all three PCs got an address in the same /24 and reach each other before any VLAN config", () => {
    const { pcs } = build();
    const nets = pcs.map((p) => ip(p)!.split(".").slice(0, 3).join("."));
    expect(new Set(nets).size).toBe(1);
    expect(ping(pcs[0], pcs[1])).toMatch(/2 received/);
    expect(ping(pcs[0], pcs[2])).toMatch(/2 received/);
  });

  it("PC1/PC2 in VLAN 10 talk; PC3 in VLAN 20 is isolated from both", () => {
    const { sw, pcs, ports } = build();
    klish(sw, [
      "configure terminal",
      "interface Vlan 10",
      "exit",
      "interface Vlan 20",
      "exit",
      `interface ${ports[0].replace(/(\d+)$/, " $1")}`,
      "switchport access Vlan 10",
      "exit",
      `interface ${ports[1].replace(/(\d+)$/, " $1")}`,
      "switchport access Vlan 10",
      "exit",
      `interface ${ports[2].replace(/(\d+)$/, " $1")}`,
      "switchport access Vlan 20",
      "exit",
    ]);
    advance(1000);
    expect(ping(pcs[0], pcs[1])).toMatch(/2 received/);
    expect(ping(pcs[0], pcs[2])).toMatch(/0 received/);
    expect(ping(pcs[1], pcs[2])).toMatch(/0 received/);
    expect(ping(pcs[2], pcs[0])).toMatch(/0 received/);

    // what the switch learned: PC1/PC2 under VLAN 10, nothing from PC3 reaches VLAN 10
    const macs = dev(sw).macTable;
    const pcMac = (p: string) => dev(p).interfaces[0].mac.toLowerCase();
    expect(macs.find((m) => m.mac.toLowerCase() === pcMac(pcs[0]))?.vlan).toBe(10);
    expect(macs.filter((m) => m.mac.toLowerCase() === pcMac(pcs[2])).every((m) => m.vlan === 20)).toBe(true);

    const vlan = out(S().execCommand(sw, "show Vlan"));
    expect(vlan).toMatch(/Vlan10[\s\S]*A\s+Ethernet/);
    expect(vlan).toMatch(/Vlan20/);
  });

  it("moving PC3 into VLAN 10 restores reachability", () => {
    const { sw, pcs, ports } = build();
    const p = (n: number) => ports[n].replace(/(\d+)$/, " $1");
    klish(sw, ["configure terminal", "interface Vlan 10", "exit", "interface Vlan 20", "exit",
      `interface ${p(0)}`, "switchport access Vlan 10", "exit",
      `interface ${p(1)}`, "switchport access Vlan 10", "exit",
      `interface ${p(2)}`, "switchport access Vlan 20", "exit"]);
    expect(ping(pcs[0], pcs[2])).toMatch(/0 received/);
    klish(sw, ["configure terminal", `interface ${p(2)}`, "switchport access Vlan 10", "exit"]);
    advance(1000);
    expect(ping(pcs[0], pcs[2])).toMatch(/2 received/);
  });

  it("the same with Click config on the switch's bash prompt", () => {
    const { sw, pcs, ports } = build();
    S().execCommand(sw, "exit");
    for (const c of ["config vlan add 10", "config vlan add 20", `config vlan member add -u 10 ${ports[0]}`, `config vlan member add -u 10 ${ports[1]}`, `config vlan member add -u 20 ${ports[2]}`])
      S().execCommand(sw, `sudo ${c}`);
    advance(1000);
    expect(ping(pcs[0], pcs[1])).toMatch(/2 received/);
    expect(ping(pcs[0], pcs[2])).toMatch(/0 received/);
  });
});
