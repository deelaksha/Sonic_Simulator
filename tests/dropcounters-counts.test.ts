import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";
import { peekDrops } from "../lib/control/drops";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(30_000_000);
  resetAll();
});
afterEach(() => vi.useRealTimers());

/** Column value of a dropstat row. */
function cell(text: string, port: string, col: string): number {
  const lines = text.split("\n");
  const hdr = lines[0].trim().split(/\s{2,}/);
  const r = lines.find((l) => l.trim().startsWith(port + " "))!.trim().split(/\s{2,}/);
  return Number(r[hdr.indexOf(col)]);
}

describe("show dropcounters counts (dropstat)", () => {
  it("LPM4_MISS drops land in RX_DROPS / RX_DRP and in an installed debug counter", () => {
    S().loadFeatureLab("ospf");
    advance(25_000);
    const s1 = byName("S1").id;
    S().execCommand(s1, "exit");
    S().execCommand(byName("H1").id, "ping -c 2 203.0.113.9"); // no route on S1
    let text = out(S().execCommand(s1, "show dropcounters counts"));
    expect(text.split("\n")[0]).toMatch(/^\s+IFACE\s+STATE\s+RX_ERR\s+RX_DROPS\s+TX_ERR\s+TX_DROPS$/);
    const lpm = peekDrops(byName("S1"))!.Ethernet2!.LPM4_MISS!;
    expect(lpm).toBeGreaterThanOrEqual(2);
    expect(cell(text, "Ethernet2", "RX_DROPS")).toBe(lpm);
    expect(cell(out(S().execCommand(s1, "show interfaces counters")), "Ethernet2", "RX_DRP")).toBe(lpm);

    // a debug counter starts at 0 and then counts only its reasons
    expect(out(S().execCommand(s1, "config dropcounters install NOROUTE PORT_INGRESS_DROPS [LPM4_MISS] -a NO_ROUTE"))).toBe("");
    text = out(S().execCommand(s1, "show dropcounters counts"));
    expect(text.split("\n")[0]).toMatch(/TX_DROPS\s+NO_ROUTE$/);
    expect(cell(text, "Ethernet2", "NO_ROUTE")).toBe(0);
    S().execCommand(byName("H1").id, "ping -c 3 203.0.113.9");
    expect(cell(out(S().execCommand(s1, "show dropcounters counts")), "Ethernet2", "NO_ROUTE")).toBe(3);
    expect(out(S().execCommand(s1, "show dropcounters counts -t PORT_EGRESS_DROPS")).split("\n")[0]).toMatch(/STATE\s+TX_ERR\s+TX_DROPS$/);

    // sonic-clear dropcounters: checkpoint
    expect(out(S().execCommand(s1, "sonic-clear dropcounters"))).toBe("Cleared drop counters");
    text = out(S().execCommand(s1, "show dropcounters counts"));
    expect(cell(text, "Ethernet2", "RX_DROPS")).toBe(0);
    expect(cell(text, "Ethernet2", "NO_ROUTE")).toBe(0);
  });

  it("ACL drops are counted per port (ACL_ANY)", () => {
    S().loadFeatureLab("acl");
    advance(3_000);
    const s1 = byName("S1").id;
    S().runCliScript(s1, ["configure terminal", "interface Ethernet 2", "ip access-group H1-POLICY in", "end"]);
    S().execCommand(s1, "exit");
    S().execCommand(s1, "config dropcounters install ACLDROP PORT_INGRESS_DROPS ACL_ANY");
    S().execCommand(byName("H1").id, "ping -c 2 192.168.3.10");
    const text = out(S().execCommand(s1, "show dropcounters counts"));
    expect(cell(text, "Ethernet2", "ACLDROP")).toBe(2);
    expect(cell(text, "Ethernet2", "RX_DROPS")).toBeGreaterThanOrEqual(2);
  });

  it("STP-blocked port drops are counted as INGRESS_STP_FILTER", () => {
    const a = S().addDevice("switch", { x: 0, y: 0 }, 4);
    const b = S().addDevice("switch", { x: 100, y: 0 }, 4);
    const pc = S().addDevice("pc", { x: 0, y: 100 });
    const ifs = (id: string) => S().network.devices[id].interfaces;
    S().connect(a, ifs(a)[0].id, b, ifs(b)[0].id);
    S().connect(a, ifs(a)[1].id, b, ifs(b)[1].id); // redundant link → one port BLOCKING
    S().connect(pc, ifs(pc)[0].id, a, ifs(a)[2].id);
    S().setInterfaceIp(pc, ifs(pc)[0].id, "10.9.9.1", 24);
    for (const id of [a, b]) {
      S().execCommand(id, "exit");
      S().execCommand(id, "config dropcounters install STP PORT_INGRESS_DROPS INGRESS_STP_FILTER");
    }
    S().execCommand(pc, "ping -c 1 10.9.9.2"); // ARP broadcast floods over both links
    const blocked = [a, b].map((id) => {
      const text = out(S().execCommand(id, "show dropcounters counts"));
      return ["Ethernet0", "Ethernet1"].reduce((n, p) => n + cell(text, p, "STP"), 0);
    });
    expect(blocked[0] + blocked[1]).toBeGreaterThanOrEqual(1);
  });

  it("dropconfig validation, configuration and capabilities", () => {
    S().loadFeatureLab("ospf");
    const s1 = byName("S1").id;
    S().execCommand(s1, "exit");
    expect(out(S().execCommand(s1, "config dropcounters install X PORT_INGRESS_DROPS BOGUS"))).toBe(
      "Encountered error trying to install counter: One or more provided drop reason not supported on this device",
    );
    expect(out(S().execCommand(s1, "config dropcounters install X FOO_DROPS TTL"))).toBe("Encountered error trying to install counter: Counter type not supported on this device");
    S().execCommand(s1, "config dropcounters install DEBUG_0 PORT_INGRESS_DROPS TTL,LPM4_MISS -g G1 -d \"routing drops\"");
    expect(out(S().execCommand(s1, "config dropcounters install DEBUG_0 PORT_INGRESS_DROPS TTL"))).toBe(
      "Encountered error trying to install counter: Counter name 'DEBUG_0' already in use",
    );
    const cfg = out(S().execCommand(s1, "show dropcounters configuration")).split("\n");
    expect(cfg[0]).toMatch(/^Counter\s+Alias\s+Group\s+Type\s+Reasons\s+Description$/);
    expect(cfg[2]).toMatch(/^DEBUG_0\s+DEBUG_0\s+G1\s+PORT_INGRESS_DROPS\s+LPM4_MISS\s+"?routing/);
    expect(cfg[3].trim()).toBe("TTL");
    S().execCommand(s1, "config dropcounters remove-reasons DEBUG_0 TTL");
    expect(out(S().execCommand(s1, "show dropcounters configuration"))).not.toMatch(/\bTTL\b/);
    expect(out(S().execCommand(s1, "config dropcounters delete NOPE"))).toBe("Encountered error trying to uninstall counter: Counter 'NOPE' not found");
    const caps = out(S().execCommand(s1, "show dropcounters capabilities")).split("\n");
    expect(caps[0]).toMatch(/^Counter Type\s+Total$/);
    expect(caps).toContain("        LPM4_MISS");
  });

  it("KLISH dropcounters config feeds the same counters", () => {
    S().loadFeatureLab("ospf");
    advance(25_000);
    const s1 = byName("S1").id;
    S().runCliScript(s1, ["configure terminal", "dropcounters RT", "type PORT_INGRESS_DROPS", "add-reason LPM4_MISS", "end"]);
    S().execCommand(byName("H1").id, "ping -c 2 203.0.113.9");
    expect(out(S().execCommand(s1, "show interface dropcounters"))).toMatch(/Ethernet2\s+U\s+0\s+2\s+0\s+0/);
    S().execCommand(s1, "exit");
    expect(cell(out(S().execCommand(s1, "show dropcounters counts")), "Ethernet2", "RT")).toBe(2);
  });
});
