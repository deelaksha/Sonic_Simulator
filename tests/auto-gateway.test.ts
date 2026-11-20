/**
 * A router cabled in the editor with no address on that port becomes the PCs'
 * gateway automatically (.1 of their subnet), whichever end is cabled first.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { resetAll } from "./helpers";
import { S, out } from "./control-helpers";

const dev = (id: string) => S().network.devices[id];
const port = (id: string, n: number) => dev(id).interfaces.filter((i) => !i.management)[n];
const ip = (id: string, n = 0) => port(id, n).ipv4[0]?.address;
const gw = (id: string) => dev(id).config.defaultGateway;
const pcOn = (target: string, targetPort: number) => {
  const pc = S().addDevice("pc", { x: 0, y: 0 });
  S().connect(pc, port(pc, 0).id, target, port(target, targetPort).id, { autoDhcp: true });
  return pc;
};

describe("auto gateway on routers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    resetAll();
  });

  it("a PC cabled straight to a bare router port: the port takes .1, the PC uses it", () => {
    const r = S().addDevice("router", { x: 0, y: 0 });
    const pc = pcOn(r, 0);
    expect(ip(r)).toMatch(/^192\.168\.\d+\.1$/);
    expect(ip(pc)).toBe(ip(r).replace(/\.1$/, ".10"));
    expect(gw(pc)).toBe(ip(r));
    expect(out(S().execCommand(pc, `ping -c 2 ${ip(r)}`))).toContain("0% packet loss");
  });

  it("PCs on a switch first, router cabled later: router takes .1 of their subnet and every PC gets it", () => {
    const sw = S().addDevice("switch", { x: 0, y: 0 }, 4);
    const pcs = [pcOn(sw, 0), pcOn(sw, 1)];
    expect(pcs.map(gw)).toEqual([undefined, undefined]);
    const r = S().addDevice("router", { x: 0, y: 0 });
    S().connect(sw, port(sw, 2).id, r, port(r, 0).id, { autoDhcp: true });
    expect(ip(r)).toBe(ip(pcs[0]).replace(/\.\d+$/, ".1"));
    expect(pcs.map(gw)).toEqual([ip(r), ip(r)]);
    const late = pcOn(sw, 3);
    expect(gw(late)).toBe(ip(r));
    for (const pc of [...pcs, late]) expect(out(S().execCommand(pc, `ping -c 2 ${ip(r)}`))).toContain("0% packet loss");
  });

  it("two LANs on one router get different subnets and route to each other", () => {
    const r = S().addDevice("router", { x: 0, y: 0 });
    const a = pcOn(r, 0);
    const b = pcOn(r, 1);
    expect(ip(r, 0)).not.toBe(ip(r, 1));
    expect(ip(a).split(".")[2]).not.toBe(ip(b).split(".")[2]);
    expect(out(S().execCommand(a, `ping -c 2 ${ip(b)}`))).toContain("0% packet loss");
  });

  it("a router address set by hand is kept and the PC joins that subnet", () => {
    const r = S().addDevice("router", { x: 0, y: 0 });
    S().setInterfaceIp(r, port(r, 0).id, "10.9.9.254", 24);
    const pc = pcOn(r, 0);
    expect(ip(r)).toBe("10.9.9.254");
    expect(ip(pc)).toBe("10.9.9.10");
    expect(gw(pc)).toBe("10.9.9.254");
  });

  it("a router-to-router cable with no PCs gets no automatic address", () => {
    const r1 = S().addDevice("router", { x: 0, y: 0 });
    const r2 = S().addDevice("router", { x: 0, y: 0 });
    S().connect(r1, port(r1, 0).id, r2, port(r2, 0).id, { autoDhcp: true });
    expect(ip(r1)).toBeUndefined();
    expect(ip(r2)).toBeUndefined();
  });
});
