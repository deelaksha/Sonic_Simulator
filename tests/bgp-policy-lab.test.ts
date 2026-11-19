import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "../lib/labs";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";
import { decodeMessages, UpdateMsg } from "../lib/protocols/bgp-wire";
import { l4Payload } from "../lib/control/packet";
import { peekBgpRuntime } from "../lib/protocols/bgp-daemon";

const sh = (dev: string, cmd: string) => out(S().execCommand(byName(dev).id, cmd));
const cli = (dev: string, lines: string[]) => S().runCliScript(byName(dev).id, ["configure terminal", ...lines, "end"]);
const route = (dev: string, dest: string) => byName(dev).routingTable.filter((r) => r.type === "bgp" && r.destination === dest);

/** UPDATEs `dev` sent to `dst` (decoded, capture order). */
function updatesTo(dev: string, dst: string): UpdateMsg[] {
  const id = byName(dev).id;
  return S()
    .captures.filter((c) => c.deviceId === id && c.dir === "tx" && c.frame.ipv4?.dstIp === dst && c.frame.tcp)
    .flatMap((c) => decodeMessages(l4Payload(c.frame) ?? new Uint8Array(), true))
    .filter((m): m is UpdateMsg => m.type === 2);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
  S().loadFeatureLab("bgp-policy");
  advance(300);
});
afterEach(() => vi.useRealTimers());

describe("bgp-policy lab: two exits, policy applied per neighbor", () => {
  it("baseline: both exits learned, eBGP tie broken by the older path, H1↔H4 ping", () => {
    const t = sh("E1", "show ip bgp");
    expect(t).toMatch(/^ \*>  192\.168\.4\.0\/24   10\.0\.12\.2 {30}0 65002 65004 \?$/m);
    expect(t).toMatch(/^ \* {20}10\.0\.13\.2 {30}0 65003 65004 \?$/m);
    // different neighbour AS → not multipath without multipath-relax
    expect(route("E1", "192.168.4.0")).toHaveLength(1);
    expect(sh("E1", "show ip bgp 192.168.4.0/24")).toContain("Origin incomplete, valid, external, best (Older Path)");
    expect(sh("H1", "ping -c 1 192.168.4.10")).toMatch(/1 received/);
  });

  it("task 1: route-map in with set local-preference 200 moves the exit to ISPB", () => {
    cli("E1", ["route-map PREFER-B permit 10", "set local-preference 200", "exit", "router bgp 65001", "neighbor 10.0.13.2", "address-family ipv4 unicast", "route-map PREFER-B in"]);
    advance(200);
    const t = sh("E1", "show ip bgp");
    expect(t).toMatch(/^ \*>  192\.168\.4\.0\/24   10\.0\.13\.2 {21}200      0 65003 65004 \?$/m);
    expect(sh("E1", "show ip bgp 192.168.4.0/24")).toMatch(/10\.0\.13\.2 from 10\.0\.13\.2 \(3\.3\.3\.3\)\n {6}Origin incomplete, localpref 200, valid, external, best \(Local Pref\)/);
    expect(route("E1", "192.168.4.0")[0]).toMatchObject({ nextHop: "10.0.13.2", distance: 20 });
    expect(sh("E1", "show ip bgp neighbors 10.0.13.2")).toContain("  Route map for incoming advertisements is *PREFER-B");
    // LOCAL_PREF is never sent to eBGP peers: ISPB's table is unchanged
    expect(sh("H1", "ping -c 1 192.168.4.10")).toMatch(/1 received/);
    // removing the route-map reference restores the original choice (FRR soft-reconfig on policy change)
    cli("E1", ["router bgp 65001", "neighbor 10.0.13.2", "address-family ipv4 unicast", "no route-map PREFER-B in"]);
    advance(200);
    expect(route("E1", "192.168.4.0")[0].nextHop).toBe("10.0.12.2");
  });

  it("task 2: as-path prepend towards ISPA steers REMOTE's traffic to E1 through ISPB", () => {
    expect(sh("REMOTE", "show ip bgp 192.168.1.0/24")).toMatch(/best \((Older Path|Router ID)\)/);
    cli("E1", ["route-map PREPEND-A permit 10", "set as-path prepend 65001 65001", "exit", "router bgp 65001", "neighbor 10.0.12.2", "address-family ipv4 unicast", "route-map PREPEND-A out"]);
    advance(200);
    const d = sh("REMOTE", "show ip bgp 192.168.1.0/24");
    expect(d).toMatch(/ {2}65003 65001\n {4}10\.0\.34\.1 from 10\.0\.34\.1 \(3\.3\.3\.3\)\n {6}Origin incomplete, valid, external, best \(AS Path\)/);
    expect(d).toContain("  65002 65001 65001 65001");
    expect(route("REMOTE", "192.168.1.0")[0].nextHop).toBe("10.0.34.1");
    // on the wire: E1's own AS is prepended in front of the route-map's prepends
    const last = updatesTo("E1", "10.0.12.2").filter((u) => u.nlri.includes("192.168.1.0/24")).pop()!;
    expect(last.attrs!.asPath).toEqual([65001, 65001, 65001]);
    // advertised-routes shows the post-policy path (without our own AS)
    expect(sh("E1", "show ip bgp neighbors 10.0.12.2 advertised-routes")).toMatch(/^ \*>  192\.168\.1\.0\/24   0\.0\.0\.0                  0         32768 65001 65001 \?$/m);
  });

  it("task 3: prefix-lists filter outbound (only the LAN) and inbound (192.168.0.0/16 le 24)", () => {
    expect(sh("E1", "show ip bgp neighbors 10.0.12.2 advertised-routes")).toContain("Total number of prefixes 4");
    cli("E1", [
      "ip prefix-list ONLY-LAN seq 5 permit 192.168.1.0/24",
      "ip prefix-list FROM-ISP seq 5 permit 192.168.0.0/16 le 24",
      "router bgp 65001",
      "neighbor 10.0.12.2",
      "address-family ipv4 unicast",
      "prefix-list ONLY-LAN out",
      "prefix-list FROM-ISP in",
      "exit",
      "exit",
      "neighbor 10.0.13.2",
      "address-family ipv4 unicast",
      "prefix-list ONLY-LAN out",
      "prefix-list FROM-ISP in",
    ]);
    advance(200);
    const adv = sh("E1", "show ip bgp neighbors 10.0.12.2 advertised-routes");
    expect(adv).toContain("Total number of prefixes 1");
    expect(adv).toContain("192.168.1.0/24");
    // the withdrawn link nets disappear from ISPA's view of E1
    expect(sh("ISPA", "show ip bgp 10.0.13.0/30")).not.toContain("10.0.12.1 from 10.0.12.1");
    // inbound: link nets from the ISPs are filtered (implicit deny), 192.168.4.0/24 accepted
    const t = sh("E1", "show ip bgp");
    expect(t).not.toMatch(/10\.0\.24\.0\/30/);
    expect(t).toMatch(/192\.168\.4\.0\/24/);
    expect(sh("E1", "show ip bgp summary")).toMatch(/^10\.0\.12\.2 .* {12}1 {8}1 N\/A$/m);
    expect(sh("E1", "show ip bgp neighbors 10.0.12.2")).toContain("  Incoming update prefix filter list is *FROM-ISP");
    // a prefix-list that does not exist denies everything (lib/plist.c:783)
    cli("E1", ["router bgp 65001", "neighbor 10.0.12.2", "address-family ipv4 unicast", "prefix-list NOPE in"]);
    advance(200);
    expect(sh("E1", "show ip bgp")).not.toContain("10.0.12.2       ");
  });

  it("task 4: communities — additive tag on the wire and in show; no-export stops at ISPB", () => {
    cli("E1", ["route-map TAG permit 10", "set community 65001:100 additive", "exit", "router bgp 65001", "neighbor 10.0.13.2", "address-family ipv4 unicast", "route-map TAG out"]);
    advance(200);
    const u = updatesTo("E1", "10.0.13.2").filter((m) => m.nlri.includes("192.168.1.0/24")).pop()!;
    expect(u.attrs!.communities).toEqual([((65001 << 16) | 100) >>> 0]);
    const d = sh("REMOTE", "show ip bgp 192.168.1.0/24");
    expect(d).toMatch(/65003 65001\n.*\n.*\n {6}Community: 65001:100/);
    const c = sh("REMOTE", "show ip bgp community 65001:100");
    expect(c).toContain("192.168.1.0/24");
    // TAG applies to everything E1 sends ISPB (192.168.1.0/24 and the E1–ISPA link net)
    expect(c).toContain("Displayed 2 routes and 2 total paths");
    // community-list match in a route-map on REMOTE
    cli("REMOTE", ["bgp community-list standard FROM-E1 permit 65001:100", "route-map LP permit 10", "match community FROM-E1", "set local-preference 300", "exit", "route-map LP permit 20", "exit", "router bgp 65004", "neighbor 10.0.34.1", "address-family ipv4 unicast", "route-map LP in"]);
    advance(200);
    expect(sh("REMOTE", "show ip bgp")).toMatch(/^ \*>  192\.168\.1\.0\/24   10\.0\.34\.1 {21}300      0 65003 65001 \?$/m);
    expect(sh("REMOTE", "show bgp community-list")).toBe("Named Community standard list FROM-E1\n    permit 65001:100");

    // no-export: ISPB keeps it but never passes it to an eBGP peer
    cli("E1", ["route-map TAG permit 10", "set community no-export"]);
    advance(200);
    expect(sh("ISPB", "show ip bgp 192.168.1.0/24")).toMatch(/Paths: \(\d available, best #1, table default, not advertised to EBGP peer\)/);
    expect(sh("ISPB", "show ip bgp 192.168.1.0/24")).toContain("Community: no-export");
    const remote = sh("REMOTE", "show ip bgp 192.168.1.0/24");
    expect(remote).not.toContain("65003 65001");
    expect(remote).toContain("65002 65001");
    expect(Object.keys(peekBgpRuntime(byName("ISPB"))!.peers["10.0.34.2"].adjOut)).not.toContain("192.168.1.0/24");
  });

  it("filter-list (AS-path access-list) and weight", () => {
    cli("E1", ["bgp as-path-list VIA-B permit _65003_", "router bgp 65001", "neighbor 10.0.12.2", "address-family ipv4 unicast", "weight 500", "exit", "exit", "neighbor 10.0.13.2", "address-family ipv4 unicast", "filter-list VIA-B in"]);
    advance(200);
    const t = sh("E1", "show ip bgp");
    // weight wins over everything else
    expect(t).toMatch(/^ \*>  192\.168\.4\.0\/24   10\.0\.12\.2 {28}500 65002 65004 \?$/m);
    // only paths through AS 65003 are accepted from ISPB
    expect(t).toMatch(/^ \* {20}10\.0\.13\.2 {30}0 65003 65004 \?$/m);
    expect(t).not.toMatch(/10\.0\.13\.2 .* 65003 65002/);
    expect(sh("E1", "show bgp as-path-access-list")).toBe("AS path access list VIA-B\n    permit _65003_");
  });

  it("received-routes needs soft-reconfiguration inbound; routes shows accepted paths", () => {
    expect(sh("E1", "show ip bgp neighbors 10.0.13.2 received-routes")).toBe("% Inbound soft reconfiguration not enabled");
    cli("E1", ["router bgp 65001", "neighbor 10.0.13.2", "address-family ipv4 unicast", "soft-reconfiguration inbound"]);
    advance(200);
    expect(sh("E1", "show ip bgp neighbors 10.0.13.2 received-routes")).toContain("Total number of prefixes 4");
    const r = sh("E1", "show ip bgp neighbors 10.0.13.2 routes");
    expect(r).toContain("10.0.13.2");
    expect(r).not.toContain("10.0.12.2");
  });
});
