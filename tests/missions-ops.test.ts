/**
 * Security / operations lab missions (acl, copp, qos, snmp, arpnd): each fault
 * really breaks its outcome objective (not just a guard), and missions start
 * with every behaviour objective open.
 */
import "../lib/commands/sonic-cli/features";
import "../lib/labs";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetAll } from "./helpers";
import { S } from "./control-helpers";
import { settle, metIds } from "./mission-helpers";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 10, 19, 9, 0, 0));
  resetAll();
});
afterEach(() => vi.useRealTimers());

/** Objectives that must be open right after the lab (and fault) loaded. */
const OPEN_AT_START: Record<string, string[]> = {
  "acl-bind-and-count": ["bind", "debug-counter", "which-rule", "allow-ping"],
  "acl-trouble-order": ["ping"],
  "acl-trouble-direction": ["icmp-blocked", "http-blocked"],
  "copp-police-ip2me": ["read-policy", "flood", "transit", "tune"],
  "copp-trouble-arp": ["h1-h2", "gateway"],
  "copp-trouble-meter": ["ping-gw", "ssh"],
  "qos-ef-priority": ["baseline", "ef-queue", "strict", "congest"],
  "qos-trouble-trust": ["h2-ef", "map-intact"],
  "qos-trouble-speed": ["throughput"],
  "snmp-poll-and-trap": ["walk", "location", "rotate", "trap"],
  "snmp-trouble-agent": ["poll"],
  "snmp-trouble-traps": ["trap"],
  "arpnd-cache-aging": ["host-cache", "switch-cache", "timeout", "stale"],
  "arpnd-trouble-static": ["gateway"],
  "arpnd-trouble-duplicate": ["pc3-reachable", "unique"],
};
/** Guards that must already hold with the fault in place (they only catch a cheating fix). */
const MET_AT_START: Record<string, string[]> = {
  "acl-trouble-order": ["http-blocked", "bound"],
  "acl-trouble-direction": ["rest-allowed"],
  "copp-trouble-arp": ["ip2me-kept"],
  "copp-trouble-meter": ["still-policed"],
  "qos-trouble-speed": ["up"],
  "snmp-trouble-agent": ["others"],
  "snmp-trouble-traps": ["ports-up"],
  "arpnd-trouble-static": ["pc2-unchanged"],
};

describe("ops lab missions start broken for the right reason", () => {
  for (const [id, open] of Object.entries(OPEN_AT_START)) {
    it(id, () => {
      S().startMission(id);
      settle(45_000);
      const met = metIds();
      expect(met.filter((o) => open.includes(o)), `${id}: met at start`).toEqual([]);
      for (const g of MET_AT_START[id] ?? []) expect(met, `${id}: guard ${g}`).toContain(g);
    });
  }
});
