import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "../lib/labs";
import { BfdApi, BfdState, bfd, setBfdImpl } from "../lib/control/bfd-api";
import { peekBgpRuntime } from "../lib/protocols/bgp-daemon";
import { resetAll } from "./helpers";
import { S, advance, byName } from "./control-helpers";

// Stand-in BFD daemon: the test decides the session state (the real bfdd is a separate module).
let bfdState: BfdState = "up";
const registered: string[] = [];
const fake: BfdApi = {
  register: (_d, key) => void registered.push(key.peer),
  unregister: () => {},
  state: () => bfdState,
};
let original: BfdApi;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
  original = bfd();
  setBfdImpl(fake);
  bfdState = "up";
  registered.length = 0;
  S().loadFeatureLab("bgp");
});
afterEach(() => {
  setBfdImpl(original);
  vi.useRealTimers();
});

describe("neighbor <ip> bfd", () => {
  it("registers with BFD and tears the session down on BFD up→down (Cease/BFD Down)", () => {
    for (const cmd of ["configure terminal", "router bgp 65001", "neighbor 10.0.12.2", "bfd", "end"]) S().execCommand(byName("S1").id, cmd);
    advance(300);
    expect(registered).toContain("10.0.12.2");
    const p = () => peekBgpRuntime(byName("S1"))!.peers["10.0.12.2"];
    expect(p().state).toBe("Established");
    bfdState = "down";
    advance(200);
    expect(p().lastReset).toMatchObject({ reason: "BFD down received", notify: { code: 6, subcode: 10, dir: "sent" } });
    expect(peekBgpRuntime(byName("S2"))!.peers["10.0.12.1"].lastReset?.notify).toEqual({ code: 6, subcode: 10, dir: "received" });
  });
});
