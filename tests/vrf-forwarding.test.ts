import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { registerLab } from "../lib/labs";
import { routedTriangle } from "../lib/labs/topologies";
import { resetAll } from "./helpers";
import { S, byName, out } from "./control-helpers";

registerLab("test-vrf-triangle", (api) => routedTriangle(api));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(5_000_000);
  resetAll();
  S().loadFeatureLab("test-vrf-triangle");
  // S1: Vrf-red = Ethernet2 (H1's LAN) + Ethernet1 (link to S3); Ethernet0 (to S2) stays default.
  S().runCliScript(byName("S1").id, [
    "configure terminal",
    "ip vrf Vrf-red",
    "interface Ethernet 2",
    "ip vrf forwarding Vrf-red",
    "exit",
    "interface Ethernet 1",
    "ip vrf forwarding Vrf-red",
    "end",
  ]);
  for (const s of ["S1", "S3"]) S().execCommand(byName(s).id, "exit");
});
afterEach(() => vi.useRealTimers());

const sh = (dev: string, cmd: string) => out(S().execCommand(byName(dev).id, cmd));

describe("VRF: separate routing tables in the forwarding engine", () => {
  it("connected routes move into the VRF's table; show ip route vrf / all", () => {
    const red = sh("S1", "show ip route vrf Vrf-red");
    expect(red).toContain("IPv4 unicast VRF Vrf-red:");
    expect(red).toMatch(/C>\* 192\.168\.1\.0\/24 is directly connected, Ethernet2/);
    expect(red).toMatch(/C>\* 10\.0\.13\.0\/30 is directly connected, Ethernet1/);
    const def = sh("S1", "show ip route");
    expect(def).toMatch(/C>\* 10\.0\.12\.0\/30 is directly connected, Ethernet0/);
    expect(def).not.toContain("192.168.1.0/24");
    expect(sh("S1", "show ip route vrf all")).toMatch(/VRF default:[\s\S]*VRF Vrf-red:/);
    expect(sh("S1", "show ip route vrf nope")).toContain("% VRF nope not found");
  });

  it("local delivery and ping are per VRF (ping -I <vrf>)", () => {
    expect(sh("H1", "ping -c 1 192.168.1.1")).toMatch(/1 received/); // gateway answers in Vrf-red
    expect(sh("S1", "ping -c 1 192.168.1.10")).not.toMatch(/1 received/); // default VRF has no route
    expect(sh("S1", "ping -c 1 -I Vrf-red 192.168.1.10")).toMatch(/1 received/);
    expect(sh("S1", "ping -c 1 -I Vrf-blue 192.168.1.10")).toContain("unknown VRF");
  });

  it("static routes in the VRF carry H1↔H3; the default VRF stays isolated", () => {
    S().runCliScript(byName("S1").id, ["configure terminal", "ip route vrf Vrf-red 192.168.3.0/24 10.0.13.2", "end"]);
    S().runCliScript(byName("S3").id, ["configure terminal", "ip route 192.168.1.0/24 10.0.13.1", "end"]);
    expect(sh("S1", "show ip route vrf Vrf-red")).toMatch(/S>\* 192\.168\.3\.0\/24 \[1\/0\] via 10\.0\.13\.2, Ethernet1/);
    expect(sh("H1", "ping -c 2 192.168.3.10")).toMatch(/2 received/);
    // A default-VRF route to the same prefix does not leak into Vrf-red traffic, and vice versa.
    S().runCliScript(byName("S1").id, ["configure terminal", "ip route 192.168.1.0/24 10.0.12.2", "end"]);
    expect(sh("H1", "ping -c 1 10.0.12.2")).not.toMatch(/1 received/); // S2 is only reachable from the default VRF
    // Removing the VRF deletes its routes; interfaces fall back to the default table.
    S().execCommand(byName("S1").id, "sudo config vrf del Vrf-red");
    expect(sh("S1", "show ip route")).toMatch(/C>\* 192\.168\.1\.0\/24 is directly connected, Ethernet2/);
    expect(sh("S1", "show ip route")).not.toMatch(/192\.168\.3\.0\/24 \[1\/0\] via 10\.0\.13\.2/);
  });
});
