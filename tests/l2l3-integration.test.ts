/** Cross-feature checks: ACL bound to an LACP PortChannel (members chosen by the LAG hash). */
import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(20_000_000);
  resetAll();
});
afterEach(() => vi.useRealTimers());

const sh = (dev: string, cmd: string) => out(S().execCommand(byName(dev).id, cmd));

describe("ACL on an LACP PortChannel", () => {
  it("frames arriving on any LAG member match the PortChannel's ACL; unbinding restores traffic", () => {
    S().loadFeatureLab("lacp");
    advance(5_000); // LACP fast rate converges
    expect(sh("H1", "ping -c 2 192.168.10.13")).toMatch(/2 received/);

    const errs = S().runCliScript(byName("S2").id, [
      "configure terminal",
      "ip access-list NO-PING",
      "seq 10 deny icmp host 192.168.10.11 any",
      "seq 20 permit ip any any",
      "exit",
      "interface PortChannel 1",
      "ip access-group NO-PING in",
      "end",
    ]);
    expect(errs).toEqual([]);
    expect(sh("H1", "ping -c 3 192.168.10.13")).not.toMatch(/[1-3] received/);
    expect(sh("H2", "ping -c 1 192.168.10.13")).toMatch(/1 received/); // other source still allowed
    expect(sh("S2", "show ip access-lists NO-PING")).toMatch(/seq 10 deny icmp host 192\.168\.10\.11 any \(3 packets\)/);

    S().runCliScript(byName("S2").id, ["configure terminal", "interface PortChannel 1", "no ip access-group NO-PING in", "end"]);
    expect(sh("H1", "ping -c 1 192.168.10.13")).toMatch(/1 received/);
  });
});
