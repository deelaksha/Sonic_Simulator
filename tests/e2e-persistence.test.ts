/**
 * End-to-end configuration lifecycle: running-config (KLISH + Click), KLISH `write memory`
 * and Click `config save`, `config reload` / `config load`, cloud/local session restore,
 * and config removal — per protocol lab, checking that protocols re-converge and traffic
 * flows again afterwards and that removal leaves no stale routes/neighbours/MACs/DB rows.
 *
 * References (sonic-buildimage/src):
 *   sonic-mgmt-framework CLI/clitree/cli-xml/config_mgmt.xml + actioner/sonic_cli_cfg_mgmt.py
 *     `write memory` → rpc_copy_cb (sonic-mgmt-common xfmr_file_mgmt.go) → host config.save
 *   sonic-utilities config/main.py save / load (mod_config upsert) / reload
 *   sonic-mgmt-framework CLI/renderer/templates/show_ntp_config.j2
 *   sonic-swss orchagent/fdborch.cpp FdbOrch::updateVlanMember (flush on member removal)
 */
import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "../lib/labs";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";
import { cliModeFor } from "../lib/commands/sonic-cli";
import { keyspace } from "../lib/sonicdb/project";
import { savedFile } from "../lib/sonicdb/persist";
import { getAppStorage } from "../lib/firebase/storage-fallback";

// Firestore: off (local-storage fallback) unless a test turns it on; when on, an in-memory
// store that rejects nested arrays exactly like Firestore's setDoc() validation does.
const fsMock = vi.hoisted(() => ({ on: false, docs: new Map<string, unknown>() }));
vi.mock("../lib/firebase/config", async (orig) => ({
  ...(await orig<typeof import("../lib/firebase/config")>()),
  getFirestoreDb: () => (fsMock.on ? {} : null),
  isFirebaseConfigured: () => fsMock.on,
}));
vi.mock("firebase/firestore", () => {
  const nested = (v: unknown, inArr = false): boolean =>
    Array.isArray(v) ? inArr || v.some((x) => nested(x, true)) : !!v && typeof v === "object" && Object.values(v).some((x) => nested(x));
  type Ref = { coll: string; path: string };
  return {
    getFirestore: () => ({}),
    doc: (_db: unknown, coll: string, id: string): Ref => ({ coll, path: `${coll}/${id}` }),
    collection: (_db: unknown, coll: string) => ({ coll }),
    query: (c: unknown) => c,
    orderBy: () => ({}),
    serverTimestamp: () => ({ serverTimestamp: true }),
    setDoc: async (ref: Ref, data: unknown) => {
      if (nested(data)) throw new Error("Function setDoc() called with invalid data. Nested arrays are not supported");
      fsMock.docs.set(ref.path, structuredClone(data));
    },
    getDoc: async (ref: Ref) => ({ exists: () => fsMock.docs.has(ref.path), data: () => structuredClone(fsMock.docs.get(ref.path)) }),
    getDocs: async (c: { coll: string }) => ({
      forEach: (cb: (d: { data: () => unknown }) => void) => {
        for (const [p, d] of fsMock.docs) if (p.startsWith(`${c.coll}/`)) cb({ data: () => structuredClone(d) });
      },
    }),
    deleteDoc: async (ref: Ref) => void fsMock.docs.delete(ref.path),
  };
});

const id = (n: string) => byName(n).id;
const live = (n: string) => S().network.devices[id(n)];
function toBash(n: string): void {
  for (let i = 0; i < 6 && cliModeFor(S().network.devices[id(n)], S().cliMode[id(n)]).length > 0; i++) S().execCommand(id(n), "exit");
}
/** A Linux-shell (Click) command. */
function bash(n: string, cmd: string): string {
  toBash(n);
  return out(S().execCommand(id(n), cmd));
}
/** A KLISH exec-mode command. */
function klish(n: string, cmd: string): string {
  toBash(n);
  if (live(n).type === "switch") S().execCommand(id(n), "sonic-cli");
  return out(S().execCommand(id(n), cmd));
}
/** KLISH config lines (from a fresh exec stack); returns the error lines. */
const cfg = (n: string, lines: string[]) => S().runCliScript(id(n), ["configure terminal", ...lines, "end"], { silent: true }).map((o) => o.text);
const runcfg = (n: string) => klish(n, "show running-configuration");
const clickcfg = (n: string) => bash(n, "show runningconfiguration all");
const cfgDb = (n: string) => keyspace(live(n), "CONFIG_DB");
const db = (n: string, name: "APPL_DB" | "STATE_DB" | "ASIC_DB") => keyspace(live(n), name);
const pingOk = (from: string, to: string) => / [1-9]\d* received/.test(bash(from, `ping -c 2 ${to}`));
const switches = () => Object.values(S().network.devices).filter((d) => d.type === "switch").map((d) => d.name);
/** Protocol-installed routes (everything but connected/local), as a comparable signature. */
const protoRoutes = (n: string) =>
  [...live(n).routingTable, ...(live(n).routingTable6 ?? [])]
    .filter((r) => r.type !== "connected")
    .map((r) => `${r.type} ${r.vrf ?? "default"} ${r.destination}/${r.prefix} ${r.nextHop ?? ""}`)
    .sort();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
  fsMock.on = false;
  fsMock.docs.clear();
  getAppStorage().clear();
  S().newLab();
});
afterEach(() => vi.useRealTimers());

// ---------------------------------------------------------------------------
// Every protocol lab: write memory → drift → config reload → same config, re-converged, traffic

type Check = () => void;
const ping = (from: string, to: string): Check => () => expect(pingOk(from, to), `${from} → ${to}`).toBe(true);
const LABS: [lab: string, check: Check][] = [
  ["bgp", ping("H1", "192.168.3.10")],
  ["bgp-policy", ping("H1", "192.168.4.10")],
  ["ospf", ping("H1", "192.168.3.10")],
  ["bfd", () => expect(bash("S1", "show bfd peers brief").match(/\bup\b/gi)?.length ?? 0).toBeGreaterThanOrEqual(2)],
  ["vrf", ping("H1", "192.168.3.10")],
  ["vrrp", () => {
    ping("H1", "192.168.20.100")();
    expect(bash("S1", "show vrrp")).toMatch(/Status \(v4\)\s+Master/);
  }],
  ["lacp", ping("H1", "192.168.10.13")],
  ["mclag", () => {
    ping("H3", "192.168.10.12")();
    expect(klish("P1", "show mclag brief")).toMatch(/Session Status\s+: up/);
  }],
  ["vxlan", ping("H1", "172.16.100.12")],
  ["evpn-irb", ping("H1", "10.2.0.22")],
  ["acl", ping("H1", "192.168.3.10")],
  ["l3-services", ping("H1", "203.0.113.10")],
  ["qos", ping("H1", "192.168.3.10")],
  ["snmp", () => expect(cfgDb("S1").has("SNMP_COMMUNITY|public")).toBe(true)],
  ["lldp", () => expect(bash("S1", "show lldp table")).toMatch(/S2[\s\S]*S3|S3[\s\S]*S2/)],
  ["l2-protect", () => expect(bash("SW1", "show mirror_session")).toMatch(/active/)],
];

describe("write memory → drift → config reload, every protocol lab", () => {
  for (const [lab, check] of LABS) {
    it(`${lab}: running-config (KLISH + Click) restored, protocols re-converge, traffic flows`, () => {
      S().loadFeatureLab(lab);
      advance(90_000, 500);
      check();
      const names = switches();
      const before = new Map(names.map((n) => [n, { k: runcfg(n), c: clickcfg(n), r: protoRoutes(n) }]));

      for (const n of names) expect(klish(n, "write memory")).toBe("Configuration saved successfully to startup-configuration");
      // `write memory` writes the same config_db.json `config save` would
      for (const n of names) expect(savedFile(live(n))!.json).toBe(before.get(n)!.c.replace(/,\n {4}"bgpraw": [\s\S]*\n}$/, "\n}"));

      // drift on every switch, through both CLIs
      for (const n of names) {
        bash(n, "config vlan add 3999");
        expect(cfg(n, ["ntp server 10.255.0.1"])).toEqual([]);
        expect(runcfg(n)).toContain("ntp server 10.255.0.1");
      }
      for (const n of names) expect(bash(n, "config reload -y")).toContain("Restarting SONiC target ...");
      advance(120_000, 500);

      for (const n of names) {
        const b = before.get(n)!;
        expect(runcfg(n), `${n} KLISH running-config`).toBe(b.k);
        expect(clickcfg(n), `${n} Click running-config`).toBe(b.c);
        expect(protoRoutes(n), `${n} protocol routes`).toEqual(b.r);
      }
      check();
    }, 60_000);
  }
});

// ---------------------------------------------------------------------------
// NTP: rendered by KLISH running-config (show_ntp_config.j2), consistent with Click/CONFIG_DB

describe("NTP across KLISH, Click and CONFIG_DB", () => {
  it("KLISH and Click NTP config render in both running-configs and survive write memory + reload", () => {
    S().loadFeatureLab("ospf");
    expect(cfg("S1", ["ntp server 10.9.9.2", "ntp source-interface Ethernet 2", "ntp vrf mgmt"])).toEqual([]);
    expect(bash("S1", "config ntp add 10.9.9.3")).toContain("added");
    const ntpBlock = ["ntp source-interface Ethernet2", "ntp vrf mgmt", "ntp server 10.9.9.2", "ntp server 10.9.9.3"];
    const rc = runcfg("S1").split("\n");
    const at = rc.indexOf(ntpBlock[0]);
    expect(rc.slice(at, at + 4)).toEqual(ntpBlock);
    expect(rc[at - 1]).toBe("!");
    // ordered after router ospf and before the LLDP/sFlow/static-route sections
    expect(rc.indexOf("router ospf")).toBeLessThan(at);
    expect(klish("S1", "show running-configuration ntp").split("\n").filter((l) => l.startsWith("ntp "))).toEqual(ntpBlock);
    const c = cfgDb("S1");
    expect(c.get("NTP|global")).toEqual({ "src_intf@": "Ethernet2", vrf: "mgmt" });
    expect([...c.keys()].filter((k) => k.startsWith("NTP_SERVER|"))).toEqual(["NTP_SERVER|10.9.9.2", "NTP_SERVER|10.9.9.3"]);

    klish("S1", "write memory");
    cfg("S1", ["no ntp server 10.9.9.2", "no ntp source-interface", "no ntp vrf"]);
    bash("S1", "config ntp del 10.9.9.3");
    expect(runcfg("S1")).not.toMatch(/^ntp /m);
    expect([...cfgDb("S1").keys()].some((k) => k.startsWith("NTP"))).toBe(false);

    bash("S1", "config reload -y");
    expect(runcfg("S1").split("\n").filter((l) => l.startsWith("ntp "))).toEqual(ntpBlock);
  });
});

// ---------------------------------------------------------------------------
// DHCP relay servers reach CONFIG_DB (dhcp_servers leaf-list) and survive a reload

describe("DHCP relay in CONFIG_DB", () => {
  it("KLISH `ip dhcp-relay` on a VLAN and Click `config dhcp-relay` on a port → dhcp_servers@; removal clears it", () => {
    S().loadFeatureLab("lacp");
    expect(cfg("S1", ["interface Vlan 10", "ip address 192.168.10.1/24", "ip dhcp-relay 10.9.9.4", "ip dhcp-relay 10.9.9.5"])).toEqual([]);
    bash("S1", "config interface ip add Ethernet3 10.3.3.1/24");
    bash("S1", "config dhcp-relay add Ethernet3 10.9.9.6");
    expect(cfgDb("S1").get("VLAN|Vlan10")).toMatchObject({ vlanid: "10", "dhcp_servers@": "10.9.9.4,10.9.9.5" });
    expect(cfgDb("S1").get("INTERFACE|Ethernet3")).toEqual({ "dhcp_servers@": "10.9.9.6" });
    expect(runcfg("S1")).toMatch(/interface Vlan10\n ip address 192.168.10.1\/24\n ip dhcp-relay 10.9.9.4\n ip dhcp-relay 10.9.9.5/);
    // one store: Click sees the KLISH relay, KLISH (and the relay data plane) the Click one
    expect(bash("S1", "show dhcp-relay")).toMatch(/Vlan10\s+10.9.9.4/);
    expect(klish("S1", "show ip dhcp-relay")).toMatch(/Ethernet3\s+10.9.9.6/);
    expect(runcfg("S1")).toMatch(/interface Ethernet3\n(?: .*\n)* ip dhcp-relay 10.9.9.6/);

    bash("S1", "config save -y");
    expect(JSON.parse(savedFile(live("S1"))!.json).VLAN.Vlan10.dhcp_servers).toEqual(["10.9.9.4", "10.9.9.5"]);
    cfg("S1", ["interface Vlan 10", "no ip dhcp-relay 10.9.9.4", "no ip dhcp-relay 10.9.9.5"]);
    bash("S1", "config dhcp-relay del Ethernet3 10.9.9.6");
    expect(cfgDb("S1").get("VLAN|Vlan10")).not.toHaveProperty("dhcp_servers@");
    expect(cfgDb("S1").get("INTERFACE|Ethernet3")).toEqual({ NULL: "NULL" });

    bash("S1", "config reload -y");
    expect(cfgDb("S1").get("VLAN|Vlan10")).toMatchObject({ "dhcp_servers@": "10.9.9.4,10.9.9.5" });
    expect(cfgDb("S1").get("INTERFACE|Ethernet3")).toEqual({ "dhcp_servers@": "10.9.9.6" });
  });
});

// ---------------------------------------------------------------------------
// config load merges (ConfigDBConnector.mod_config upsert); config reload replaces

describe("config load merges into the running config", () => {
  it("keeps what was configured after the file was written, re-adds what the file has", () => {
    S().loadFeatureLab("ospf");
    advance(60_000, 500);
    cfg("S1", ["ntp server 10.9.9.2", "interface Loopback 5", "ip address 5.5.5.5/32"]);
    bash("S1", "config vlan add 50");
    bash("S1", "config route add prefix 172.20.0.0/16 nexthop 10.0.12.2");
    bash("S1", "config save -y /etc/sonic/base.json");

    // after the save: some of the file's config removed, new config added
    cfg("S1", ["no ntp server 10.9.9.2", "no interface Loopback 5"]);
    bash("S1", "config vlan del 50");
    bash("S1", "config route del prefix 172.20.0.0/16 nexthop 10.0.12.2");
    cfg("S1", ["ntp server 10.9.9.9", "interface Loopback 6", "ip address 6.6.6.6/32"]);
    bash("S1", "config vlan add 60");
    bash("S1", "config route add prefix 172.21.0.0/16 nexthop 10.0.12.2");
    bash("S1", "config syslog add 10.9.9.1");

    expect(bash("S1", "config load -y /etc/sonic/base.json")).toBe("Running command: /usr/local/bin/sonic-cfggen -j /etc/sonic/base.json --write-to-db");
    const c = cfgDb("S1");
    for (const k of ["VLAN|Vlan50", "VLAN|Vlan60", "STATIC_ROUTE|172.20.0.0/16", "STATIC_ROUTE|172.21.0.0/16", "LOOPBACK_INTERFACE|Loopback5|5.5.5.5/32", "LOOPBACK_INTERFACE|Loopback6|6.6.6.6/32", "SYSLOG_SERVER|10.9.9.1"]) {
      expect(c.has(k), k).toBe(true);
    }
    // the NTP store is in the file: the file's store wins for that feature
    expect([...c.keys()].filter((k) => k.startsWith("NTP_SERVER|"))).toEqual(["NTP_SERVER|10.9.9.2"]);
    // daemons kept running: OSPF routes still installed
    expect(protoRoutes("S1").some((r) => r.startsWith("ospf"))).toBe(true);
    expect(pingOk("H1", "192.168.3.10")).toBe(true);

    // config reload of the same file is a replace
    bash("S1", "config reload -y /etc/sonic/base.json");
    const r = cfgDb("S1");
    expect(r.has("VLAN|Vlan60") || r.has("STATIC_ROUTE|172.21.0.0/16") || r.has("LOOPBACK_INTERFACE|Loopback6")).toBe(false);
    expect(r.has("VLAN|Vlan50") && r.has("STATIC_ROUTE|172.20.0.0/16")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cloud / local session save → restore brings the lab back working

describe("session save → restore re-converges the protocols", () => {
  const restore = async (lab: string, check: Check, opts: { firestore: boolean }) => {
    fsMock.on = opts.firestore;
    S().loadFeatureLab(lab);
    advance(90_000, 500);
    check();
    const names = switches();
    const before = new Map(names.map((n) => [n, { k: runcfg(n), c: clickcfg(n), r: protoRoutes(n) }]));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const saved = await S().saveToCloud(`${lab} session`);
    expect(saved.ok).toBe(true);
    if (opts.firestore) {
      expect(warn).not.toHaveBeenCalled(); // written to Firestore, not just the local cache
      expect(fsMock.docs.has(`sonic_sessions/${saved.id}`)).toBe(true);
      getAppStorage().removeItem("sonic_simulator_local_sessions"); // a different browser: only the cloud copy
    }
    warn.mockRestore();

    S().newLab();
    vi.setSystemTime(Date.now() + 86_400_000); // reopened a day later
    expect((await S().loadFromCloud(saved.id!)).ok).toBe(true);
    advance(120_000, 500);
    for (const n of names) {
      const b = before.get(n)!;
      expect(runcfg(n), `${n} KLISH running-config`).toBe(b.k);
      expect(clickcfg(n), `${n} Click running-config`).toBe(b.c);
      expect(protoRoutes(n), `${n} protocol routes`).toEqual(b.r);
    }
    check();
  };

  it("local fallback: BGP triangle", () => restore("bgp", ping("H1", "192.168.3.10"), { firestore: false }), 60_000);
  it("local fallback: MCLAG", () => restore("mclag", ping("H3", "192.168.10.12"), { firestore: false }), 60_000);
  it("Firestore: VXLAN/EVPN lab (daemon state holds nested arrays) is stored in the cloud and restored from it", () =>
    restore("vxlan", ping("H1", "172.16.100.12"), { firestore: true }), 60_000);
  it("Firestore: standalone switch snapshot of an EVPN leaf round-trips", async () => {
    fsMock.on = true;
    S().loadFeatureLab("evpn-irb");
    advance(30_000, 500);
    const { saveSwitchSnapshot, listSwitchSnapshots } = await import("../lib/firebase/session-service");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const snap = await saveSwitchSnapshot(live("LEAF1"), "leaf1");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    getAppStorage().removeItem("sonic_simulator_local_switch_snapshots");
    const back = (await listSwitchSnapshots()).find((s) => s.id === snap.id)!;
    expect(back.features).toEqual(JSON.parse(JSON.stringify(live("LEAF1").config.features)));
    expect(back.interfaces.map((i) => i.name)).toEqual(live("LEAF1").interfaces.map((i) => i.name));
  });
});

// ---------------------------------------------------------------------------
// Removal cleans control plane, data plane and DBs

describe("removing config leaves nothing stale", () => {
  it("no interface Vlan: neighbours, connected route and APPL/ASIC rows of the SVI go with it", () => {
    S().loadFeatureLab("lacp");
    advance(30_000, 500);
    cfg("S1", ["interface Vlan 10", "ip address 192.168.10.1/24", "ipv6 address 2001:db8:10::1/64"]);
    expect(pingOk("H1", "192.168.10.1")).toBe(true);
    const svi = live("S1").interfaces.find((i) => i.name === "Vlan10")!.id;
    expect(live("S1").arpTable.some((a) => a.interfaceId === svi)).toBe(true);
    expect(db("S1", "APPL_DB").has("NEIGH_TABLE:Vlan10:192.168.10.11")).toBe(true);

    expect(cfg("S1", ["no interface Vlan 10"])).toEqual([]);
    const d = live("S1");
    expect(d.interfaces.some((i) => i.name === "Vlan10")).toBe(false);
    expect(d.arpTable.filter((a) => a.interfaceId === svi)).toEqual([]);
    expect(d.ndpTable.filter((a) => a.interfaceId === svi)).toEqual([]);
    expect([...d.routingTable, ...d.routingTable6].filter((r) => r.interfaceId === svi)).toEqual([]);
    expect(bash("S1", "show arp")).not.toContain("192.168.10.11");
    expect(bash("S1", "show ip route")).not.toContain("192.168.10.0/24");
    for (const name of ["APPL_DB", "ASIC_DB"] as const) expect([...db("S1", name).keys()].filter((k) => k.includes("192.168.10."))).toEqual([]);
    expect([...cfgDb("S1").keys()].filter((k) => k.startsWith("VLAN_INTERFACE|"))).toEqual([]);
    // the L2 VLAN still switches
    expect(pingOk("H1", "192.168.10.13")).toBe(true);
  });

  it("VLAN members / VLAN / PortChannel removal: FDB flushed, LAG rows gone from every DB", () => {
    S().loadFeatureLab("lacp");
    advance(30_000, 500);
    expect(pingOk("H1", "192.168.10.13")).toBe(true);
    expect(live("S1").macTable.some((m) => m.vlan === 10)).toBe(true);
    cfg("S1", ["interface Ethernet 2", "no switchport access Vlan", "exit", "interface Ethernet 3", "no switchport access Vlan", "exit",
      "interface PortChannel 1", "no switchport access Vlan", "exit", "no vlan 10"]);
    advance(1_000, 100);
    expect(live("S1").macTable.filter((m) => m.vlan === 10)).toEqual([]);
    expect([...db("S1", "ASIC_DB").keys()].filter((k) => k.includes("FDB_ENTRY"))).toEqual([]);
    expect([...cfgDb("S1").keys()].filter((k) => k.startsWith("VLAN"))).toEqual([]);

    cfg("S1", ["interface Ethernet 0", "no channel-group", "exit", "interface Ethernet 1", "no channel-group", "exit", "no interface PortChannel 1"]);
    advance(5_000, 100);
    for (const name of ["APPL_DB", "STATE_DB", "ASIC_DB"] as const) expect([...db("S1", name).keys()].filter((k) => /LAG|PortChannel1/.test(k)), name).toEqual([]);
    expect([...cfgDb("S1").keys()].filter((k) => k.startsWith("PORTCHANNEL"))).toEqual([]);
    expect(runcfg("S1")).not.toMatch(/PortChannel|channel-group|Vlan/);
  });

  it("VXLAN `no map vni`: tunnel MACs of the VLAN are flushed (also data-plane learned ones); re-mapping re-converges", () => {
    S().loadFeatureLab("vxlan");
    advance(60_000, 500);
    expect(pingOk("H1", "172.16.100.12")).toBe(true);
    const tunnelMacs = () => live("LEAF1").macTable.filter((m) => m.interfaceId.startsWith("vtep:"));
    expect(tunnelMacs().length).toBe(1);

    expect(cfg("LEAF1", ["interface vxlan vtep1", "no map vni 10100 vlan 100"])).toEqual([]);
    advance(5_000, 100);
    expect(tunnelMacs()).toEqual([]);
    expect(bash("LEAF1", "show mac")).not.toContain("VxLAN");
    expect([...cfgDb("LEAF1").keys()].filter((k) => k.startsWith("VXLAN_TUNNEL_MAP"))).toEqual([]);
    expect([...db("LEAF1", "APPL_DB").keys()].filter((k) => k.startsWith("VXLAN_REMOTE_VNI") || k.startsWith("VXLAN_FDB"))).toEqual([]);
    expect(runcfg("LEAF1")).not.toContain("map vni");
    expect(pingOk("H1", "172.16.100.12")).toBe(false);

    expect(cfg("LEAF1", ["interface vxlan vtep1", "map vni 10100 vlan 100"])).toEqual([]);
    advance(30_000, 500);
    expect(pingOk("H1", "172.16.100.12")).toBe(true);
    expect(tunnelMacs().length).toBe(1);
  });

  it("no router ospf / no router bgp: routes withdrawn here and on the peers, CONFIG_DB and running-config clean", () => {
    S().loadFeatureLab("ospf");
    advance(60_000, 500);
    cfg("S1", ["no router ospf"]);
    advance(60_000, 500);
    expect(protoRoutes("S1")).toEqual([]);
    expect(protoRoutes("S2").filter((r) => r.includes("192.168.1.0/24"))).toEqual([]);
    expect([...cfgDb("S1").keys()].filter((k) => k.startsWith("OSPFV2"))).toEqual([]);
    expect([...db("S1", "APPL_DB").keys()].filter((k) => k.startsWith("ROUTE_TABLE:192.168.3."))).toEqual([]);
    expect(runcfg("S1")).not.toMatch(/ospf/);
    expect(pingOk("H1", "192.168.3.10")).toBe(false);

    S().loadFeatureLab("bgp");
    advance(60_000, 500);
    cfg("S1", ["no router bgp 65001"]);
    advance(60_000, 500);
    expect(protoRoutes("S1")).toEqual([]);
    for (const n of ["S2", "S3"]) expect(protoRoutes(n).filter((r) => r.includes("192.168.1.0/24")), n).toEqual([]);
    expect([...cfgDb("S1").keys()].filter((k) => k.startsWith("BGP_"))).toEqual([]);
    expect(runcfg("S1")).not.toMatch(/router bgp/);
  });

  it("no vrrp: the VIP moves to the backup and traffic keeps flowing; config gone from every view", () => {
    S().loadFeatureLab("vrrp");
    advance(60_000, 500);
    cfg("S1", ["interface Vlan 10", "no vrrp 10 address-family ipv4"]);
    advance(10_000, 100);
    expect(bash("S1", "show vrrp").trim()).toBe("");
    expect(bash("S2", "show vrrp")).toMatch(/Status \(v4\)\s+Master/);
    expect([...cfgDb("S1").keys()].filter((k) => k.startsWith("VRRP"))).toEqual([]);
    expect(runcfg("S1")).not.toContain("vrrp");
    expect(pingOk("H1", "192.168.20.100")).toBe(true);
  });

  it("config mclag del: domain, interfaces and STATE_DB session rows go; the peer's session drops", () => {
    S().loadFeatureLab("mclag");
    advance(30_000, 500);
    expect(bash("P1", "config mclag del 10")).toContain("MCLAG Domain delete");
    advance(40_000, 500);
    for (const name of ["CONFIG_DB", "STATE_DB"] as const) {
      const ks = name === "CONFIG_DB" ? cfgDb("P1") : db("P1", name);
      expect([...ks.keys()].filter((k) => k.startsWith("MCLAG")), name).toEqual([]);
    }
    expect(runcfg("P1")).not.toMatch(/mclag/);
    expect(klish("P2", "show mclag brief")).toMatch(/Session Status\s+: down/);
  });
});

// ---------------------------------------------------------------------------
// Services / L2 features: KLISH config reaches CONFIG_DB + Click, Click config reaches the
// KLISH running-config; `no` / `del` clean both; write memory + reload brings them back.

describe("KLISH ↔ Click ↔ CONFIG_DB for the service and L2 features", () => {
  const KLISH_CFG = [
    "spanning-tree mode rapid-pvst", "spanning-tree vlan 10 priority 4096",
    "logging server 10.9.9.1", "sflow enable", "sflow collector 10.9.9.3", "snmp-server community pub1 ro", "ntp server 10.9.9.2",
    "interface Vlan 10", "ip address 192.168.10.1/24", "exit",
    "interface Ethernet 2", "storm-control broadcast 1000", "exit",
    "mirror-session m1", "destination Ethernet3 source Ethernet2 direction rx", "exit",
    "ip route 172.20.0.0/16 192.168.10.11",
  ];
  const KLISH_DB = ["SYSLOG_SERVER|10.9.9.1", "SFLOW|global", "SNMP_COMMUNITY|pub1", "NTP_SERVER|10.9.9.2", "PORT_STORM_CONTROL|Ethernet2|broadcast", "MIRROR_SESSION|m1", "STATIC_ROUTE|172.20.0.0/16"];
  const CLICK_CFG = [
    "config syslog add 10.9.9.1", "config sflow enable", "config sflow collector add c1 10.9.9.3", "config snmp community add pub2 ro", "config ntp add 10.9.9.2",
    "config interface ip add Vlan10 192.168.10.2/24", "config interface storm-control add Ethernet2 broadcast 1000",
    "config mirror_session span add m2 Ethernet3 Ethernet2 rx", "config route add prefix 172.21.0.0/16 nexthop 192.168.10.13",
  ];
  const CLICK_RC = [/^sflow enable$/m, /^sflow collector 10\.9\.9\.3/m, /^snmp-server community pub2 ro$/m, /^ntp server 10\.9\.9\.2$/m, /interface Ethernet2\n(?: .*\n)* storm-control broadcast 1000/,
    /^mirror-session m2\n destination Ethernet3 source Ethernet2 direction rx$/m, /^ip route 172\.21\.0\.0\/16 192\.168\.10\.13$/m, /interface Vlan10\n ip address 192\.168\.10\.2\/24/];

  it("both directions, removal, and write memory + reload", () => {
    S().loadFeatureLab("lacp");
    advance(10_000, 500);
    // KLISH on S1 → CONFIG_DB and the Click views
    expect(cfg("S1", KLISH_CFG)).toEqual([]);
    for (const k of KLISH_DB) expect(cfgDb("S1").has(k), k).toBe(true);
    expect(bash("S1", "show syslog")).toContain("10.9.9.1");
    expect(bash("S1", "show sflow")).toContain("10.9.9.3");
    expect(bash("S1", "show mirror_session")).toMatch(/m1\s+active/);
    expect(bash("S1", "show ip route")).toMatch(/S>\* 172\.20\.0\.0\/16 \[1\/0\] via 192\.168\.10\.11/);
    // Click on S2 → the KLISH running-config and KLISH shows
    bash("S2", "config vlan add 10");
    for (const c of CLICK_CFG) expect(bash("S2", c), c).not.toMatch(/Error|Usage|not found|invalid/i);
    const rc2 = runcfg("S2");
    for (const re of CLICK_RC) expect(rc2, String(re)).toMatch(re);
    expect(klish("S2", "show logging servers")).toContain("10.9.9.1");

    for (const n of ["S1", "S2"]) klish(n, "write memory");
    const saved = { S1: { k: runcfg("S1"), c: clickcfg("S1") }, S2: { k: rc2, c: clickcfg("S2") } };
    expect(saved.S1.k).toMatch(/^spanning-tree mode rapid-pvst$/m);

    // removal: KLISH `no` on S1, Click `del` on S2
    expect(cfg("S1", ["no spanning-tree vlan 10", "no logging server 10.9.9.1", "no sflow collector 10.9.9.3", "no sflow enable", "no snmp-server community pub1",
      "no ntp server 10.9.9.2", "interface Ethernet 2", "no storm-control broadcast", "exit", "no mirror-session m1", "no ip route 172.20.0.0/16 192.168.10.11"])).toEqual([]);
    const db1 = [...cfgDb("S1").keys()];
    for (const k of KLISH_DB.filter((x) => x !== "SFLOW|global")) expect(db1, k).not.toContain(k);
    expect(cfgDb("S1").get("SFLOW|global")).toEqual({ admin_state: "down" });
    expect(live("S1").routingTable.some((r) => r.destination === "172.20.0.0")).toBe(false);
    expect(runcfg("S1")).not.toMatch(/storm-control|mirror-session|ip route|snmp-server|ntp server|spanning-tree vlan 10 priority/);
    expect(runcfg("S1")).toMatch(/^no spanning-tree vlan 10$/m); // STP_VLAN enabled=false is rendered

    for (const c of ["config syslog del 10.9.9.1", "config sflow collector del c1", "config sflow disable", "config snmp community del pub2", "config ntp del 10.9.9.2",
      "config mirror_session remove m2", "config route del prefix 172.21.0.0/16 nexthop 192.168.10.13"]) {
      expect(bash("S2", c), c).not.toMatch(/Error|Usage|not found|invalid/i);
    }
    // storm_control_delete_entry returns False after deleting (config/main.py:913): always "Unable to delete"
    expect(bash("S2", "config interface storm-control del Ethernet2 broadcast")).toBe("Error: Unable to delete broadcast storm-control from interface Ethernet2");
    const rcAfter = runcfg("S2");
    for (const re of CLICK_RC.slice(1, 7)) expect(rcAfter, String(re)).not.toMatch(re);
    expect([...cfgDb("S2").keys()].filter((k) => /^(SYSLOG_SERVER|SFLOW_COLLECTOR|NTP_SERVER|PORT_STORM_CONTROL|MIRROR_SESSION|STATIC_ROUTE)\|/.test(k))).toEqual([]);

    // reload restores what write memory saved, in both views
    for (const n of ["S1", "S2"] as const) {
      bash(n, "config reload -y");
      expect(runcfg(n), n).toBe(saved[n].k);
      expect(clickcfg(n), n).toBe(saved[n].c);
    }
    advance(10_000, 500);
    expect(bash("S1", "show mirror_session")).toMatch(/m1\s+active/);
    expect(pingOk("H1", "192.168.10.1")).toBe(true);
  });
});

describe("data-plane policy is re-applied after reload", () => {
  it("a bound ACL is enforced again after write memory + unbind + reload; NAT translates again after reload", () => {
    S().loadFeatureLab("acl");
    advance(10_000, 500);
    expect(cfg("S1", ["interface Ethernet 2", "ip access-group H1-POLICY in"])).toEqual([]);
    expect(pingOk("H1", "192.168.3.10")).toBe(false);
    klish("S1", "write memory");
    expect(cfg("S1", ["interface Ethernet 2", "no ip access-group H1-POLICY in"])).toEqual([]);
    expect(cfgDb("S1").get("ACL_TABLE|H1-POLICY")).not.toHaveProperty("ports@");
    expect(pingOk("H1", "192.168.3.10")).toBe(true);
    bash("S1", "config reload -y");
    advance(10_000, 500);
    expect(cfgDb("S1").get("ACL_TABLE|H1-POLICY")).toMatchObject({ "ports@": "Ethernet2" });
    expect(runcfg("S1")).toMatch(/interface Ethernet2\n(?: .*\n)* ip access-group H1-POLICY in/);
    expect(pingOk("H1", "192.168.3.10")).toBe(false);

    S().loadFeatureLab("l3-services");
    advance(30_000, 500);
    klish("S1", "write memory");
    expect(cfg("S1", ["nat", "no enable"])).toEqual([]);
    expect(cfgDb("S1").get("NAT_GLOBAL|Values")).toMatchObject({ admin_mode: "disabled" });
    bash("S1", "config reload -y");
    advance(30_000, 500);
    expect(cfgDb("S1").get("NAT_GLOBAL|Values")).toMatchObject({ admin_mode: "enabled" });
    expect(pingOk("H1", "203.0.113.10")).toBe(true);
    expect(bash("S1", "show nat translations")).toContain("100.64.0.1");
  });
});
