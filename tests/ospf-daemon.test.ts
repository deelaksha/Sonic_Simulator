/**
 * OSPFv2 daemon end to end on the store with fake time: real packets, timers,
 * DR/BDR election, LSDB exchange, SPF routes, failure detection.
 */
import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { registerLab } from "../lib/labs";
import { bfd, setBfdImpl, BfdApi, BfdState } from "../lib/control/bfd-api";
import { ospfRuntime, OspfNbr } from "../lib/protocols/ospf-daemon";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";
import { nodePacketEngine } from "./packet-engine-node";

const rt = (name: string) => ospfRuntime(byName(name))!;
const nbrs = (name: string): OspfNbr[] => rt(name).oifs.flatMap((o) => o.nbrs);
const nbr = (name: string, rid: string) => nbrs(name).find((n) => n.rid === rid);
const ospfRoutes = (name: string, dest: string) => byName(name).routingTable.filter((r) => r.type === "ospf" && r.destination === dest);
const bash = (name: string, cmd: string) => {
  const id = byName(name).id;
  if ((S().cliMode[id] ?? ["exec"]).length) S().execCommand(id, "exit");
  return out(S().execCommand(id, cmd));
};
const conn = (a: string, aIf: string, b: string, bIf: string) =>
  S().network.connections.find(
    (c) => (c.a.interfaceId === `${byName(a).id}-${aIf}` && c.b.interfaceId === `${byName(b).id}-${bIf}`) || (c.b.interfaceId === `${byName(a).id}-${aIf}` && c.a.interfaceId === `${byName(b).id}-${bIf}`),
  )!;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
});
afterEach(() => vi.useRealTimers());

describe("OSPF lab (routedTriangle, point-to-point links)", () => {
  beforeEach(() => S().loadFeatureLab("ospf"));

  it("forms every adjacency on the second Hello and reaches Full via DBD/LSR/LSU/LSAck", () => {
    advance(1000);
    expect(nbrs("S1").map((n) => n.state)).toEqual(["Init", "Init"]); // one-way after the first Hellos
    advance(10_000);
    for (const s of ["S1", "S2", "S3"]) {
      expect(nbrs(s)).toHaveLength(2);
      expect(nbrs(s).every((n) => n.state === "Full")).toBe(true);
    }
    // Every switch holds the same 3 Router-LSAs.
    for (const s of ["S1", "S2", "S3"]) expect(Object.keys(rt(s).lsdb["0.0.0.0"]).sort()).toEqual(["1/1.1.1.1/1.1.1.1", "1/2.2.2.2/2.2.2.2", "1/3.3.3.3/3.3.3.3"]);
    // All five packet types crossed the wire as IP proto 89.
    const types = new Set(S().captures.filter((c) => c.frame.rawL3?.[9] === 89).map((c) => c.frame.rawL3![21]));
    expect([...types].sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("installs cost-based O routes (25G → cost 4) with ECMP, and H1 reaches H3", () => {
    advance(11_000);
    const h3 = ospfRoutes("S1", "192.168.3.0");
    expect(h3).toHaveLength(1);
    expect(h3[0]).toMatchObject({ prefix: 24, nextHop: "10.0.13.2", metric: 8, distance: 110 });
    expect(h3[0].installedAtMs).toBeGreaterThan(0);
    // 10.0.23.0/30 is 8 via S2 and 8 via S3: equal-cost multipath.
    expect(ospfRoutes("S1", "10.0.23.0").map((r) => r.nextHop).sort()).toEqual(["10.0.12.2", "10.0.13.2"]);
    const ping = out(S().execCommand(byName("H1").id, "ping -c 2 192.168.3.10"));
    expect(ping).toMatch(/2 received/);
    expect(ping).toMatch(/ttl=62/);
    const rib = bash("S1", "show ip route");
    expect(rib).toContain("O>* 192.168.3.0/24 [110/8] via 10.0.13.2, Ethernet1, weight 1");
    expect(rib).toMatch(/O>\* 10\.0\.23\.0\/30 \[110\/8\] via 10\.0\.12\.2, Ethernet0, weight 1.*\n\s+\*\s+via 10\.0\.13\.2, Ethernet1/);
  });

  it("cutting S1–S3 drops the neighbour at once and reroutes via S2; reconnecting restores", () => {
    advance(11_000);
    const c = conn("S1", "if1", "S3", "if0");
    S().disconnect(c.id);
    advance(200); // next control tick
    expect(nbr("S1", "3.3.3.3")).toBeUndefined();
    expect(nbr("S3", "1.1.1.1")).toBeUndefined();
    expect(ospfRoutes("S1", "192.168.3.0")).toMatchObject([{ nextHop: "10.0.12.2", metric: 12 }]);
    expect(out(S().execCommand(byName("H1").id, "ping -c 1 192.168.3.10"))).toMatch(/1 received.*|ttl=61/s);
    expect(out(S().execCommand(byName("H1").id, "ping -c 1 192.168.3.10"))).toMatch(/ttl=61/); // one more hop

    S().connect(c.a.deviceId, c.a.interfaceId, c.b.deviceId, c.b.interfaceId);
    advance(11_000);
    expect(nbr("S1", "3.3.3.3")?.state).toBe("Full");
    expect(ospfRoutes("S1", "192.168.3.0")).toMatchObject([{ nextHop: "10.0.13.2", metric: 8 }]);
  });

  it("a neighbour that silently stops sending Hellos is declared Down after the dead interval", () => {
    advance(11_000);
    const t0 = Date.now();
    S().runCliScript(byName("S3").id, ["configure terminal", "no router ospf", "end"]);
    advance(25_000);
    expect(nbr("S1", "3.3.3.3")?.state).toBe("Full"); // still within 40 s of its last Hello
    advance(16_000);
    expect(nbr("S1", "3.3.3.3")).toBeUndefined();
    expect(nbr("S2", "3.3.3.3")).toBeUndefined();
    expect(Date.now() - t0).toBeLessThanOrEqual(41_100);
    // Without S3, 192.168.3.0/24 is gone everywhere.
    expect(ospfRoutes("S1", "192.168.3.0")).toHaveLength(0);
  });

  it("`ip ospf cost` changes the path without touching the adjacency", () => {
    advance(11_000);
    S().runCliScript(byName("S1").id, ["configure terminal", "interface Ethernet 1", "ip ospf cost 100", "end"]);
    advance(200);
    expect(ospfRoutes("S1", "192.168.3.0")).toMatchObject([{ nextHop: "10.0.12.2", metric: 12 }]);
    expect(nbr("S1", "3.3.3.3")?.state).toBe("Full");
  });

  it("`ip ospf bfd`: BFD up→down drops the neighbour immediately", () => {
    const prev = bfd();
    const states = new Map<string, BfdState>();
    const registered: string[] = [];
    const fake: BfdApi = {
      register: (d, k) => {
        registered.push(`${d.name}->${k.peer}`);
        if (!states.has(`${d.name}/${k.peer}`)) states.set(`${d.name}/${k.peer}`, "up");
      },
      unregister: (d, peer) => void states.delete(`${d.name}/${peer}`),
      state: (d, peer) => states.get(`${d.name}/${peer}`),
    };
    setBfdImpl(fake);
    try {
      S().runCliScript(byName("S1").id, ["configure terminal", "interface Ethernet 1", "ip ospf bfd", "end"]);
      advance(11_000);
      expect(registered).toContain("S1->10.0.13.2");
      expect(nbr("S1", "3.3.3.3")?.state).toBe("Full");
      states.set("S1/10.0.13.2", "down");
      advance(200);
      expect(nbr("S1", "3.3.3.3")).toBeUndefined();
      expect(ospfRoutes("S1", "192.168.3.0")).toMatchObject([{ nextHop: "10.0.12.2", metric: 12 }]);
      expect(bash("S1", "show ip ospf interface Ethernet1")).toContain("  BFD: Detect Multiplier: 3, Min Rx interval: 300, Min Tx interval: 300");
    } finally {
      setBfdImpl(prev);
    }
  });

  it("show commands render FRR 10.3 vtysh layouts", () => {
    advance(11_000);
    const n = bash("S1", "show ip ospf neighbor").split("\n");
    expect(n[0]).toBe("");
    expect(n[1]).toBe("Neighbor ID     Pri State           Up Time         Dead Time Address         Interface                        RXmtL RqstL DBsmL");
    expect(n[2]).toMatch(/^2\.2\.2\.2           1 Full\/-          \S+\s+\d+\.\d{3}s 10\.0\.12\.2       Ethernet0:10\.0\.12\.1 +0     0     0$/);

    const r = bash("S1", "show ip ospf route").split("\n");
    expect(r[0]).toBe("============ OSPF network routing table ============");
    expect(r).toContain("N    192.168.3.0/24        [8] area: 0.0.0.0");
    expect(r).toContain("                           via 10.0.13.2, Ethernet1");
    expect(r).toContain("                           directly attached to Ethernet0");
    expect(r).toContain("============ OSPF router routing table =============");

    const db = bash("S1", "show ip ospf database").split("\n");
    expect(db).toContain("       OSPF Router with ID (1.1.1.1)");
    expect(db).toContain("                Router Link States (Area 0.0.0.0)");
    expect(db).toContain("Link ID         ADV Router      Age  Seq#       CkSum  Link count");
    expect(db.some((l) => /^3\.3\.3\.3        3\.3\.3\.3       +\d+ 0x8000000\d 0x[0-9a-f]{4} 5$/.test(l))).toBe(true);

    const rl = bash("S1", "show ip ospf database router 3.3.3.3");
    expect(rl).toContain("  LS Type: router-LSA");
    expect(rl).toContain("    Link connected to: another Router (point-to-point)\n     (Link ID) Neighboring Router ID: 1.1.1.1\n     (Link Data) Router Interface address: 10.0.13.2");

    const i = bash("S1", "show ip ospf interface Ethernet0");
    expect(i).toContain("  Router ID 1.1.1.1, Network Type POINTOPOINT, Cost: 4");
    expect(i).toContain("  Transmit Delay is 1 sec, State Point-To-Point, Priority 1");
    expect(i).toContain("  Neighbor Count is 1, Adjacent neighbor count is 1");

    const g = bash("S1", "show ip ospf");
    expect(g).toContain(" OSPF Routing Process, Router ID: 1.1.1.1");
    expect(g).toContain("   Number of fully adjacent neighbors in this area: 2");
    expect(g).toContain("   Number of router LSA 3. Checksum Sum 0x");
  });

  it("sonic-cli `show ip ospf neighbor` uses the KLISH template layout", () => {
    advance(11_000);
    const lines = out(S().execCommand(byName("S1").id, "show ip ospf neighbor")).split("\n");
    expect(lines[0]).toBe(" ");
    expect(lines[1]).toBe("Neighbor ID     Pri State           Dead Time Address         Interface                            RXmtL RqstL DBsmL");
    expect(lines[2]).toMatch(/^2\.2\.2\.2           1 Full\/-          +\d+\.\d{3}s 10\.0\.12\.2       Ethernet0:10\.0\.12\.1/);
  });

  it("tcpdump prints OSPFv2 packets the way tcpdump does", () => {
    advance(11_000);
    const s1 = byName("S1").id;
    S().execCommand(s1, "exit");
    S().execCommand(s1, "sudo tcpdump -i Ethernet0 -nn -c 1");
    advance(10_000);
    expect((S().terminals[s1] ?? []).some((l) => /IP 10\.0\.12\.1 > 224\.0\.0\.5: OSPFv2, Hello, length 48$/.test(l.text))).toBe(true);
  });

  it("Scapy dissects Hello / DBD / LSU(Router-LSA) and recomputes identical checksums", async () => {
    advance(11_000);
    const first = (type: number) => S().captures.find((c) => c.frame.rawL3?.[9] === 89 && c.frame.rawL3[21] === type)!.frame.rawL3!;
    const hello = first(1);
    const dbd = first(2);
    const lsu = S().captures.find((c) => c.frame.rawL3?.[9] === 89 && c.frame.rawL3[21] === 4 && c.frame.rawL3[48] === 0 && c.frame.rawL3[49] === 1)!.frame.rawL3!;
    vi.useRealTimers();
    const eng = await nodePacketEngine();
    const field = (d: Awaited<ReturnType<typeof eng.dissect>>, proto: string, name: string) => d.layers.find((l) => l.proto === proto)?.fields.find((f) => f.name === name)?.value;

    const h = await eng.dissect(Uint8Array.from(hello), "IP");
    expect(h.layers.map((l) => l.proto)).toEqual(["IP", "OSPF_Hdr", "OSPF_Hello"]);
    expect(field(h, "IP", "proto")).toBe("89");
    expect(field(h, "IP", "ttl")).toBe("1");
    expect(field(h, "OSPF_Hello", "hellointerval")).toBe("10");
    expect(field(h, "OSPF_Hello", "deadinterval")).toBe("40");
    expect(field(h, "OSPF_Hello", "mask")).toBe("255.255.255.252");

    const d = await eng.dissect(Uint8Array.from(dbd), "IP");
    expect(d.layers.map((l) => l.proto)).toEqual(["IP", "OSPF_Hdr", "OSPF_DBDesc"]);
    expect(field(d, "OSPF_DBDesc", "dbdescr")).toBe("MS+M+I");

    const u = await eng.dissect(Uint8Array.from(lsu), "IP");
    expect(u.layers.map((l) => l.proto)).toEqual(["IP", "OSPF_Hdr", "OSPF_LSUpd"]);
    expect(field(u, "OSPF_LSUpd", "lsalist")).toMatch(/OSPF_Router_LSA .*type=1 .*linklist=\[<OSPF_Link /);

    // Rebuild with Scapy leaving every checksum/length unset: identical bytes.
    const ip = (b: number[]) => ({ proto: "IP", fields: { src: b.slice(12, 16).join("."), dst: b.slice(16, 20).join("."), tos: 0xc0, ttl: 1, id: 0, flags: 2 } });
    const hdr = (b: number[]) => ({ proto: "OSPF_Hdr", fields: { type: b[21], src: b.slice(24, 28).join("."), area: b.slice(28, 32).join(".") } });
    const builtHello = await eng.build([
      ip(hello),
      hdr(hello),
      { proto: "OSPF_Hello", fields: { mask: "255.255.255.252", hellointerval: 10, options: 2, prio: 1, deadinterval: 40, router: "0.0.0.0", backup: "0.0.0.0", neighbors: [] } },
    ]);
    expect(Array.from(builtHello.bytes)).toEqual(hello);

    const lsa = lsu.slice(48);
    const ipq = (b: number[], o: number) => b.slice(o, o + 4).join(".");
    const nLinks = (lsa[22] << 8) | lsa[23];
    const links = Array.from({ length: nLinks }, (_, i) => {
      const o = 24 + i * 12;
      return { proto: "OSPF_Link", fields: { id: ipq(lsa, o), data: ipq(lsa, o + 4), type: lsa[o + 8], metric: (lsa[o + 10] << 8) | lsa[o + 11] } };
    });
    const builtLsu = await eng.build([
      ip(lsu),
      hdr(lsu),
      {
        proto: "OSPF_LSUpd",
        fields: {
          lsalist: [
            {
              proto: "OSPF_Router_LSA",
              fields: { age: (lsa[0] << 8) | lsa[1], options: lsa[2], id: ipq(lsa, 4), adrouter: ipq(lsa, 8), seq: ((lsa[12] << 24) | (lsa[13] << 16) | (lsa[14] << 8) | lsa[15]) >>> 0, flags: 0, linklist: links },
            },
          ],
        },
      },
    ]);
    expect(Array.from(builtLsu.bytes)).toEqual(lsu);
  }, 120_000);
});

// Four SONiC switches with a routed port each on one broadcast LAN (an L2 switch).
// (SVIs are not used: every switch's Vlan10 SVI gets the same MAC from the
// name-only logicalMac() in lib/commands/sonic-cli.ts, which breaks unicast.)
registerLab("test-ospf-lan", (api) => {
  api.newLab();
  const lan = api.addDevice("switch", { x: 400, y: 300 }, 4);
  api.rename(lan, "LAN");
  [1, 2, 3, 4].forEach((i) => {
    const s = api.addDevice("switch", { x: i * 150, y: 100 }, 4);
    api.rename(s, `R${i}`);
    api.connect(s, `${s}-if0`, lan, `${lan}-if${i - 1}`);
    api.runCliScript(s, [
      "configure terminal",
      "interface Ethernet 0",
      "ip address 10.0.10." + i + "/24",
      ...(i === 1 ? ["ip ospf priority 255"] : []),
      "exit",
      "router ospf",
      `ospf router-id ${i}.${i}.${i}.${i}`,
      "network 10.0.10.0/24 area 0",
      "end",
    ]);
  });
  api.finish("OSPF LAN");
});

describe("DR/BDR election on a shared broadcast LAN", () => {
  beforeEach(() => S().loadFeatureLab("test-ospf-lan"));

  it("waits the 40 s Wait timer, elects priority-255 R1 as DR and highest router-id R4 as BDR", () => {
    advance(30_000);
    expect(rt("R1").oifs[0].state).toBe("Waiting");
    expect(nbrs("R1").every((n) => n.state === "2-Way")).toBe(true); // no adjacency before DR/BDR exist
    advance(25_000);
    for (const r of ["R1", "R2", "R3", "R4"]) {
      expect(rt(r).oifs[0].dr).toBe("10.0.10.1");
      expect(rt(r).oifs[0].bdr).toBe("10.0.10.4");
    }
    expect(rt("R1").oifs[0].state).toBe("DR");
    expect(rt("R4").oifs[0].state).toBe("Backup");
    expect(rt("R2").oifs[0].state).toBe("DROther");
    // DROthers are only adjacent with DR/BDR; with each other they stay 2-Way.
    expect(nbr("R2", "1.1.1.1")?.state).toBe("Full");
    expect(nbr("R2", "4.4.4.4")?.state).toBe("Full");
    expect(nbr("R2", "3.3.3.3")?.state).toBe("2-Way");
    expect(nbrs("R1").every((n) => n.state === "Full")).toBe(true);

    const n = bash("R2", "show ip ospf neighbor");
    expect(n).toMatch(/^1\.1\.1\.1         255 Full\/DR /m);
    expect(n).toMatch(/^3\.3\.3\.3           1 2-Way\/DROther /m);
    expect(n).toMatch(/^4\.4\.4\.4           1 Full\/Backup /m);
    // The DR originates the Network-LSA listing every attached router.
    const net = bash("R3", "show ip ospf database network");
    expect(net).toContain("  Link State ID: 10.0.10.1 (address of Designated Router)");
    expect(net).toContain("  Network Mask: /24");
    for (const r of ["1.1.1.1", "2.2.2.2", "3.3.3.3", "4.4.4.4"]) expect(net).toContain(`        Attached Router: ${r}`);
    const i = bash("R2", "show ip ospf interface Ethernet0");
    expect(i).toContain("  Designated Router (ID) 1.1.1.1 Interface Address 10.0.10.1/24");
    expect(i).toContain("  Backup Designated Router (ID) 4.4.4.4, Interface Address 10.0.10.4");
    expect(i).toContain("  Transmit Delay is 1 sec, State DROther, Priority 1");
  });

  it("when the DR goes away the BDR takes over and a new BDR is elected", () => {
    advance(55_000);
    S().runCliScript(byName("R1").id, ["configure terminal", "no router ospf", "end"]);
    advance(52_000); // dead interval, then the new DR's next Hello
    for (const r of ["R2", "R3", "R4"]) {
      expect(rt(r).oifs[0].dr).toBe("10.0.10.4");
      expect(rt(r).oifs[0].bdr).toBe("10.0.10.3");
    }
    expect(nbr("R2", "3.3.3.3")?.state).toBe("Full");
    expect(nbr("R2", "4.4.4.4")?.state).toBe("Full");
  });
});
