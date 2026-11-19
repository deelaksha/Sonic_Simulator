/**
 * Link state tracking on the l2-protect lab: group UPLINK (timeout 10) tracks
 * SW1 Ethernet5 (uplink to SW2) and controls Ethernet0 (the Client).
 */
import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "../lib/labs";
import { peekSyslog } from "../lib/control/syslog";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";

const id = (n: string) => byName(n).id;
const sh = (dev: string, cmd: string) => out(S().execCommand(id(dev), cmd));
const klish = (dev: string, lines: string[]) => S().runCliScript(id(dev), ["configure terminal", ...lines, "end"]);
const port = (dev: string, name: string) => byName(dev).interfaces.find((i) => i.name === name)!;
const logs = (dev: string) => (peekSyslog(byName(dev))?.lines ?? []).map((l) => l.message).join("\n");
const uplink = (up: boolean) => S().setAdminState(id("SW2"), port("SW2", "Ethernet5").id, up);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
  S().loadFeatureLab("l2-protect");
});
afterEach(() => vi.useRealTimers());

describe("link state tracking", () => {
  it("upstream down → downstream Ethernet0 brought down (Client loses link); restored 10 s after upstream returns", () => {
    expect(port("SW1", "Ethernet0").operState).toBe("up");
    uplink(false);
    advance(200);
    expect(port("SW1", "Ethernet5").operState).toBe("down");
    expect(port("SW1", "Ethernet0").operState).toBe("down");
    expect(port("SW1", "Ethernet0").adminState).toBe("up"); // not a shutdown: running config unchanged
    expect(byName("Client").interfaces[0].operState).toBe("down");
    expect(logs("SW1")).toContain("Link state tracking group UPLINK: all upstream interfaces down, bringing down Ethernet0 downstream interfaces");
    expect(sh("SW1", "show link state tracking UPLINK")).toBe(
      ["Name: UPLINK", "Description:", "Timeout: 10", "Upstream Interfaces:", "    Ethernet5 (Down)", "Downstream Interfaces:", "    Ethernet0 (Down)"].join("\n"),
    );

    uplink(true);
    advance(5000);
    expect(port("SW1", "Ethernet0").operState).toBe("down"); // still inside the 10 s timeout
    advance(5200);
    expect(port("SW1", "Ethernet0").operState).toBe("up");
    expect(byName("Client").interfaces[0].operState).toBe("up");
    expect(logs("SW1")).toContain("Link state tracking group UPLINK: upstream up, bringing up Ethernet0 downstream interfaces");
  });

  it("an upstream flap shorter than the timeout restarts the recovery timer", () => {
    uplink(false);
    advance(200);
    uplink(true);
    advance(6000);
    uplink(false);
    advance(200);
    uplink(true);
    advance(6000);
    expect(port("SW1", "Ethernet0").operState).toBe("down");
    advance(4500);
    expect(port("SW1", "Ethernet0").operState).toBe("up");
  });

  it("a port no longer bound downstream is not touched; default timeout is 60 s", () => {
    klish("SW1", ["interface Ethernet 0", "no link state track UPLINK downstream", "exit", "link state track UPLINK", "no timeout"]);
    expect(sh("SW1", "show link state tracking UPLINK")).toContain("Timeout: 60");
    uplink(false);
    advance(200);
    expect(port("SW1", "Ethernet0").operState).toBe("up");
  });
});
