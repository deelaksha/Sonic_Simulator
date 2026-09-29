import { describe, it, expect } from "vitest";
import { lan2, routed } from "./helpers";
import { Simulation } from "../lib/engine";

describe("ICMP / ping (spec §16)", () => {
  it("pings across a switch and derives timing from the journey", () => {
    const { state } = lan2();
    const summary = new Simulation(state).runPing("pc1", "192.168.1.20", { count: 2 });
    expect(summary.received).toBe(2);
    expect(summary.replies[0].success).toBe(true);
    expect(summary.replies[0].ttl).toBe(64);
    expect(summary.replies[0].rttMs).toBeGreaterThan(0);
    // first probe pays the ARP cost, second is cached and therefore faster
    expect(summary.replies[0].rttMs!).toBeGreaterThan(summary.replies[1].rttMs!);
  });

  it("fails with 'no-route' for an unreachable network", () => {
    const { state } = lan2();
    const summary = new Simulation(state).runPing("pc1", "10.0.0.1", { count: 1 });
    expect(summary.received).toBe(0);
    expect(summary.replies[0].reason).toBe("no-route");
  });
});

describe("router forwarding (spec §9, §10)", () => {
  it("routes between subnets and decrements TTL", () => {
    const { state } = routed();
    const sim = new Simulation(state);
    const summary = sim.runPing("pc1", "192.168.2.10", { count: 1 });

    expect(summary.received).toBe(1);
    // reply arrives back at PC1 with TTL decremented once by the router
    expect(summary.replies[0].ttl).toBe(63);
    expect(sim.events.some((e) => e.type === "TTL_DECREMENT")).toBe(true);
  });

  it("builds a NEW Ethernet frame at the router (spec §10)", () => {
    const { state } = routed();
    const sim = new Simulation(state);
    sim.runPing("pc1", "192.168.2.10", { count: 1 });

    // The echo request as PC1 sent it vs. as the router forwarded it.
    const sent = sim.events.find(
      (e) => e.type === "FRAME_SENT" && e.deviceId === "pc1" && e.frame?.icmp?.type === "echo-request",
    );
    const forwarded = sim.events.find(
      (e) => e.type === "FRAME_SENT" && e.deviceId === "r1" && e.frame?.icmp?.type === "echo-request",
    );
    expect(sent && forwarded).toBeTruthy();
    // Same L3 endpoints...
    expect(sent!.frame!.ipv4!.srcIp).toBe(forwarded!.frame!.ipv4!.srcIp);
    // ...but different L2 framing and a decremented TTL.
    expect(forwarded!.frame!.ethernet.srcMac).not.toBe(sent!.frame!.ethernet.srcMac);
    expect(forwarded!.frame!.ipv4!.ttl).toBe(sent!.frame!.ipv4!.ttl - 1);
  });

  it("traceroute discovers each hop via TTL (spec §17)", () => {
    const { state } = routed();
    const sim = new Simulation(state);
    const trace = sim.runTraceroute("pc1", "192.168.2.10", { maxHops: 5 });

    expect(trace.hops.length).toBe(2);
    expect(trace.hops[0].fromIp).toBe("192.168.1.1"); // router replies TTL-exceeded
    expect(trace.hops[1].reached).toBe(true);
    expect(trace.hops[1].fromIp).toBe("192.168.2.10"); // destination
  });
});
