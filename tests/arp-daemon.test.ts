import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";
import { runModalHandlers } from "../lib/commands/sonic-cli/registry";
import { sonicClearCommand } from "../lib/commands/sonic/arpnd";
import { CommandContext } from "../lib/commands";
import { Simulation } from "../lib/engine";

const run = (name: string, cmd: string) => out(S().execCommand(byName(name).id, cmd));
const entry = (dev: string, ip: string) => byName(dev).arpTable.find((e) => e.ip === ip);
const mac = (dev: string) => byName(dev).interfaces[0].mac;
const PC1 = "192.168.10.11";
const PC2 = "192.168.10.12";

/** A CommandContext over a copy of the live network (for handlers not reachable via execCommand). */
function ctxOn(name: string): CommandContext {
  const network = structuredClone(S().network);
  return {
    device: network.devices[byName(name).id],
    network,
    captures: [],
    runSim<T>(fn: (s: Simulation) => T) {
      const s = new Simulation(network);
      return { value: fn(s), events: s.events };
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
  S().loadFeatureLab("arpnd");
  S().execCommand(byName("SW1").id, "exit"); // KLISH → bash
  advance(200); // daemon records the boot baseline
});
afterEach(() => vi.useRealTimers());

describe("ARP neighbour aging (Linux neigh model)", () => {
  it("requester REACHABLE, responder STALE; a STALE entry in use is re-probed by unicast and confirmed", () => {
    expect(run("PC1", `ping -c 1 ${PC2}`)).toMatch(/1 received/);
    expect(entry("PC1", PC2)?.state).toBe("reachable"); // solicited unicast reply
    expect(entry("PC2", PC1)?.state).toBe("stale"); // learned from the request (neigh_event_ns)
    advance(5_200); // PC2 used the STALE entry for the echo reply → DELAY → probe after 5 s
    expect(entry("PC2", PC1)?.state).toBe("reachable");
    const probe = S().captures.find((c) => c.deviceId === byName("PC2").id && c.dir === "tx" && c.frame.arp?.op === "request");
    expect(probe?.frame.ethernet.dstMac).toBe(mac("PC1")); // unicast, not broadcast
  });

  it("hosts: REACHABLE → STALE after 30 s, unused STALE removed after gc_stale_time (60 s)", () => {
    run("PC1", `ping -c 1 ${PC2}`);
    advance(29_000);
    expect(entry("PC1", PC2)?.state).toBe("reachable");
    advance(1_500);
    expect(entry("PC1", PC2)?.state).toBe("stale");
    expect(run("PC1", "arp -n")).toMatch(new RegExp(`^${PC2.replace(/\./g, "\\.")} +ether +${mac("PC2").toLowerCase()} +C +eth0$`, "m"));
    advance(61_000);
    expect(entry("PC1", PC2)).toBeUndefined();
  });

  it("SONiC SVI keeps entries REACHABLE for 1800 s (sysctl-net.conf); `ip arp timeout` overrides it", () => {
    run("PC1", "ping -c 1 192.168.10.1");
    advance(6_000); // SW1 confirms PC1 (learned STALE from the request, probed after use)
    expect(entry("SW1", PC1)?.state).toBe("reachable");
    advance(600_000);
    expect(entry("SW1", PC1)?.state).toBe("reachable");
    advance(1_200_000);
    expect(entry("SW1", PC1)?.state).toBe("stale");

    const sw = byName("SW1").id;
    S().execCommand(sw, "sonic-cli");
    for (const l of ["configure terminal", "interface Vlan 10", "ip arp timeout 60", "end"]) S().execCommand(sw, l);
    S().execCommand(sw, "exit");
    run("PC1", "ping -c 1 192.168.10.1");
    advance(6_000);
    expect(entry("SW1", PC1)?.state).toBe("reachable");
    advance(60_000);
    expect(entry("SW1", PC1)?.state).toBe("stale");
  });

  it("gratuitous ARP on an address move updates peers that knew the address (and creates nothing)", () => {
    run("PC1", `ping -c 1 ${PC2}`);
    expect(entry("PC1", PC2)?.mac).toBe(mac("PC2"));
    expect(entry("SW1", PC2)).toBeUndefined();
    const pc2 = byName("PC2").id;
    const pc3 = byName("PC3").id;
    S().clearInterfaceIp(pc2, `${pc2}-if0`, PC2);
    S().setInterfaceIp(pc3, `${pc3}-if0`, PC2, 24);
    advance(200);
    const garp = S().captures.find((c) => c.deviceId === pc3 && c.dir === "tx" && c.frame.arp?.senderIp === PC2 && c.frame.arp.targetIp === PC2);
    expect(garp?.frame.ethernet.dstMac).toBe("FF:FF:FF:FF:FF:FF");
    expect(entry("PC1", PC2)?.mac).toBe(mac("PC3"));
    expect(entry("PC1", PC2)?.state).toBe("stale");
    expect(entry("SW1", PC2)).toBeUndefined(); // arp_accept=0: gratuitous ARP never creates
    expect(run("PC1", `ping -c 1 ${PC2}`)).toMatch(/1 received/);
  });

  it("link down flushes the interface's dynamic entries", () => {
    run("PC1", `ping -c 1 ${PC2}`);
    const pc1 = byName("PC1").id;
    S().setAdminState(pc1, `${pc1}-if0`, false);
    advance(200);
    expect(byName("PC1").arpTable).toHaveLength(0);
  });
});

describe("ARP show / clear commands", () => {
  beforeEach(() => {
    run("PC1", `ping -c 1 ${PC2}`);
    run("PC1", "ping -c 1 192.168.10.1");
    run("PC2", "ping -c 1 192.168.10.1");
    advance(6_000);
  });

  it("show arp: nbrshow table with Vlan column and the FDB port of each neighbour", () => {
    const lines = run("SW1", "show arp").split("\n");
    expect(lines[0]).toBe("Address        MacAddress         Iface        Vlan");
    expect(lines[1]).toBe("-------------  -----------------  ---------  ------");
    expect(lines).toContain(`${PC1.padEnd(13)}  ${mac("PC1").toLowerCase()}  Ethernet0      10`);
    expect(lines).toContain(`${PC2.padEnd(13)}  ${mac("PC2").toLowerCase()}  Ethernet1      10`);
    expect(lines[lines.length - 1]).toBe("Total number of entries 2 ");
    expect(run("SW1", `show arp ${PC2}`)).toContain("Total number of entries 1 ");
    expect(run("SW1", "show arp -if Vlan10")).toContain("Total number of entries 2 ");
  });

  it("KLISH show ip arp renders show_arp.j2 (Vlan10 interface, DYNAMIC/STATIC type)", () => {
    const sw = byName("SW1").id;
    run("SW1", "sudo config arp add 192.168.10.99 00:11:22:33:44:55 Vlan10");
    S().execCommand(sw, "sonic-cli");
    const lines = run("SW1", "show ip arp").split("\n");
    expect(lines[1]).toBe(`${"Address".padEnd(32)}${"Hardware address".padEnd(18)}${"Interface".padEnd(16)}${"Egress Interface".padEnd(18)}${"Type".padEnd(8)}Action`);
    expect(lines).toContain(`${PC1.padEnd(32)}${mac("PC1").toLowerCase().padEnd(18)}${"Vlan10".padEnd(16)}${"-".padEnd(18)}${"DYNAMIC".padEnd(8)}Fwd`);
    expect(lines).toContain(`${"192.168.10.99".padEnd(32)}${"00:11:22:33:44:55".padEnd(18)}${"Vlan10".padEnd(16)}${"-".padEnd(18)}${"STATIC".padEnd(8)}Fwd`);
    expect(run("SW1", "show ip arp 10.9.9.9")).toBe("No ARP entries found.");
  });

  it("clear: sonic-clear arp flushes dynamic entries with iproute2 -s -s output; statics survive", () => {
    run("SW1", "sudo config arp add 192.168.10.99 00:11:22:33:44:55 Vlan10");
    const ctx = ctxOn("SW1");
    const res = sonicClearCommand.run(["arp"], ctx).output.map((o) => o.text);
    const row = new RegExp(`^${PC1.replace(/\./g, "\\.")} dev Vlan10 lladdr ${mac("PC1").toLowerCase()} used \\d+/\\d+/\\d+ probes \\d+ REACHABLE$`);
    expect(res.some((l) => row.test(l))).toBe(true);
    expect(res.slice(-2)).toEqual(["*** Round 1, deleting 2 entries ***", "*** Flush is complete after 1 round ***"]);
    expect(ctx.device.arpTable.map((e) => e.ip)).toEqual(["192.168.10.99"]);
    expect(sonicClearCommand.run(["arp"], ctx).output.map((o) => o.text)).toEqual(["Nothing to flush."]);
    expect(sonicClearCommand.run(["arp", "10.1.1.1"], ctx).output.map((o) => o.text)).toEqual(["Neighbor 10.1.1.1 not found"]);
  });

  it("KLISH clear ip arp [interface] flushes dynamic entries only", () => {
    run("SW1", "sudo config arp add 192.168.10.99 00:11:22:33:44:55 Vlan10");
    const ctx = ctxOn("SW1");
    const delegate = () => [];
    const r = runModalHandlers({ ctx, view: "enable-view", head: "clear", isNo: false, args: ["ip", "arp", "interface", "Vlan", "10"], raw: "clear ip arp interface Vlan 10", delegate });
    expect(r?.output.map((o) => o.text)).toEqual(["Dynamic ipv4 neighbors cleared successfully"]);
    expect(ctx.device.arpTable.map((e) => e.ip)).toEqual(["192.168.10.99"]);
  });

  it("static entries are PERMANENT: never aged, never updated by ARP", () => {
    run("PC1", `sudo config arp add ${PC2} 00:11:22:33:44:55 eth0`);
    advance(200_000);
    expect(entry("PC1", PC2)?.mac).toBe("00:11:22:33:44:55");
    expect(run("PC1", "arp -n")).toMatch(/00:11:22:33:44:55 +CM +eth0/);
    run("PC1", "sudo config arp clear");
    expect(entry("PC1", PC2)).toBeDefined();
  });
});
