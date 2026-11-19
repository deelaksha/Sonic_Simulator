/** KLISH interface IGMP config (igmp.xml) and the `mcast` host tool's argument handling. */
import "../lib/commands/sonic-cli/features";
import "../lib/labs";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetAll } from "./helpers";
import { S, byName, out } from "./control-helpers";
import { cpList } from "../lib/commands/sonic-cli/config-plane";

const id = (dev: string) => byName(dev).id;
function klish(dev: string, ...cmds: string[]): string {
  if (!(S().cliMode[id(dev)] ?? ["exec"]).length) S().execCommand(id(dev), "sonic-cli");
  return cmds.map((c) => out(S().execCommand(id(dev), c))).join("\n");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
  S().loadFeatureLab("multicast");
});
afterEach(() => vi.useRealTimers());

describe("KLISH ip igmp", () => {
  it("stores IGMP_INTERFACE_QUERY and renders show running-configuration igmp", () => {
    klish("S3", "configure terminal", "interface Vlan 30", "ip igmp query-interval 60", "ip igmp last-member-query-count 3", "end");
    expect(cpList(byName("S3"), "igmp", "interfaces")).toEqual([{ iface: "Vlan30", enabled: true, version: 2, queryInterval: 60, lastMemberQueryCount: 3 }]);
    const t = klish("S3", "show running-configuration igmp");
    expect(t).toContain("interface Vlan30\n ip igmp\n ip igmp version 2\n ip igmp query-interval 60\n ip igmp last-member-query-count 3");
    klish("S3", "configure terminal", "interface Vlan 30", "no ip igmp query-interval", "end");
    expect(klish("S3", "show running-configuration igmp")).not.toContain("query-interval");
  });

  it("rejects out-of-range values and leaves snooping commands to the snooping module", () => {
    expect(klish("S3", "configure terminal", "interface Vlan 30", "ip igmp version 4")).toContain("IGMP version must be 2 or 3");
    klish("S3", "ip igmp snooping fast-leave", "end");
    expect(klish("S3", "show ip igmp snooping vlan 30")).toContain("Is Fast-Leave Enabled: Enabled");
  });

  it("no ip igmp disables IGMP on the interface", () => {
    klish("S3", "configure terminal", "interface Vlan 30", "no ip igmp", "end");
    expect(cpList(byName("S3"), "igmp", "interfaces")).toEqual([]);
  });
});

describe("mcast tool", () => {
  it("validates the group and the device type", () => {
    expect(out(S().execCommand(id("H3"), "mcast join 10.1.1.1"))).toContain("not an IPv4 multicast address");
    expect(out(S().execCommand(id("H3"), "mcast join 224.0.0.5"))).toContain("link-local control group");
    expect(out(S().execCommand(id("H3"), "mcast join 239.1.1.1 -I eth9"))).toContain("eth9: no such device");
    S().execCommand(id("S1"), "exit");
    expect(out(S().execCommand(id("S1"), "mcast show"))).toContain("run it on a host");
  });

  it("maddr lists 224.0.0.1 and joined groups like ip maddr", () => {
    S().execCommand(id("H3"), "mcast join 239.1.1.1");
    expect(out(S().execCommand(id("H3"), "mcast maddr"))).toBe("2:\teth0\n\tlink  01:00:5e:01:01:01\n\tlink  01:00:5e:00:00:01\n\tinet  239.1.1.1\n\tinet  224.0.0.1");
  });
});
