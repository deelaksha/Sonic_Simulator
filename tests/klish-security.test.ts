/**
 * KLISH `show` coverage for the security / AAA / remaining-features family:
 * TACACS+ / RADIUS, SNMP user/group/view/interface-traps, dot1x / MAB / authentication,
 * crypto, object-groups, per-interface ACL counters, PBF / ARS / TAM, DCBX statistics,
 * CoPP and QoS template layouts, PTP operational views, kdump / warm-restart / PoE.
 * Every assertion checks the real template layout rendered from live lab state.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features";
import "../lib/labs";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { S, byName, out } from "./control-helpers";
import { resetAll } from "./helpers";

const id = (n: string) => byName(n).id;
const show = (dev: string, cmd: string) => out(S().execCommand(id(dev), cmd));
const klish = (dev: string, lines: string[]) => S().runCliScript(id(dev), ["configure terminal", ...lines, "end"]);
const INCOMPLETE = "% Error: Incomplete command.";

beforeEach(() => {
  vi.useFakeTimers();
  resetAll();
});
afterEach(() => vi.useRealTimers());

describe("AAA servers", () => {
  beforeEach(() => S().loadFeatureLab("lacp"));

  it("show tacacs-server renders the global block and the host table with 4.5 defaults", () => {
    klish("S1", ["tacacs-server host 10.1.1.1 port 50 timeout 3", "tacacs-server timeout 7", "tacacs-server auth-type chap"]);
    const o = show("S1", "show tacacs-server");
    expect(o).toContain("TACACS Global Configuration");
    expect(o).toMatch(/^timeout {11}: 7$/m);
    expect(o).toMatch(/^auth-type {9}: chap$/m);
    expect(o).toMatch(/^key configured {4}: No$/m);
    expect(o).toMatch(/^HOST {17}AUTH-TYPE {7}KEY-CONFIG {3}PORT {7}PRIORITY {3}TIMEOUT {4}VRF/m);
    // auth-type falls back to the global (chap), priority 1, vrf default.
    expect(o).toMatch(/^10\.1\.1\.1 {13}chap {12}Yes {10}50 {9}1 {10}3 {10}default/m);
    expect(show("S1", "show tacacs-server host 10.9.9.9")).not.toContain("HOST");
    expect(show("S1", "show tacacs-server global")).not.toContain("HOST");
  });

  it("show radius-server renders globals, the server table and the statistics banner", () => {
    klish("S1", ["radius-server host 10.2.2.2 auth-port 1812 priority 2", "radius-server nas-ip 1.1.1.1", "radius-server statistics enable"]);
    const o = show("S1", "show radius-server");
    expect(o).toContain("RADIUS Global Configuration");
    expect(o).toMatch(/^nas-ip-addr {4}: 1\.1\.1\.1$/m);
    expect(o).toMatch(/^statistics {5}: True$/m);
    expect(o).toMatch(/^HOST {62}AUTH-TYPE {1}KEY-CONFIG/m);
    expect(o).toMatch(/^10\.2\.2\.2 +- {9}Yes {8}1812 {6}2 {8}- {7}- {5}- {16}- {15}UDP/m);
    expect(o).toContain("RADIUS Statistics");
    expect(show("S1", "show radius-server dynamic-author statistics")).toBe("");
  });

  it("show snmp-server user/group/view/interface-traps use the centered template headers", () => {
    klish("S1", ["snmp-server user u1 auth sha auth-password Pass1234 priv aes-128 priv-password Pass5678"]);
    const u = show("S1", "show snmp-server user");
    expect(u).toContain("           User Name                        Group Name              Auth    Privacy");
    expect(u).toMatch(/^u1 {31}None {29}sha {8}aes/m);
    expect(show("S1", "show snmp-server group")).toContain("   Group Name      Model: Security       Read View        Write View      Notify View   ");
    expect(show("S1", "show snmp-server view")).toContain("View Name");
    expect(show("S1", "show snmp-server interface-traps")).toMatch(/Interface Name\s+Status/);
  });
});

describe("port access control", () => {
  beforeEach(() => S().loadFeatureLab("lacp"));

  it("dot1x / mab / authentication reflect the stored config-plane lines", () => {
    expect(show("S1", "show dot1x")).toContain("Administrative Mode............... Disabled");
    klish("S1", [
      "dot1x system-auth-control",
      "authentication monitor",
      "mab request format attribute 1 groupsize 4 separator - lowercase",
      "interface Ethernet 2",
      "dot1x pae authenticator",
      "dot1x timeout quiet-period 30",
      "mab auth-type pap",
      "authentication port-control auto",
      "authentication host-mode multi-auth",
      "exit",
    ]);
    expect(show("S1", "show dot1x")).toContain("Administrative Mode............... Enabled");
    const d = show("S1", "show dot1x detail all");
    expect(d).toContain("Interface ..................................... Ethernet2");
    expect(d).toContain("PAE Capabilities .............................. authenticator");
    expect(d).toContain("Quiet Period(secs)............................. 30");
    expect(d).toContain("Server Timeout(secs) .......................... 30");
    const m = show("S1", "show mab");
    expect(m).toContain("MAB Request Fmt Attr1 Groupsize ........................... 4");
    expect(m).toContain("MAB Request Fmt Attr1 Separator............................ ietf(-)");
    expect(m).toContain("MAB Request Fmt Attr1 Case................................. lowercase");
    expect(m).toContain("mab_auth_type .................................. PAP");
    expect(show("S1", "show authentication")).toContain("Authentication Monitor Mode .................... Enabled");
    const a = show("S1", "show authentication interface Ethernet 2");
    expect(a).toContain("Port Control Mode.............................. auto");
    expect(a).toContain("Host Mode...................................... multi-auth");
    expect(show("S1", "show authentication interface all")).toContain("Interface ..................................... Ethernet2");
    expect(show("S1", "show authentication clients all")).toBe("");
    expect(show("S1", "show authentication rest")).toContain("client_auth: password,jwt");
  });
});

describe("crypto / object-groups / ACL counters", () => {
  it("crypto: no certificates installed, a stable per-switch SSH host key, containers print nothing", () => {
    S().loadFeatureLab("lacp");
    expect(show("S1", "show crypto")).toBe(""); // keyword container without ACTION: klish prints nothing
    expect(show("S1", "show crypto ca-cert all")).toBe("");
    expect(show("S1", "show crypto cert all")).toBe("");
    const k = show("S1", "show crypto ssh-key ecdsa");
    expect(k).toMatch(/^ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTY\S+ root@S1$/);
    expect(show("S1", "show crypto ssh-key ecdsa")).toBe(k);
    expect(show("S1", "show crypto ssh-key rsa")).toMatch(/^ssh-rsa AAAAB3NzaC1yc2E\S+ root@S1$/);
    expect(show("S1", "show object-groups")).toBe("");
  });

  it("show ip access-lists <acl> interface Ethernet <n> renders show_access_list_intf.j2 with live counters", () => {
    S().loadFeatureLab("acl");
    klish("S1", ["interface Ethernet 2", "ip access-group H1-POLICY in", "exit"]);
    out(S().execCommand(id("H1"), "ping -c 2 192.168.3.10"));
    vi.advanceTimersByTime(500);
    const o = show("S1", "show ip access-lists H1-POLICY interface Ethernet 2");
    expect(o.split("\n")[0]).toBe("interface Ethernet2");
    expect(o).toContain("   ip access-list H1-POLICY at Ingress");
    expect(o).toMatch(/^ {6}seq 10 deny icmp host 192\.168\.1\.10 host 192\.168\.3\.10 \([1-9]\d* packets\) \[\d+ bytes\]$/m);
    expect(show("S1", "show ip access-lists H1-POLICY interface Ethernet 3")).toBe("%Error: Resource not found");
  });
});

describe("PBF / ARS / TAM / DCBX", () => {
  beforeEach(() => S().loadFeatureLab("lacp"));

  it("containers print nothing; unconfigured groups/profiles print nothing", () => {
    for (const c of ["show pbf", "show ars", "show tam"]) expect(show("S1", c)).toBe(""); // containers: no ACTION, no output
    expect(show("S1", "show pbf next-hop-group status")).toBe(INCOMPLETE); // missing mandatory Switch|interface
    for (const c of ["show pbf next-hop-group", "show pbf replication-group status Switch", "show ars profile", "show ars bind", "show ars nhg-statistics"]) expect(show("S1", c)).toBe("");
  });

  it("TAM feature views carry the configured switch-id", () => {
    klish("S1", ["tam", "switch-id 5", "exit"]);
    const o = show("S1", "show tam ifa");
    expect(o).toContain("Status               : Inactive");
    expect(o).toContain("Switch ID            : 5");
    expect(o).toContain("Version              : 2.0");
    expect(show("S1", "show tam features")).toMatch(/^Name {12}Status\n-{14} {2}-{9}\ndrop-monitor {4}Inactive/);
    expect(show("S1", "show tam drop-monitor sessions")).toBe("Sessions are not configured.");
  });

  it("show dcbx statistics interface Ethernet 0 and the two-word show dcbx interface filter", () => {
    const o = show("S1", "show dcbx statistics interface Ethernet 0");
    expect(o).toMatch(/^DCBX Statistics\n-{63}\nInterface {22}: Ethernet0\nTransmitted PFC {16}: 0/);
    klish("S1", ["dcbx enable", "interface Ethernet 1", "dcbx enable", "exit"]);
    expect(show("S1", "show dcbx interface Ethernet 1")).toMatch(/^Ethernet1\s+Enabled/m);
  });
});

describe("CoPP / QoS template layouts", () => {
  it("show copp classifiers/actions/policy use the KLISH indentation; bare show copp prints nothing", () => {
    S().loadFeatureLab("copp");
    show("S1", "sonic-cli");
    expect(show("S1", "show copp")).toBe("");
    expect(show("S1", "show copp classifiers")).toBe("Class-map copp-lab-ip2me match-type copp\n  protocol ip2me");
    expect(show("S1", "show copp actions")).toBe("CoPP action group copp-lab-ip2me\n    trap-action trap\n    trap-queue 7\n    police cir 50 cbs 50");
    expect(show("S1", "show copp policy")).toBe(
      "Policy copp-system-policy Type copp\n  Flow copp-lab-ip2me\n    Action copp-lab-ip2me\n      trap-action trap\n      trap-queue 7\n      police cir 50 cbs 50",
    );
    expect(show("S1", "show copp protocols").split("\n")[1]).toBe("  protocol arp_req");
  });

  it("show qos maps / policies / interface Ethernet <n> render from the QoS config", () => {
    S().loadFeatureLab("qos");
    show("S1", "sonic-cli");
    expect(show("S1", "show qos")).toBe("");
    expect(show("S1", "show qos map dscp-tc")).toBe(
      ["DSCP-TC-MAP: LAB-DSCP", "-".repeat(28), "DSCP TC   ", "-".repeat(28), "10   1    ", "26   3    ", "46   5    ", "-".repeat(28)].join("\n"),
    );
    expect(show("S1", "show qos map dot1p-tc")).toBe("");
    expect(show("S1", "show qos scheduler-policy")).toBe(" Scheduler Policy: LAB-STRICT\n   Queue: 5\n              type: strict");
    expect(show("S1", "show qos wred-policy LAB-WRED")).toContain("green-min-threshold    : 100         KBytes");
    const i = show("S1", "show qos interface Ethernet 0");
    expect(i).toContain("    dscp-tc-map: LAB-DSCP");
    expect(i).toContain("          PFC Watchdog");
    expect(i).toMatch(/^ {12}Restoration Time {2}: infinite\(0ms\)$/m);
    expect(show("S1", "show qos interface Ethernet 1 queue 3")).toBe("interface queue 3 config:\n    WRED profile: ");
    expect(show("S1", "show qos interface Ethernet 1 priority-flow-control statistics")).toMatch(/^Ethernet1 {17}0 {14}0/m);
  });
});

describe("PTP / kdump / warm-restart / PoE operational forms", () => {
  beforeEach(() => S().loadFeatureLab("lacp"));

  it("show ptp parent/time-property/servo: empty without PTP, free-running clock once a mode is set", () => {
    expect(show("S1", "show ptp parent")).toBe("");
    klish("S1", ["ptp mode boundary-clock", "ptp priority1 100"]);
    const p = show("S1", "show ptp parent");
    expect(p).toMatch(/^Parent Clock Identity {10}([0-9a-f]{2}:){3}ff:fe(:[0-9a-f]{2}){3}$/m);
    expect(p).toMatch(/^Grandmaster Priority1 {10}100$/m);
    expect(p).toMatch(/^Grandmaster Clock Class {8}248$/m);
    expect(show("S1", "show ptp time-property")).toMatch(/^PTP Timescale {8}True$/m);
    expect(show("S1", "show ptp servo")).toBe("Servo State           Unlocked\nLock Status           Free-run");
  });

  it("kdump files, warm-restart check and PoE port info answer like the real platform", () => {
    expect(show("S1", "show kdump files")).toBe("No kernel core dump files");
    expect(show("S1", "show warm-restart check")).toMatch(/^-{62}\nModule {4}Pending Entry/);
    expect(show("S1", "show poe port")).toBe(INCOMPLETE);
    expect(show("S1", "show poe port info all")).toBe("%Error: Resource not found");
  });
});
