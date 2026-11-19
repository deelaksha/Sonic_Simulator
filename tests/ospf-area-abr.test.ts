/**
 * OSPF multi-area on the "ospf-areas" lab (fake time, real packets):
 * S1 —area 1 (stub)— S2 (ABR) —area 0— S3 (ABR) —area 2 (NSSA)— S4 (ASBR).
 * ABR summaries, area range, stub / totally stubby defaults, NSSA type-7 →
 * type-5 translation, E2 redistribution, type-4 ASBR summaries, Scapy bytes.
 */
import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ospfRuntime } from "../lib/protocols/ospf-daemon";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";
import { nodePacketEngine } from "./packet-engine-node";

const rt = (name: string) => ospfRuntime(byName(name))!;
const ospfRoutes = (name: string, dest: string) => byName(name).routingTable.filter((r) => r.type === "ospf" && r.destination === dest);
const bash = (name: string, cmd: string) => {
  const id = byName(name).id;
  if ((S().cliMode[id] ?? ["exec"]).length) S().execCommand(id, "exit");
  return out(S().execCommand(id, cmd));
};
const klish = (name: string, lines: string[]) => S().runCliScript(byName(name).id, ["configure terminal", "router ospf", ...lines, "end"]);
const ping = (from: string, ip: string) => out(S().execCommand(byName(from).id, `ping -c 2 ${ip}`));
const lsaKeys = (name: string, area: string, type: number) =>
  Object.keys(rt(name).lsdb[area] ?? {})
    .filter((k) => k.startsWith(`${type}/`))
    .sort();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
  S().loadFeatureLab("ospf-areas");
});
afterEach(() => vi.useRealTimers());

describe("ABRs and inter-area routing", () => {
  it("S2/S3 are ABRs (B-bit) and originate type-3 summaries into each other area", () => {
    advance(12_000);
    expect(rt("S2").abr).toBe(true);
    expect(rt("S3").abr).toBe(true);
    expect(rt("S1").abr).toBe(false);
    // S2 summarizes area 1 into the backbone: only the range, not 10.1.1.0/24 or 10.1.12.0/30.
    expect(lsaKeys("S3", "0.0.0.0", 3)).toEqual(["3/10.1.0.0/2.2.2.2", "3/10.2.34.0/3.3.3.3"]);
    // ... and into area 1 (stub): backbone + area-2 networks and the default.
    expect(lsaKeys("S1", "0.0.0.1", 3)).toEqual(["3/0.0.0.0/2.2.2.2", "3/10.0.23.0/2.2.2.2", "3/10.2.34.0/2.2.2.2"]);
    const db = bash("S2", "show ip ospf database router 2.2.2.2");
    expect(db).toContain("  Flags: 0x1 : ABR");
    const g = bash("S2", "show ip ospf");
    expect(g).toContain(" This router is an ABR, ABR type is: Alternative Cisco");
    expect(g).toContain(" Area ID: 0.0.0.1 (Stub)");
    expect(g).toMatch(/Area ID: 0\.0\.0\.1 \(Stub\)[\s\S]*Number of summary LSA 3\./);
  });

  it("installs inter-area routes (N IA) and H1 reaches the external host across three areas", () => {
    advance(12_000);
    expect(ospfRoutes("S4", "10.1.0.0")).toMatchObject([{ prefix: 16, nextHop: "10.2.34.1", metric: 16, distance: 110 }]);
    expect(ospfRoutes("S4", "10.1.1.0")).toHaveLength(0); // hidden behind the range
    const r = bash("S3", "show ip ospf route").split("\n");
    expect(r).toContain("N IA 10.1.0.0/16           [12] area: 0.0.0.0");
    expect(r).toContain("N    10.2.34.0/30          [4] area: 0.0.0.2");
    expect(r).toContain("R    2.2.2.2               [4] area: 0.0.0.0, ABR");
    expect(r).toContain("R    4.4.4.4               [4] area: 0.0.0.2, ASBR");
    expect(bash("S4", "show ip route")).toContain("O>* 10.1.0.0/16 [110/16] via 10.2.34.1, Ethernet0, weight 1");
    const p = ping("H1", "198.51.100.10");
    expect(p).toMatch(/2 received/);
    expect(p).toMatch(/ttl=60/);
  });

  it("area range: the ABR keeps a discard entry; cost = max component; not-advertise suppresses it", () => {
    advance(12_000);
    expect(bash("S2", "show ip ospf route")).toContain("D IA 10.1.0.0/16           Discard entry");
    // Components: 10.1.12.0/30 cost 4 and 10.1.1.0/24 cost 8 → the summary carries 8 (ospf_abr_update_aggregate).
    const sum = bash("S3", "show ip ospf database summary 10.1.0.0");
    expect(sum).toContain("  LS Type: summary-LSA");
    expect(sum).toContain("  Link State ID: 10.1.0.0 (summary Network Number)");
    expect(sum).toContain("  Network Mask: /16\n        TOS: 0  Metric: 8");
    klish("S2", ["area 1 range 10.1.0.0/16 not-advertise"]);
    advance(500);
    expect(ospfRoutes("S4", "10.1.0.0")).toHaveLength(0);
    expect(ospfRoutes("S4", "10.1.1.0")).toHaveLength(0);
    klish("S2", ["no area 1 range 10.1.0.0/16"]);
    advance(500);
    expect(ospfRoutes("S4", "10.1.1.0")).toMatchObject([{ prefix: 24, metric: 16 }]);
    expect(ospfRoutes("S4", "10.1.12.0")).toMatchObject([{ prefix: 30, metric: 12 }]);
  });
});

describe("stub and totally stubby areas", () => {
  it("stub: no type-5/type-4 inside; the ABR injects a default type-3 (cost 1 + path)", () => {
    advance(12_000);
    expect(Object.keys(rt("S1").lsdb.AS ?? {})).toHaveLength(0);
    expect(lsaKeys("S1", "0.0.0.1", 4)).toHaveLength(0);
    expect(ospfRoutes("S1", "198.51.100.0")).toHaveLength(0);
    expect(ospfRoutes("S1", "0.0.0.0")).toMatchObject([{ prefix: 0, nextHop: "10.1.12.2", metric: 5 }]);
    expect(bash("S1", "show ip route")).toContain("O>* 0.0.0.0/0 [110/5] via 10.1.12.2, Ethernet0, weight 1");
    // Hellos in a stub area carry no E-bit.
    const hello = S().captures.find((c) => c.frame.rawL3?.[9] === 89 && c.frame.rawL3[21] === 1 && c.frame.rawL3.slice(28, 32).join(".") === "0.0.0.1")!;
    expect(hello.frame.rawL3![44 + 6]).toBe(0);
  });

  it("totally stubby (no-summary): only the default summary is left", () => {
    advance(12_000);
    klish("S2", ["area 1 stub no-summary"]);
    advance(500);
    expect(lsaKeys("S1", "0.0.0.1", 3)).toEqual(["3/0.0.0.0/2.2.2.2"]);
    expect(ospfRoutes("S1", "10.0.23.0")).toHaveLength(0);
    expect(ospfRoutes("S1", "0.0.0.0")).toHaveLength(1);
    expect(ping("H1", "198.51.100.10")).toMatch(/2 received/);
    expect(bash("S2", "show ip ospf")).toContain(" Area ID: 0.0.0.1 (Stub, no summary)");
  });
});

describe("NSSA and redistribution", () => {
  it("S4 floods type-7 with the P-bit and forwarding address; S3 (elected translator) re-originates type-5", () => {
    advance(12_000);
    expect(lsaKeys("S3", "0.0.0.2", 7)).toContain("7/198.51.100.0/4.4.4.4");
    const n = bash("S3", "show ip ospf database nssa-external 198.51.100.0");
    expect(n).toContain("  Options: 0xa  : *|-|-|-|N/P|-|E|-");
    expect(n).toContain("  LS Type: NSSA-LSA");
    expect(n).toContain("        Metric Type: 2 (Larger than any link state path)");
    expect(n).toContain("        NSSA: Forward Address: 10.2.34.2");
    expect(rt("S3").xlt?.["0.0.0.2"]).toBe(true);
    expect(bash("S3", "show ip ospf")).toContain("   We are an ABR and the NSSA Elected Translator.");
    // The translated type-5 is in the backbone (and nowhere near the stub area).
    const e = bash("S2", "show ip ospf database external 198.51.100.0");
    expect(e).toContain("                AS External Link States ");
    expect(e).toContain("  Advertising Router: 3.3.3.3");
    expect(e).toContain("        Forward Address: 10.2.34.2");
    expect(bash("S3", "show ip ospf database external 198.51.100.0")).toContain("  LS Flags: 0x3  (Translated from Type-7)");
    const db = bash("S2", "show ip ospf database").split("\n");
    expect(db).toContain("                AS External Link States");
    expect(db.some((l) => /^198\.51\.100\.0 +3\.3\.3\.3 +\d+ 0x8000000\d 0x[0-9a-f]{4} E2 198\.51\.100\.0\/24 \[0x0\]$/.test(l))).toBe(true);
  });

  it("E2 semantics: zebra metric is the type-2 metric (20); show ip ospf route prints [cost/type2]", () => {
    advance(12_000);
    expect(ospfRoutes("S2", "198.51.100.0")).toMatchObject([{ nextHop: "10.0.23.2", metric: 20, distance: 110 }]);
    expect(bash("S2", "show ip route")).toContain("O>* 198.51.100.0/24 [110/20] via 10.0.23.2, Ethernet1, weight 1");
    const r = bash("S2", "show ip ospf route").split("\n");
    expect(r).toContain("N E2 198.51.100.0/24       [8/20] tag: 0");
    expect(r).toContain("R    3.3.3.3               [4] area: 0.0.0.0, ABR, ASBR");
    // metric / metric-type 1 change the LSA: E1 adds the path cost.
    klish("S4", ["redistribute connected metric 50 metric-type 1"]);
    advance(500);
    expect(ospfRoutes("S2", "198.51.100.0")).toMatchObject([{ metric: 58 }]);
    expect(bash("S2", "show ip ospf route")).toContain("N E1 198.51.100.0/24       [58] tag: 0");
    klish("S4", ["no redistribute connected"]);
    advance(500);
    expect(ospfRoutes("S2", "198.51.100.0")).toHaveLength(0);
    expect(Object.keys(rt("S2").lsdb.AS ?? {})).toHaveLength(0);
  });

  it("a regular area 2: S4 originates type-5 itself and S3 announces a type-4 ASBR-summary", () => {
    for (const s of ["S3", "S4"]) klish(s, ["no area 2 nssa"]);
    advance(12_000);
    expect(lsaKeys("S2", "0.0.0.0", 4)).toEqual(["4/4.4.4.4/3.3.3.3"]);
    expect(Object.keys(rt("S2").lsdb.AS)).toContain("5/198.51.100.0/4.4.4.4");
    expect(bash("S2", "show ip ospf route")).toContain("R    4.4.4.4            IA [8] area: 0.0.0.0, ASBR");
    expect(ospfRoutes("S2", "198.51.100.0")).toMatchObject([{ nextHop: "10.0.23.2", metric: 20 }]);
    const a = bash("S2", "show ip ospf database asbr-summary");
    expect(a).toContain("  Link State ID: 4.4.4.4 (AS Boundary Router address)");
    expect(a).toContain("  Network Mask: /0\n        TOS: 0  Metric: 4");
  });

  it("default-information originate [always]: type-5 0.0.0.0/0, metric 10 (with a RIB default) or 1 (always)", () => {
    klish("S2", ["default-information originate always"]);
    advance(12_000);
    expect(ospfRoutes("S3", "0.0.0.0")).toMatchObject([{ prefix: 0, nextHop: "10.0.23.1", metric: 1 }]);
    klish("S2", ["no default-information originate"]);
    advance(500);
    expect(ospfRoutes("S3", "0.0.0.0")).toHaveLength(0);
    // Without `always` it needs a non-OSPF default route on S2.
    klish("S2", ["default-information originate"]);
    advance(500);
    expect(ospfRoutes("S3", "0.0.0.0")).toHaveLength(0);
    S().runCliScript(byName("S2").id, ["configure terminal", "ip route 0.0.0.0/0 10.1.12.1", "end"]);
    advance(500);
    expect(ospfRoutes("S3", "0.0.0.0")).toMatchObject([{ metric: 10 }]);
  });
});

describe("wire bytes", () => {
  it("Scapy dissects summary / external / NSSA LSAs and rebuilds identical bytes", async () => {
    advance(12_000);
    // Fresh instances after convergence (the capture buffer is bounded): a new range cost and a new external metric.
    klish("S2", ["area 1 range 10.1.0.0/16 cost 9"]);
    klish("S4", ["redistribute connected metric 30"]);
    advance(500);
    const lsu1 = (type: number) =>
      [...S().captures].reverse().find((c) => {
        const b = c.frame.rawL3;
        return b?.[9] === 89 && b[21] === 4 && b[44] === 0 && b[45] === 0 && b[46] === 0 && b[47] === 1 && b[51] === type;
      })!.frame.rawL3!;
    const pkts = { 3: lsu1(3), 5: lsu1(5), 7: lsu1(7) };
    vi.useRealTimers();
    const eng = await nodePacketEngine();
    const ipq = (b: number[], o: number) => b.slice(o, o + 4).join(".");
    const u24 = (b: number[], o: number) => (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];
    const u32 = (b: number[], o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
    const PROTO: Record<number, string> = { 3: "OSPF_SummaryIP_LSA", 5: "OSPF_External_LSA", 7: "OSPF_NSSA_External_LSA" };
    for (const [t, pkt] of Object.entries(pkts)) {
      const type = Number(t);
      const d = await eng.dissect(Uint8Array.from(pkt), "IP");
      expect(d.layers.map((l) => l.proto)).toEqual(["IP", "OSPF_Hdr", "OSPF_LSUpd"]);
      expect(d.layers[2].fields.find((f) => f.name === "lsalist")?.value).toContain(PROTO[type]);
      const lsa = pkt.slice(48);
      const common = { age: (lsa[0] << 8) | lsa[1], options: lsa[2], id: ipq(lsa, 4), adrouter: ipq(lsa, 8), seq: u32(lsa, 12), mask: ipq(lsa, 20), metric: u24(lsa, 25) };
      const fields = type === 3 ? common : { ...common, ebit: lsa[24] >> 7, fwdaddr: ipq(lsa, 28), tag: u32(lsa, 32) };
      const built = await eng.build([
        { proto: "IP", fields: { src: ipq(pkt, 12), dst: ipq(pkt, 16), tos: 0xc0, ttl: 1, id: 0, flags: 2 } },
        { proto: "OSPF_Hdr", fields: { type: 4, src: ipq(pkt, 24), area: ipq(pkt, 28) } },
        { proto: "OSPF_LSUpd", fields: { lsalist: [{ proto: PROTO[type], fields }] } },
      ]);
      expect(Array.from(built.bytes)).toEqual(pkt);
    }
  }, 120_000);
});
