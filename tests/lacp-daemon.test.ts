import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";
import { lacpRuntime, ST, parseLacpdu, ETH_P_SLOW } from "../lib/protocols/lacp-daemon";
import { frameToBytes } from "../lib/sflow/wire";
import { nodePacketEngine } from "./packet-engine-node";

const CD = ST.SYNC | ST.COLLECTING | ST.DISTRIBUTING;
const port = (sw: string, m: string) => lacpRuntime(byName(sw))!.lags.PortChannel1.ports[m];
const pc = (sw: string) => byName(sw).interfaces.find((i) => i.name === "PortChannel1")!;
const cli = (dev: string, cmd: string) => out(S().execCommand(byName(dev).id, cmd));
const ping = (from: string, to: string, n = 2) => cli(from, `ping -c ${n} ${to}`);
/** Cable between S1 EthernetN and S2 EthernetN. */
const cable = (n: number) => S().network.connections.find((c) => c.a.deviceId === byName("S1").id && c.a.interfaceId === `${byName("S1").id}-if${n}`)!.id;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
  S().loadFeatureLab("lacp");
});
afterEach(() => vi.useRealTimers());

describe("LACP (teamd lacp runner) on the lacp lab", () => {
  it("converges within ~3 s at fast rate: both members Selected/Collecting/Distributing, PortChannel up", () => {
    expect(pc("S1").operState).toBe("down");
    advance(3000);
    for (const sw of ["S1", "S2"]) {
      for (const m of ["Ethernet0", "Ethernet1"]) {
        const p = port(sw, m);
        expect(p.state).toBe("current");
        expect(p.enabled).toBe(true);
        expect(p.actor.state & CD).toBe(CD);
        expect(p.partner.state & CD).toBe(CD);
        expect(p.actor.state & ST.TIMEOUT).toBe(ST.TIMEOUT); // fast_rate
        expect(p.actor.key).toBe(11); // lacp_key auto: "1" + "1"
      }
      expect(pc(sw).operState).toBe("up");
      expect(pc(sw).speed).toBe(50000);
    }
    // Partner = the other switch's system MAC (= its PortChannel hwaddr), port ids EthernetN+1.
    expect(port("S1", "Ethernet1").partner.system).toBe(pc("S2").mac.toUpperCase());
    expect(port("S1", "Ethernet1").partner.port).toBe(2);
  });

  it("learns MACs on the PortChannel and pings across it", () => {
    advance(3000);
    expect(ping("H1", "192.168.10.13")).toMatch(/2 received/);
    const s2 = byName("S2");
    const h1Mac = byName("H1").interfaces[0].mac;
    const e = s2.macTable.find((m) => m.mac === h1Mac)!;
    expect(s2.interfaces.find((i) => i.id === e.interfaceId)?.name).toBe("PortChannel1");
    expect(s2.macTable.every((m) => !["Ethernet0", "Ethernet1"].includes(s2.interfaces.find((i) => i.id === m.interfaceId)?.name ?? ""))).toBe(true);
  });

  it("hashes different flows onto different members; one flow always uses one member", () => {
    advance(3000);
    const s1 = byName("S1");
    const before = S().captures.length;
    for (const [a, b] of [["H1", "192.168.10.13"], ["H1", "192.168.10.14"], ["H2", "192.168.10.13"], ["H2", "192.168.10.14"]]) {
      expect(ping(a, b, 3)).toMatch(/3 received/);
    }
    const members = new Map<string, Set<string>>();
    for (const c of S().captures.slice(before)) {
      if (c.deviceId !== s1.id || c.dir !== "tx" || c.frame.icmp?.type !== "echo-request") continue;
      const name = s1.interfaces.find((i) => i.id === c.interfaceId)!.name;
      if (name === "PortChannel1") continue;
      const flow = `${c.frame.ipv4!.srcIp}>${c.frame.ipv4!.dstIp}`;
      if (!members.has(flow)) members.set(flow, new Set());
      members.get(flow)!.add(name);
    }
    expect(members.size).toBe(4);
    for (const used of members.values()) expect(used.size).toBe(1); // sticky
    const all = new Set([...members.values()].flatMap((s) => [...s]));
    expect([...all].sort()).toEqual(["Ethernet0", "Ethernet1"]); // spread
  });

  it("member cable cut: traffic continues on the other member and the LAG stays up; both cut: LAG down", () => {
    advance(3000);
    S().disconnect(cable(0));
    advance(300);
    expect(port("S1", "Ethernet0").state).toBe("disabled");
    expect(port("S1", "Ethernet0").enabled).toBe(false);
    expect(port("S1", "Ethernet1").enabled).toBe(true);
    expect(pc("S1").operState).toBe("up");
    expect(pc("S2").operState).toBe("up");
    for (const t of ["192.168.10.13", "192.168.10.14"]) expect(ping("H1", t)).toMatch(/2 received/);
    expect(ping("H2", "192.168.10.13")).toMatch(/2 received/);
    S().disconnect(cable(1));
    advance(300);
    expect(pc("S1").operState).toBe("down");
    expect(pc("S2").operState).toBe("down");
    expect(ping("H1", "192.168.10.13", 1)).toMatch(/0 received/);
  });

  it("min-links 2: the LAG goes down as soon as one member fails", () => {
    S().runCliScript(byName("S1").id, ["configure terminal", "interface PortChannel 1", "min-links 2", "end"]);
    advance(3000);
    expect(pc("S1").operState).toBe("up");
    S().disconnect(cable(1));
    advance(300);
    expect(port("S1", "Ethernet0").enabled).toBe(true);
    expect(pc("S1").operState).toBe("down"); // 1 enabled < min_ports 2
    expect(pc("S2").operState).toBe("up"); // S2 keeps min-links 1
    expect(cli("S1", "show interface PortChannel 1")).toContain("Minimum number of links to bring PortChannel up is 2");
  });

  it("partner timeout (3 × 1 s): PDUs stop with the link still up → EXPIRED, then DEFAULTED", () => {
    advance(3000);
    S().runCliScript(byName("S2").id, ["configure terminal", "interface PortChannel 1", "shutdown", "end"]);
    advance(1500);
    expect(port("S1", "Ethernet0").state).toBe("current"); // still within the 3 s timeout
    advance(2000);
    expect(port("S1", "Ethernet0").state).toBe("expired");
    expect(port("S1", "Ethernet0").enabled).toBe(false);
    expect(pc("S1").operState).toBe("down");
    advance(3500);
    expect(port("S1", "Ethernet0").state).toBe("defaulted");
    expect(port("S1", "Ethernet0").partner.system).toBe("00:00:00:00:00:00");
  });

  it("fallback: no LACP partner → one member is put in FALLBACK and the LAG comes up", () => {
    S().runCliScript(byName("S1").id, ["configure terminal", "interface PortChannel 1", "fallback", "end"]);
    for (const m of ["Ethernet 0", "Ethernet 1"]) S().runCliScript(byName("S2").id, ["configure terminal", `interface ${m}`, "no channel-group", "end"]);
    advance(9000);
    const states = ["Ethernet0", "Ethernet1"].map((m) => port("S1", m).state).sort();
    expect(states).toEqual(["defaulted", "fallback"]);
    expect(port("S1", "Ethernet0").state).toBe("fallback"); // lower port number wins
    expect(pc("S1").operState).toBe("up");
  });

  it("show interfaces portchannel (teamshow), show PortChannel summary, show interface PortChannel 1", () => {
    advance(3000);
    expect(cli("S1", "show PortChannel summary")).toMatch(/^1 {9}PortChannel1 {8}Eth \(U\) {8}LACP {11}Ethernet0\(P\), Ethernet1\(P\)/m);
    const detail = cli("S1", "show interface PortChannel 1");
    expect(detail).toContain("PortChannel1 is up, line protocol is up, mode LACP");
    expect(detail).toContain("LACP mode ACTIVE interval FAST priority 65535");
    expect(detail).toContain("Members in this channel: Ethernet0 Ethernet1");
    expect(detail).toMatch(/LACP Partner port 1 {2}address [0-9a-f:]{17} key 11/);
    S().execCommand(byName("S1").id, "exit"); // to the Click shell
    const team = cli("S1", "show interfaces portchannel");
    expect(team).toContain("Flags: A - active, I - inactive, Up - up, Dw - Down, N/A - not available,");
    expect(team).toMatch(/ {2}No\. {2}Team Dev {6}Protocol {5}Ports/);
    expect(team).toMatch(/ {4}1 {2}PortChannel1 {2}LACP\(A\)\(Up\) {2}Ethernet0\(S\) Ethernet1\(S\)/);
    S().disconnect(cable(0));
    advance(300);
    expect(cli("S1", "show interfaces portchannel")).toContain("Ethernet0(D) Ethernet1(S)");
  });

  it("tcpdump prints LACPv1, length 110 with -v TLV lines", () => {
    const s1 = byName("S1").id;
    S().execCommand(s1, "exit");
    S().execCommand(s1, "sudo tcpdump -i Ethernet0 -nn -v -c 2");
    advance(3000);
    const t = (S().terminals[s1] ?? []).map((l) => l.text).join("\n");
    expect(t).toMatch(/LACPv1, length 110\n\tActor Information TLV \(0x01\), length 20\n\t {2}System [0-9a-f:]{17}, System Priority 65535, Key 11, Port 1, Port Priority 255\n\t {2}State Flags \[Activity, Timeout, Aggregation/);
    expect(t).toContain("\tCollector Information TLV (0x03), length 16");
  });

  it("Scapy dissects the LACPDU (scapy.contrib.lacp) with the negotiated fields", async () => {
    advance(3000);
    const s1 = byName("S1");
    const cap = [...S().captures].reverse().find((c) => c.deviceId === s1.id && c.dir === "tx" && c.frame.ethernet.typeCode === ETH_P_SLOW)!;
    expect(cap.frame.ethernet.dstMac).toBe("01:80:C2:00:00:02");
    expect(cap.frame.rawL3!.length).toBe(110);
    const parsed = parseLacpdu(cap.frame.rawL3!)!;
    vi.useRealTimers(); // Pyodide needs real timers
    const engine = await nodePacketEngine();
    const d = await engine.dissect(frameToBytes(cap.frame));
    const protos = d.layers.map((l) => l.proto);
    expect(protos).toContain("SlowProtocol");
    expect(protos).toContain("LACP");
    const f = (name: string) => d.layers.find((l) => l.proto === "LACP")?.fields.find((x) => x.name === name)?.value;
    expect(f("actor_system_priority")).toBe("65535");
    expect(f("actor_system")?.toLowerCase()).toBe(pc("S1").mac.toLowerCase());
    expect(f("actor_key")).toBe("11");
    expect(f("actor_port_priority")).toBe("255");
    expect(f("actor_port_number")).toBe(String(parsed.actor.port));
    expect(Number(f("actor_state"))).toBe(parsed.actor.state);
    expect(f("partner_system")?.toLowerCase()).toBe(pc("S2").mac.toLowerCase());
    expect(f("collector_length")).toBe("16");
  }, 60_000);
});

describe("LACP config lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    resetAll();
    S().loadFeatureLab("lacp");
  });
  afterEach(() => vi.useRealTimers());

  it("removing a member (no channel-group) deselects it on the partner at once; no interface PortChannel drops the LAG", () => {
    advance(3000);
    S().runCliScript(byName("S2").id, ["configure terminal", "interface Ethernet 0", "no channel-group", "end"]);
    advance(200);
    expect(port("S1", "Ethernet0").enabled).toBe(false); // last DISABLED LACPDU (libteam patch 0013) cleared Sync
    expect(port("S1", "Ethernet1").enabled).toBe(true);
    S().runCliScript(byName("S2").id, ["configure terminal", "interface Ethernet 1", "no channel-group", "exit", "no interface PortChannel 1", "end"]);
    advance(200);
    expect(byName("S2").config.features?.lacp).toEqual({ portchannels: [] });
    expect(lacpRuntime(byName("S2"))!.lags).toEqual({});
    expect(pc("S1").operState).toBe("down");
  });
});
