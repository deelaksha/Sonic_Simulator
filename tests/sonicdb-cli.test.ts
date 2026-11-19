/** sonic-db-cli / redis-cli output formats, show runningconfiguration all, config save/reload/load. */
import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "../lib/labs";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";
import { Device } from "../lib/models/device";
import { cliModeFor } from "../lib/commands/sonic-cli";
import { globToRegExp } from "../lib/sonicdb/redis";

const sw = (): Device => Object.values(S().network.devices).find((d) => d.type === "switch")!;
const live = (d: Device) => S().network.devices[d.id];
function run(d: Device, cmd: string): string {
  for (let i = 0; i < 4 && cliModeFor(S().network.devices[d.id], S().cliMode[d.id]).length > 0; i++) S().execCommand(d.id, "exit");
  return out(S().execCommand(d.id, cmd));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
});
afterEach(() => vi.useRealTimers());

describe("redis-cli / sonic-db-cli formatting", () => {
  beforeEach(() => S().loadVlanLab());

  it("redis-cli: numbered keys, field/value pairs, quoted hget, (nil), (integer), (empty array)", () => {
    const s = sw();
    expect(run(s, "redis-cli -n 4 keys 'VLAN|*'")).toBe(['1) "VLAN|Vlan10"', '2) "VLAN|Vlan20"'].join("\n"));
    expect(run(s, "redis-cli -n 4 hgetall VLAN_MEMBER|Vlan10|Ethernet0")).toBe(['1) "tagging_mode"', '2) "untagged"'].join("\n"));
    expect(run(s, "redis-cli -n 4 hget PORT|Ethernet0 admin_status")).toBe('"up"');
    expect(run(s, "redis-cli -n 4 hget PORT|Ethernet0 nosuch")).toBe("(nil)");
    expect(run(s, "redis-cli -n 4 exists VLAN|Vlan10 VLAN|Vlan99")).toBe("(integer) 1");
    expect(run(s, "redis-cli -n 4 keys NOPE*")).toBe("(empty array)");
    expect(run(s, "redis-cli -n 6 type 'PORT_TABLE|Ethernet0'")).toBe("hash");
    // >9 elements: right-aligned indexes like redis-cli
    const many = run(s, "redis-cli -n 1 keys *").split("\n");
    expect(many.length).toBeGreaterThan(9);
    expect(many[0]).toMatch(/^ {1,2}1\) "ASIC_STATE:/);
    expect(run(s, "redis-cli -n 4 --raw hget PORT|Ethernet0 mtu")).toBe("9100");
    expect(run(s, "redis-cli -n 4 scan 0 match 'VLAN|*'")).toBe(['1) "0"', '2) 1) "VLAN|Vlan10"', '   2) "VLAN|Vlan20"'].join("\n"));
  });

  it("sonic-db-cli: list per line, python dict for HGETALL, raw HGET, True/False HEXISTS", () => {
    const s = sw();
    expect(run(s, "sonic-db-cli CONFIG_DB keys VLAN_MEMBER|*")).toBe("VLAN_MEMBER|Vlan10|Ethernet0\nVLAN_MEMBER|Vlan10|Ethernet1\nVLAN_MEMBER|Vlan20|Ethernet2");
    expect(run(s, "sonic-db-cli APPL_DB hgetall VLAN_TABLE:Vlan10")).toBe("{'admin_status': 'up', 'mtu': '9100'}");
    expect(run(s, "sonic-db-cli APPL_DB HGET VLAN_TABLE:Vlan10 mtu")).toBe("9100");
    expect(run(s, "sonic-db-cli STATE_DB hexists PORT_TABLE|Ethernet0 state")).toBe("True");
    expect(run(s, "sonic-db-cli CONFIG_DB exists VLAN|Vlan10")).toBe("1");
    expect(run(s, "sonic-db-cli PING")).toBe("PONG");
    expect(run(s, "sonic-db-cli FOO_DB keys *")).toContain("Invalid database name input : 'FOO_DB'");
    expect(run(s, "sonic-db-cli -n asic0 CONFIG_DB keys *")).toContain("Invalid namespace");
  });

  it("writes are refused read-only; hosts have no sonic-db-cli", () => {
    const s = sw();
    const r = run(s, "redis-cli -n 4 hset PORT|Ethernet0 mtu 1500");
    expect(r).toContain("(error) READONLY You can't write against a read only replica.");
    expect(r).toContain("read-only projection");
    expect(run(s, "sonic-db-cli CONFIG_DB del PORT|Ethernet0")).toContain("READONLY");
    expect(run(s, "redis-cli -n 4 hget PORT|Ethernet0 mtu")).toBe('"9100"');
    const pc = Object.values(S().network.devices).find((d) => d.type === "pc")!;
    expect(run(pc, "sonic-db-cli CONFIG_DB keys *")).toContain("command not found");
  });

  it("glob matching follows Redis rules", () => {
    expect(globToRegExp("PORT|Ether*").test("PORT|Ethernet0")).toBe(true);
    expect(globToRegExp("VLAN|Vlan1?").test("VLAN|Vlan10")).toBe(true);
    expect(globToRegExp("VLAN|Vlan1?").test("VLAN|Vlan100")).toBe(false);
    expect(globToRegExp("k[ab]").test("kb")).toBe(true);
    expect(globToRegExp("k[^ab]").test("kb")).toBe(false);
  });

  it("show runningconfiguration all is valid, sorted CONFIG_DB JSON with real table names", () => {
    const s = sw();
    const txt = run(s, "show runningconfiguration all");
    const j = JSON.parse(txt);
    expect(Object.keys(j)).toEqual([...Object.keys(j)].sort());
    for (const t of ["DEVICE_METADATA", "PORT", "VLAN", "VLAN_MEMBER", "MGMT_INTERFACE"]) expect(j).toHaveProperty(t);
    expect(j.VLAN.Vlan10).toEqual({ members: ["Ethernet0", "Ethernet1"], vlanid: "10" });
    expect(j.VLAN_MEMBER["Vlan20|Ethernet2"]).toEqual({ tagging_mode: "untagged" });
    expect(txt.split("\n")[1]).toBe('    "DEVICE_METADATA": {'); // indent 4
    // snmp sub-command still owned by snmp.ts
    expect(run(s, "show runningconfiguration snmp")).not.toContain("DEVICE_METADATA");
  });
});

describe("config save / reload / load", () => {
  it("reload without a saved file fails; save writes config_db.json", () => {
    S().loadVlanLab();
    const s = sw();
    expect(run(s, "config reload -y")).toContain("does not exist");
    expect(run(s, "config save -y")).toBe("Running command: /usr/local/bin/sonic-cfggen -d --print-data > /etc/sonic/config_db.json");
    expect(run(s, "config save")).toContain("Existing files will be overwritten, continue? [y/N]: y");
  });

  it("save → change → reload restores interfaces/VLANs/routes/features and OSPF re-converges", () => {
    S().loadFeatureLab("ospf");
    advance(60_000, 500);
    const s1 = byName("S1");
    const ospfRoute = () => live(s1).routingTable.find((r) => r.type === "ospf" && r.destination === "192.168.3.0");
    expect(ospfRoute()).toBeDefined();
    run(s1, "config save -y");
    const savedJson = run(s1, "show runningconfiguration all");

    // Drift from the saved config
    run(s1, "config interface ip add Ethernet3 10.9.9.1/24");
    run(s1, "config vlan add 50");
    run(s1, "config route add prefix 172.20.0.0/16 nexthop 10.9.9.2");
    run(s1, "config interface shutdown Ethernet2");
    run(s1, "config sflow enable");
    expect(run(s1, "redis-cli -n 4 exists VLAN|Vlan50 SFLOW|global INTERFACE|Ethernet3|10.9.9.1/24")).toBe("(integer) 3");

    const r = run(s1, "config reload -y");
    expect(r).toContain("Restarting SONiC target ...");
    const d = live(s1);
    expect(d.interfaces.find((i) => i.name === "Ethernet3")!.ipv4).toEqual([]);
    expect(d.interfaces.find((i) => i.name === "Ethernet2")!.adminState).toBe("up");
    expect(d.config.vlans ?? []).toEqual([]);
    expect(d.routingTable.some((x) => x.type === "static")).toBe(false);
    expect(d.config.features?.sflow).toBeUndefined();
    // daemons restarted: runtime gone, learned state flushed
    expect(d.config.features?.ospfd).toBeUndefined();
    expect(d.arpTable).toEqual([]);
    expect(ospfRoute()).toBeUndefined();
    expect(run(s1, "show runningconfiguration all")).toBe(savedJson);
    expect(run(s1, "redis-cli -n 0 exists ROUTE_TABLE:192.168.3.0/24")).toBe("(integer) 0");

    // OSPF re-converges from the restored config
    advance(90_000, 500);
    expect(ospfRoute()).toBeDefined();
    expect(run(s1, "sonic-db-cli APPL_DB hget ROUTE_TABLE:192.168.3.0/24 protocol")).toBe("ospf");
    const h1 = byName("H1");
    expect(run(h1, "ping -c 1 192.168.3.10")).toMatch(/1 (packets )?received/);
  });

  it("config load merges a named file without restarting daemons", () => {
    S().loadFeatureLab("ospf");
    advance(60_000, 500);
    const s1 = byName("S1");
    run(s1, "config vlan add 77");
    run(s1, "config save -y /etc/sonic/vlan77.json");
    run(s1, "config vlan del 77");
    expect(run(s1, "config load -y /etc/sonic/missing.json")).toContain("does not exist");
    expect(run(s1, "config load -y /etc/sonic/vlan77.json")).toBe("Running command: /usr/local/bin/sonic-cfggen -j /etc/sonic/vlan77.json --write-to-db");
    expect(live(s1).config.vlans?.map((v) => v.id)).toEqual([77]);
    expect(live(s1).config.features?.ospfd).toBeDefined(); // ospfd kept running
    expect(live(s1).routingTable.some((r) => r.type === "ospf")).toBe(true);
  });
});
