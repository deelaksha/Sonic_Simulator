/**
 * QoS / CoPP rows of CONFIG_DB, APPL_DB and COUNTERS_DB, rendered from the
 * simulator's QoS store (features["qos"], lib/commands/sonic/qos.ts), PFC store
 * (features["pfc"]), CoPP store (features["copp"], lib/protocols/cpu-traps.ts)
 * and the counters the QoS model / CPU path keep (features["qos-queues"],
 * ["cpu-queues"], ["copp-runtime"]).
 *
 * CONFIG_DB (sonic-buildimage/src/sonic-yang-models/yang-models):
 *   DSCP_TO_TC_MAP|<name>   sonic-dscp-tc-map.yang:29-60   one field per DSCP: "<dscp>": "<tc>"
 *   TC_TO_QUEUE_MAP|<name>  sonic-tc-queue-map.yang:29-55  "<tc>": "<qindex>"
 *   SCHEDULER|<policy>@<q>  sonic-scheduler.yang:29-69 type STRICT|DWRR|WRR, weight, meter_type;
 *                           the "<policy>@<seq>" key and default meter_type "bytes" are the
 *                           mgmt-framework scheduler-policy transformer's (sonic-mgmt-common
 *                           translib/transformer/xfmr_qos.go:2790-2815, 3297-3311;
 *                           klish-xml qos_scheduler.xml:39 view_keys name=<policy>@<seq>)
 *   WRED_PROFILE|<name>     sonic-wred-profile.yang:44-166 <color>_min_threshold / _max_threshold
 *                           (bytes) / _drop_probability, wred_<color>_enable (xfmr_qos.go:2309-2329)
 *   PORT_QOS_MAP|<port>     sonic-port-qos-map.yang:97-161 dscp_to_tc_map, tc_to_queue_map, pfc_enable
 *   QUEUE|<port>|<q>        sonic-queue.yang:53-89 scheduler "<policy>@<q>" (xfmr_qos.go:3297-3330),
 *                           wred_profile
 *   COPP_GROUP|<name>       sonic-copp.yang:65-186 (only what the CLI wrote; the image defaults live
 *   COPP_TRAP|<name>        in /etc/sonic/copp_cfg.json, merged by coppmgrd, not in CONFIG_DB)
 *                           trap_ids "a,b", trap_group (xfmr_copp.go:1020-1021)
 * No APPL_DB QoS tables: qosorch consumes CONFIG_DB directly (sonic-swss orchagent/orchdaemon.cpp:340-357).
 *
 * APPL_DB COPP_TABLE:<group>  coppmgrd (sonic-swss cfgmgr/coppmgr.cpp:370-401): copp_cfg.json groups
 *   merged with CONFIG_DB, plus trap_ids = the group's enabled trap ids (coppmgr.h:15). A group whose
 *   traps are all feature-disabled is pending and not written (coppmgr.cpp checkTrapGroupPending).
 *
 * COUNTERS_DB (sonic-swss-common common/schema.h:213-223):
 *   COUNTERS_QUEUE_NAME_MAP "<port>:<idx>" -> queue oid, COUNTERS_QUEUE_PORT_MAP oid -> port oid,
 *   COUNTERS_QUEUE_INDEX_MAP oid -> idx, COUNTERS_QUEUE_TYPE_MAP oid -> SAI_QUEUE_TYPE_UNICAST|MULTICAST
 *   (orchagent/portsorch.cpp:7847-7927; UC0-7 + MC8-15 per front port, the CPU port's queues are
 *   MULTICAST 0-7 as `show queue counters CPU` renders them), COUNTERS:<queue oid> with the
 *   queue_stat_ids SAI_QUEUE_STAT_PACKETS/BYTES/DROPPED_PACKETS/DROPPED_BYTES/TRIM_PACKETS
 *   (portsorch.cpp:300-307).
 *   COUNTERS_TRAP_NAME_MAP trap id -> generic counter oid (copporch.cpp:1452-1456) and
 *   COUNTERS:<counter oid> SAI_COUNTER_STAT_PACKETS / SAI_COUNTER_STAT_BYTES (trap flow counters,
 *   as `show copp counters` reads them).
 *
 * Read-only: never creates feature state (peek accessors only).
 */
import { Device } from "../models/device";
import { peekFeatureState } from "../models/feature-state";
import type { QosState } from "../commands/sonic/qos";
import type { PfcState } from "../commands/sonic/qospfc";
import type { QueueCounters } from "../protocols/qos-model";
import { CoppGroup, CoppState, DEFAULT_GROUPS, DEFAULT_TRAPS, defaultTrapFor, resolveTrap } from "../protocols/cpu-traps";
import type { CpuQueues, CoppRuntime } from "../protocols/cpu-daemon";
import { Tables, put, Row } from "./schema";
import { frontPorts } from "./config-db";
import { oid, portOid } from "./asic-db";

const str = (v: unknown) => String(v);
const SCHED_TYPE: Record<string, string> = { strict: "STRICT", dwrr: "DWRR", wrr: "WRR" };

export function projectQosConfig(d: Device, t: Tables): void {
  const qos = peekFeatureState<QosState>(d, "qos");
  for (const m of qos?.dscpTcMaps ?? []) put(t, "DSCP_TO_TC_MAP", m.name, Object.fromEntries(m.entries.map((e) => [str(e.key), str(e.value)])));
  for (const m of qos?.tcQueueMaps ?? []) put(t, "TC_TO_QUEUE_MAP", m.name, Object.fromEntries(m.entries.map((e) => [str(e.key), str(e.value)])));
  for (const p of qos?.schedulers ?? []) {
    for (const q of p.queues) {
      const row: Row = { meter_type: "bytes", type: SCHED_TYPE[q.type] ?? q.type.toUpperCase() };
      if (q.weight !== undefined) row.weight = str(q.weight);
      put(t, "SCHEDULER", `${p.name}@${q.queue}`, row);
    }
  }
  for (const w of qos?.wredPolicies ?? []) {
    const row: Row = {};
    for (const c of w.colors) {
      row[`${c.color}_min_threshold`] = str(c.min * 1024); // kbytes in the CLI, bytes in CONFIG_DB
      row[`${c.color}_max_threshold`] = str(c.max * 1024);
      row[`${c.color}_drop_probability`] = str(c.prob);
      row[`wred_${c.color}_enable`] = "true";
    }
    put(t, "WRED_PROFILE", w.name, row);
  }
  const pfc = peekFeatureState<PfcState>(d, "pfc");
  const ports = new Set([...Object.keys(qos?.interfaces ?? {}), ...Object.keys(pfc?.interfaces ?? {})]);
  for (const port of [...ports].sort()) {
    const b = qos?.interfaces[port];
    const row: Row = {};
    if (b?.dscpTc) row.dscp_to_tc_map = b.dscpTc;
    if (b?.tcQueue) row.tc_to_queue_map = b.tcQueue;
    const prios = pfc?.interfaces[port]?.priorities ?? [];
    if (prios.length) row.pfc_enable = [...prios].sort((a, c) => a - c).join(",");
    if (Object.keys(row).length) put(t, "PORT_QOS_MAP", port, row);
    const sched = b?.schedulerPolicy ? qos?.schedulers.find((p) => p.name === b.schedulerPolicy) : undefined;
    for (let q = 0; q < 8; q++) {
      const qr: Row = {};
      if (sched?.queues.some((x) => x.queue === q)) qr.scheduler = `${sched.name}@${q}`;
      if (b?.wredPolicy) qr.wred_profile = b.wredPolicy;
      if (Object.keys(qr).length) put(t, "QUEUE", `${port}|${q}`, qr);
    }
  }
}

export function projectCoppConfig(d: Device, t: Tables): void {
  const st = peekFeatureState<CoppState>(d, "copp");
  for (const a of st?.actions ?? []) {
    const row: Row = {};
    if (a.trapAction !== undefined) row.trap_action = a.trapAction;
    if (a.trapPriority !== undefined) row.trap_priority = str(a.trapPriority);
    if (a.trapQueue !== undefined) row.queue = str(a.trapQueue);
    if (a.meterType !== undefined) row.meter_type = a.meterType;
    if (a.cir !== undefined) row.cir = str(a.cir);
    if (a.cbs !== undefined) row.cbs = str(a.cbs);
    put(t, "COPP_GROUP", a.name, row);
  }
  for (const b of st?.bindings ?? []) {
    const c = st?.classifiers.find((x) => x.name === b.classifier);
    if (c && c.protocols.length) put(t, "COPP_TRAP", c.name, { trap_ids: c.protocols.join(","), trap_group: b.action });
  }
}

function groupRow(p: CoppGroup): Row {
  const row: Row = { trap_action: p.trapAction };
  if (p.trapPriority !== undefined) row.trap_priority = str(p.trapPriority);
  row.queue = str(p.queue);
  if (p.cir !== undefined) {
    row.meter_type = p.meterType;
    if (p.mode) row.mode = p.mode;
    row.cir = str(p.cir);
    row.cbs = str(p.cbs ?? p.cir);
    if (p.redAction) row.red_action = p.redAction;
  }
  return row;
}

/** APPL_DB COPP_TABLE as coppmgrd writes it (copp_cfg.json defaults merged with the CLI's groups). */
export function projectCoppAppl(d: Device, t: Tables): void {
  const st = peekFeatureState<CoppState>(d, "copp");
  const groups = new Map<string, CoppGroup>(Object.entries(DEFAULT_GROUPS));
  for (const a of st?.actions ?? []) {
    // coppmgrd skips a group with no fields (coppmgr.cpp:393 trap_group_fvs.empty())
    if (a.trapAction === undefined && a.trapQueue === undefined && a.trapPriority === undefined && a.cir === undefined) continue;
    groups.set(a.name, {
      trapAction: a.trapAction ?? "trap", trapPriority: a.trapPriority, queue: a.trapQueue ?? 0, meterType: a.meterType ?? "packets",
      mode: "sr_tcm", cir: a.cir, cbs: a.cir !== undefined ? (a.cbs ?? a.cir) : undefined, redAction: "drop",
    });
  }
  // every trap id the defaults or the CLI know, in COPP_TRAP order
  const ids = [...new Set([...Object.values(DEFAULT_TRAPS).flatMap((e) => e.trapIds), ...(st?.classifiers ?? []).flatMap((c) => c.protocols)])];
  const installed = new Map<string, string[]>();
  for (const id of ids) {
    const g = resolveTrap(d, id)?.group;
    if (g) installed.set(g, [...(installed.get(g) ?? []), id]);
  }
  for (const [name, p] of groups) {
    const refs = Object.values(DEFAULT_TRAPS).filter((e) => e.group === name);
    const pending = refs.length > 0 && refs.every((e) => !defaultTrapFor(d, e.trapIds[0])?.installed) && !installed.has(name);
    if (pending) continue;
    const row = groupRow(p);
    const tids = installed.get(name);
    if (tids?.length) row.trap_ids = tids.join(",");
    put(t, "COPP_TABLE", name, row);
  }
}

const QUEUE_T = 0x15; // SAI_OBJECT_TYPE_QUEUE (saitypes.h:211)
const COUNTER_T = 0x54; // SAI_OBJECT_TYPE_COUNTER (saitypes.h:274)
const portIdx = (name: string) => Number(/(\d+)$/.exec(name)?.[1] ?? 0) + 1;

export function projectQosCounters(d: Device, t: Tables): void {
  const qc = peekFeatureState<QueueCounters>(d, "qos-queues") ?? {};
  const names: Row = {};
  const ports: Row = {};
  const index: Row = {};
  const types: Row = {};
  const queue = (port: string, portO: string, n: number, idx: number, type: string, c?: { pkts: number; bytes: number; dropPkts: number; dropBytes: number }) => {
    const o = oid(QUEUE_T, n);
    names[`${port}:${idx}`] = o;
    ports[o] = portO;
    index[o] = str(idx);
    types[o] = `SAI_QUEUE_TYPE_${type}`;
    put(t, "COUNTERS", o, {
      SAI_QUEUE_STAT_PACKETS: str(c?.pkts ?? 0),
      SAI_QUEUE_STAT_BYTES: str(c?.bytes ?? 0),
      SAI_QUEUE_STAT_DROPPED_PACKETS: str(c?.dropPkts ?? 0),
      SAI_QUEUE_STAT_DROPPED_BYTES: str(c?.dropBytes ?? 0),
      SAI_QUEUE_STAT_TRIM_PACKETS: "0",
    });
  };
  const fp = frontPorts(d);
  if (!fp.length) return;
  for (const p of fp) {
    for (let q = 0; q < 16; q++) queue(p.name, portOid(p.name), portIdx(p.name) * 16 + q, q, q < 8 ? "UNICAST" : "MULTICAST", q < 8 ? qc[p.name]?.[q] : undefined);
  }
  const cpu = peekFeatureState<CpuQueues>(d, "cpu-queues") ?? {};
  for (let q = 0; q < 8; q++) queue("CPU", oid(0x1, 0), q, q, "MULTICAST", cpu[str(q)]);
  put(t, "COUNTERS_QUEUE_NAME_MAP", "", names);
  put(t, "COUNTERS_QUEUE_PORT_MAP", "", ports);
  put(t, "COUNTERS_QUEUE_INDEX_MAP", "", index);
  put(t, "COUNTERS_QUEUE_TYPE_MAP", "", types);

  const traps = peekFeatureState<CoppRuntime>(d, "copp-runtime")?.traps ?? {};
  const tnames = Object.keys(traps).sort();
  if (!tnames.length) return;
  const map: Row = {};
  for (const n of tnames) {
    let h = 7;
    for (const ch of n) h = (h * 31 + ch.charCodeAt(0)) % 0xfffff; // stable per trap name
    const o = oid(COUNTER_T, h + 1);
    map[n] = o;
    put(t, "COUNTERS", o, { SAI_COUNTER_STAT_PACKETS: str(traps[n].pkts), SAI_COUNTER_STAT_BYTES: str(traps[n].bytes) });
  }
  put(t, "COUNTERS_TRAP_NAME_MAP", "", map);
}
