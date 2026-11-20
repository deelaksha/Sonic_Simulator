/**
 * `router ospf vrf NAME` (one instance per VRF, VRF interfaces only, routes in
 * the VRF table) and `log-adjacency-changes [detail]` controlling the ospfd
 * AdjChg syslog lines (ospf_nsm.c:626-636).
 */
import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ospfRuntime } from "../lib/protocols/ospf-daemon";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";

const bash = (name: string, cmd: string) => {
  const id = byName(name).id;
  if ((S().cliMode[id] ?? ["exec"]).length) S().execCommand(id, "exit");
  return out(S().execCommand(id, cmd));
};
const script = (name: string, lines: string[]) => S().runCliScript(byName(name).id, ["configure terminal", ...lines, "end"]);
const conn = (a: string, b: string) =>
  S().network.connections.find((c) => [c.a.deviceId, c.b.deviceId].sort().join() === [byName(a).id, byName(b).id].sort().join())!;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
});
afterEach(() => vi.useRealTimers());

describe("OSPF in a VRF (vrf lab: S1 Ethernet1/Ethernet2 in Vrf-red)", () => {
  beforeEach(() => {
    S().loadFeatureLab("vrf");
    script("S1", [
      "no ip route vrf Vrf-red 192.168.3.0/24 10.0.13.2",
      "interface Ethernet 1",
      "ip ospf network point-to-point",
      "exit",
      "router ospf vrf Vrf-red",
      "ospf router-id 1.1.1.1",
      "log-adjacency-changes",
      "network 10.0.13.0/30 area 0",
      "network 192.168.1.0/24 area 0",
      "exit",
      // The default instance matches every 10/8 address, but only owns default-VRF interfaces.
      "router ospf",
      "ospf router-id 1.1.1.1",
      "network 10.0.0.0/8 area 0",
    ]);
    script("S2", ["router ospf", "ospf router-id 2.2.2.2", "network 10.0.12.0/30 area 0", "network 10.0.23.0/30 area 0"]);
    script("S3", [
      "no ip route 192.168.1.0/24 10.0.13.1",
      "interface Ethernet 0",
      "ip ospf network point-to-point",
      "exit",
      "router ospf",
      "ospf router-id 3.3.3.3",
      "network 10.0.13.0/30 area 0",
      "network 192.168.3.0/24 area 0",
    ]);
  });

  it("runs a separate instance on the VRF's interfaces and installs its routes in the VRF table only", () => {
    advance(45_000); // S1–S2 is broadcast: Wait timer
    const red = ospfRuntime(byName("S1"), "Vrf-red")!;
    const def = ospfRuntime(byName("S1"))!;
    expect(red.oifs.map((o) => o.name)).toEqual(["Ethernet1", "Ethernet2"]);
    expect(def.oifs.map((o) => o.name)).toEqual(["Ethernet0"]);
    expect(red.oifs[0].nbrs.map((n) => [n.rid, n.state])).toEqual([["3.3.3.3", "Full"]]);
    expect(def.oifs[0].nbrs.map((n) => [n.rid, n.state])).toEqual([["2.2.2.2", "Full"]]);

    const s1 = byName("S1").routingTable.filter((r) => r.type === "ospf");
    expect(s1.filter((r) => r.destination === "192.168.3.0")).toMatchObject([{ vrf: "Vrf-red", nextHop: "10.0.13.2", metric: 8 }]);
    expect(s1.filter((r) => r.destination === "10.0.23.0")).toMatchObject([{ nextHop: "10.0.12.2" }]);
    expect(s1.find((r) => r.destination === "10.0.23.0")!.vrf).toBeUndefined();
    // Vrf-red's networks never reach the default-VRF neighbour.
    expect(byName("S2").routingTable.some((r) => r.type === "ospf" && (r.destination === "192.168.1.0" || r.destination === "192.168.3.0"))).toBe(false);

    expect(bash("S1", "show ip route vrf Vrf-red")).toContain("O>* 192.168.3.0/24 [110/8] via 10.0.13.2, Ethernet1, weight 1");
    expect(bash("S1", "show ip route")).not.toContain("192.168.3.0/24");
    expect(out(S().execCommand(byName("H1").id, "ping -c 2 192.168.3.10"))).toMatch(/2 received/);
  });

  it("shows take `vrf NAME` (FRR 'VRF Name:' header); a VRF without an instance is reported", () => {
    advance(12_000);
    const n = bash("S1", "show ip ospf vrf Vrf-red neighbor").split("\n");
    expect(n[0]).toBe("VRF Name: Vrf-red");
    expect(n.some((l) => /^3\.3\.3\.3 +1 Full\/- /.test(l))).toBe(true);
    expect(bash("S1", "show ip ospf neighbor")).not.toContain("3.3.3.3");
    expect(bash("S1", "show ip ospf vrf Vrf-red route")).toContain("N    192.168.3.0/24        [8] area: 0.0.0.0");
    expect(bash("S1", "show ip ospf vrf Vrf-red")).toContain(" OSPF Routing Process, Router ID: 1.1.1.1");
    expect(bash("S1", "show ip ospf vrf Vrf-blue route")).toBe("% OSPF is not enabled in vrf Vrf-blue");
    // AdjChg names the instance's VRF (ospf_get_name).
    expect(bash("S1", "show logging")).toMatch(/AdjChg: Nbr 3\.3\.3\.3, NbrIP 10\.0\.13\.2 \(Vrf-red\) on Ethernet1:10\.0\.13\.1: (Loading|Exchange) -> Full/);
  });

  it("`no router ospf vrf Vrf-red` removes only that instance and its routes", () => {
    advance(12_000);
    script("S1", ["no router ospf vrf Vrf-red"]);
    advance(200);
    expect(ospfRuntime(byName("S1"), "Vrf-red")).toBeUndefined();
    expect(byName("S1").routingTable.some((r) => r.type === "ospf" && r.vrf === "Vrf-red")).toBe(false);
    expect(ospfRuntime(byName("S1"))).toBeDefined();
  });
});

describe("log-adjacency-changes", () => {
  beforeEach(() => S().loadFeatureLab("ospf")); // the lab configures `log-adjacency-changes`

  it("is off by default (SONiC's FRR traditional profile): no AdjChg without the command", () => {
    script("S1", ["router ospf", "no log-adjacency-changes"]);
    advance(12_000);
    expect(bash("S1", "show logging")).not.toContain("AdjChg");
    expect(bash("S1", "show ip ospf")).not.toContain("Adjacency changes are logged");
    expect(bash("S2", "show ip ospf")).toContain(" Adjacency changes are logged");
  });

  it("`detail` logs every state change; `no … detail` goes back to Full/down-only", () => {
    script("S1", ["router ospf", "log-adjacency-changes detail"]);
    advance(12_000);
    const text = bash("S1", "show logging");
    expect(text).toMatch(/AdjChg: Nbr 2\.2\.2\.2, NbrIP 10\.0\.12\.2 \(default\) on Ethernet0:10\.0\.12\.1: Down -> Init \(HelloReceived\)/);
    expect(text).toMatch(/AdjChg: Nbr 2\.2\.2\.2, .*: ExStart -> Exchange \(NegotiationDone\)/);
    expect(bash("S1", "show ip ospf")).toContain(" All adjacency changes are logged");
    script("S1", ["router ospf", "no log-adjacency-changes detail"]);
    expect(bash("S1", "show ip ospf")).toContain(" Adjacency changes are logged");
    S().disconnect(conn("S1", "S2").id);
    advance(300);
    expect(bash("S1", "show logging")).toMatch(/AdjChg: Nbr 2\.2\.2\.2, NbrIP 10\.0\.12\.2 \(default\) on Ethernet0:10\.0\.12\.1: Full -> Deleted \(KillNbr\)$/m);
  });
});
