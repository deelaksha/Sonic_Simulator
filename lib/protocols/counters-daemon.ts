/**
 * Port counter polling (flex counters) + rates. SONiC polls port stats every
 * 1 s (sonic-swss orchagent/portsorch.cpp:80 PORT_STAT_FLEX_COUNTER_POLLING_INTERVAL_MS,
 * portsorch.h:38 PORT_RATE_FLEX_COUNTER_POLLING_INTERVAL_MS) and port_rates.lua
 * turns successive samples into RATES:<port> RX_BPS/RX_PPS/TX_BPS/TX_PPS:
 *   1st poll  store the counters only            (INIT_DONE = COUNTERS_LAST)
 *   2nd poll  rate = delta * 1000/interval        (unsmoothed, INIT_DONE = DONE)
 *   later     rate = alpha*new + (1-alpha)*old    (port_rates.lua:170-192)
 * alpha = 0.18 (smoothing interval 10 s, dockers/docker-orchagent/enable_counters.py:10-11).
 * Until a rate exists portstat prints N/A (utilities_common/portstat.py get_rates).
 *
 * The daemon also keeps a short per-poll history of the packet/drop totals so
 * `show interfaces counters -p <s>` can diff against the sample <s> seconds ago
 * (the simulator cannot sleep inside a command the way portstat does).
 *
 * Idle optimisation: when no port counter moved since the last poll and every
 * rate has decayed to zero the daemon goes quiet (nextDue = undefined) instead
 * of committing the network every second.
 */
import { Device, isRouter, isSwitch } from "../models/device";
import { NetInterface } from "../models/interface";
import { featureState, peekFeatureState } from "../models/feature-state";
import { registerDaemon } from "../control/daemon";
import { portDiscards } from "../control/drops";

export const POLL_MS = 1000;
export const RATE_ALPHA = 0.18;
const HISTORY = 30;

export interface PortRate {
  /** Octets/packets at the last poll (RATES:<port> *_last). */
  last: [rxOct: number, txOct: number, rxPkts: number, txPkts: number];
  init: "COUNTERS_LAST" | "DONE";
  rxBps?: number;
  rxPps?: number;
  txBps?: number;
  txPps?: number;
}

/** History sample: per port [rxOk, rxDrp, txOk, txDrp]. */
export interface CounterSample {
  t: number;
  p: Record<string, [number, number, number, number]>;
}

export interface CountersState {
  lastPollMs: number;
  ports: Record<string, PortRate>;
  history: CounterSample[];
}

/** Front-panel ports that have SAI port counters (COUNTERS_PORT_NAME_MAP). */
export function counterPorts(device: Device): NetInterface[] {
  if (!isSwitch(device.type) && !isRouter(device.type)) return [];
  return device.interfaces.filter((i) => !i.management && !i.logical);
}

export function peekCounters(device: Device): CountersState | undefined {
  return peekFeatureState<CountersState>(device, "counters");
}

function raw(i: NetInterface): [number, number, number, number] {
  const s = i.statistics;
  return [s.rxBytes, s.txBytes, s.rxFrames, s.txFrames];
}

function sample(device: Device, now: number): CounterSample {
  const p: CounterSample["p"] = {};
  for (const i of counterPorts(device)) {
    const d = portDiscards(device, i.name);
    p[i.name] = [i.statistics.rxFrames, d.rx, i.statistics.txFrames, d.tx];
  }
  return { t: now, p };
}

function quiescent(device: Device, st: CountersState): boolean {
  for (const i of counterPorts(device)) {
    const r = st.ports[i.name];
    if (!r || r.init !== "DONE") return false;
    if (raw(i).some((v, k) => v !== r.last[k])) return false;
    if (r.rxBps || r.rxPps || r.txBps || r.txPps) return false;
  }
  const h = st.history[st.history.length - 1];
  if (!h) return false;
  const now = sample(device, h.t).p;
  return Object.keys(now).every((k) => h.p[k] && now[k].every((v, j) => v === h.p[k][j]));
}

/** Snap a smoothed rate to 0 once it would print as 0.00 (keeps idle ports quiet). */
const snap = (v: number) => (v < 0.005 ? 0 : v);

export function pollCounters(device: Device, now: number): void {
  const st = featureState<CountersState>(device, "counters", () => ({ lastPollMs: 0, ports: {}, history: [] }));
  // port_rates.lua divides by the poll interval; after an idle gap the counters
  // moved within the last control tick, so the nominal 1 s interval applies.
  const delta = st.lastPollMs ? Math.min(now - st.lastPollMs, POLL_MS) || POLL_MS : POLL_MS;
  const scale = 1000 / delta;
  for (const i of counterPorts(device)) {
    const cur = raw(i);
    const r = st.ports[i.name];
    if (!r) {
      st.ports[i.name] = { last: cur, init: "COUNTERS_LAST" };
      continue;
    }
    const d = cur.map((v, k) => Math.max(0, v - r.last[k]) * scale);
    if (r.init === "DONE") {
      r.rxBps = snap(RATE_ALPHA * d[0] + (1 - RATE_ALPHA) * (r.rxBps ?? 0));
      r.txBps = snap(RATE_ALPHA * d[1] + (1 - RATE_ALPHA) * (r.txBps ?? 0));
      r.rxPps = snap(RATE_ALPHA * d[2] + (1 - RATE_ALPHA) * (r.rxPps ?? 0));
      r.txPps = snap(RATE_ALPHA * d[3] + (1 - RATE_ALPHA) * (r.txPps ?? 0));
    } else {
      [r.rxBps, r.txBps, r.rxPps, r.txPps] = d;
      r.init = "DONE";
    }
    r.last = cur;
  }
  for (const name of Object.keys(st.ports)) if (!counterPorts(device).some((i) => i.name === name)) delete st.ports[name];
  st.history.push(sample(device, now));
  if (st.history.length > HISTORY) st.history.splice(0, st.history.length - HISTORY);
  st.lastPollMs = now;
}

/** Totals sample taken at least `sec` seconds ago (undefined if history is too short). */
export function sampleAgo(device: Device, now: number, sec: number): CounterSample | undefined {
  const h = peekCounters(device)?.history ?? [];
  for (let k = h.length - 1; k >= 0; k--) if (h[k].t <= now - sec * 1000) return h[k];
  return undefined;
}

registerDaemon({
  id: "counters",
  nextDue(device, now) {
    if (device.state === "down" || counterPorts(device).length === 0) return undefined;
    const st = peekCounters(device);
    if (!st) return now;
    const due = st.lastPollMs + POLL_MS;
    if (due > now) return due;
    return quiescent(device, st) ? undefined : due;
  },
  tick(_ctx, device, now) {
    pollCounters(device, now);
    return true;
  },
});
