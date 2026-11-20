/** Click `show runningconfiguration ...` / `show startupconfiguration ...` (lib/commands/sonic/runcfg.ts). */
import "../lib/commands/sonic-cli/features";
import "../lib/labs";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";

let id = "";
const run = (cmd: string) => out(S().execCommand(id, cmd));
const json = (cmd: string) => JSON.parse(run(cmd));

function lab(name: string, dev: string) {
  S().loadFeatureLab(name);
  advance(5000);
  id = byName(dev).id;
  S().execCommand(id, "exit"); // KLISH -> bash
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
});
afterEach(() => vi.useRealTimers());

describe("show runningconfiguration (lacp lab)", () => {
  beforeEach(() => lab("lacp", "S1"));

  it("bare groups print the Click group usage", () => {
    const t = run("show runningconfiguration");
    expect(t.split("\n")[0]).toBe("Usage: show runningconfiguration [OPTIONS] COMMAND [ARGS]...");
    expect(t).toContain("  Show current running configuration information");
    for (const c of ["acl", "all", "bgp", "copp", "interfaces", "ntp", "ports", "snmp", "spanning-tree", "syslog"]) expect(t).toMatch(new RegExp(`^  ${c} +Show`, "m"));
    expect(run("show startupconfiguration")).toMatch(/^Usage: show startupconfiguration \[OPTIONS\] COMMAND \[ARGS\]\.\.\.[\s\S]*^  bgp +Show BGP startup configuration$/m);
  });

  it("AliasedGroup: unique prefixes resolve, ambiguous/unknown ones are Click errors", () => {
    expect(json("show runningconfiguration po Ethernet0")).toHaveProperty("Ethernet0");
    expect(run("show runningconfiguration s")).toContain("Error: Too many matches: snmp, spanning-tree, syslog");
    expect(run("show runningconfiguration foo")).toContain('Error: No such command "foo".');
  });

  it("all: CONFIG_DB JSON follows live config, plus bgpraw", () => {
    let j = json("show runningconfiguration all");
    expect(j.VLAN.Vlan10.vlanid).toBe("10");
    expect(j.VLAN_MEMBER["Vlan10|Ethernet2"]).toEqual({ tagging_mode: "untagged" });
    expect(j.VLAN.Vlan30).toBeUndefined();
    expect(j.bgpraw).toMatch(/^Building configuration\.\.\.\n\nCurrent configuration:\n!\nfrr version/);

    run("config vlan add 30");
    run("config vlan member add 30 Ethernet3");
    j = json("show runningconfiguration all");
    expect(j.VLAN.Vlan30.vlanid).toBe("30");
    expect(j.VLAN_MEMBER["Vlan30|Ethernet3"]).toEqual({ tagging_mode: "tagged" });
  });

  it("ports [<port>]: PORT table, filtered by --key", () => {
    const all = json("show runningconfiguration ports");
    expect(Object.keys(all)).toEqual(["Ethernet0", "Ethernet1", "Ethernet2", "Ethernet3"]);
    expect(json("show runningconfiguration ports Ethernet2")).toEqual({ Ethernet2: all.Ethernet2 });
    expect(json("show runningconfiguration ports Ethernet99")).toEqual({});
    run("config interface shutdown Ethernet2");
    expect(json("show runningconfiguration ports Ethernet2").Ethernet2.admin_status).toBe("down");
  });

  it("tables absent from CONFIG_DB print nothing (sonic-cfggen --var-json)", () => {
    expect(run("show runningconfiguration acl")).toBe("");
    expect(run("show runningconfiguration spanning-tree")).toBe("");
  });

  it("ntp / syslog: server lists from NTP_SERVER / SYSLOG_SERVER", () => {
    expect(run("show runningconfiguration ntp")).toBe("NTP Servers\n-------------");
    run("config ntp add 10.0.0.5");
    expect(run("show runningconfiguration ntp")).toBe("NTP Servers\n-------------\n10.0.0.5");
    run("config syslog add 10.0.0.9");
    expect(run("show runningconfiguration syslog")).toBe("Syslog Servers\n----------------\n[10.0.0.9]");
  });

  it("snmp stays owned by snmp.ts", () => {
    expect(run("show runningconfiguration snmp")).toContain("Community String");
  });
});

describe("interfaces / bgp / startupconfiguration (bgp lab)", () => {
  beforeEach(() => lab("bgp", "S1"));

  it("interfaces [<ifname>]: INTERFACE table, --key returns the first matching key", () => {
    const all = json("show runningconfiguration interfaces");
    expect(all).toHaveProperty(["Ethernet0|10.0.12.1/30"]);
    expect(json("show runningconfiguration interfaces Ethernet0")).toEqual({ Ethernet0: {} });
    expect(json("show runningconfiguration interfaces loopback-action")).toEqual({});
    run("config interface ip add Ethernet3 10.9.9.1/24");
    expect(json("show runningconfiguration interfaces")).toHaveProperty(["Ethernet3|10.9.9.1/24"]);
  });

  it("bgp: vtysh show running-config bgp from live BGP config", () => {
    const t = run("show runningconfiguration bgp");
    expect(t).toMatch(/^router bgp 65001\n bgp router-id 1\.1\.1\.1\n neighbor 10\.0\.12\.2 remote-as 65002$/m);
    expect(t).toMatch(/ address-family ipv4 unicast\n  network 192\.168\.1\.0\/24\n exit-address-family\nexit\n!\nend$/);
    run("config router bgp neighbor 10.0.14.2 remote-as 65004");
    expect(run("show runningconfiguration bgp")).toContain(" neighbor 10.0.14.2 remote-as 65004");
    expect(json("show runningconfiguration all").bgpraw).toContain("neighbor 10.0.14.2 remote-as 65004");
  });

  it("startupconfiguration bgp: the saved config once `config save` ran", () => {
    expect(run("show startupconfiguration bgp")).toMatch(/^Routing-Stack is: frr\n[\s\S]*router bgp 65001/);
    run("config save -y");
    run("config router bgp neighbor 10.0.14.2 remote-as 65004");
    expect(run("show startupconfiguration bgp")).not.toContain("10.0.14.2");
    expect(run("show runningconfiguration bgp")).toContain("10.0.14.2");
  });
});
