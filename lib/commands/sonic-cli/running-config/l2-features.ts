/**
 * Running-config sections: ACLs, sFlow, SNMP, QoS, CoPP actions, mirror
 * sessions, storm-control, DHCP snooping, DHCP relay, UDLD, errdisable,
 * IGMP snooping, spanning-tree (see ./registry.ts).
 *
 * Sources (sonic-mgmt-framework CLI unless noted):
 *   ACL           renderer/templates/show_acl_running_config.j2 (list, remark, seq … [remark]);
 *                 bindings in the interface block (show_interface_running_config.j2:411)
 *   sFlow         actioner/sonic_cli_sflow.py show_sflow_running_* (as features/sflow.ts)
 *   SNMP          features/snmp.ts showRunning (snmp.xml DOCGEN order)
 *   QoS           renderer/templates/show_qos_{maps,scheduler_policy,wred}_config.j2,
 *                 interface bindings show_interface_running_config.j2:437-473;
 *                 WRED line syntax from data/device-capture/klish-xml/wred.xml:100-119
 *   CoPP          renderer/templates/show_running_config_copp_action.j2 (printed with the
 *                 FBS sections: sonic_cli_show_config.py show_all_fbs_config)
 *   mirror        renderer/show_config_mirror.py:69-94
 *   others        the KLISH syntax each feature handler accepts (data/device-capture/klish-xml)
 */
import { Device } from "../../../models/device";
import { peekFeatureState } from "../../../models/feature-state";
import { AclState, ruleData, AclType } from "../../../protocols/acl-rules";
import { peekSflowState, DEFAULT_COLLECTOR_PORT } from "../../../sflow/agent";
import { peekSnmpConfig } from "../../../protocols/snmp-config";
import { QosState } from "../../sonic/qos";
import { CoppState } from "../../../protocols/cpu-traps";
import { cpGet, cpList } from "../config-plane";
import { showRunning as snmpRunning } from "../features/snmp";
import { renderRunning as stpRunning, renderIntf as stpIntf } from "../features/stp";
import { registerRcSection, natCompare, isSet } from "./registry";

// --- ACL ---------------------------------------------------------------------
function aclLists(dev: Device, type: AclType): string[][] {
  const st = peekFeatureState<AclState>(dev, "acl");
  const tables = (st?.tables ?? []).filter((t) => (t.type ?? "ip") === type).sort((a, b) => a.name.localeCompare(b.name));
  const blocks: string[][] = tables.map((t) => {
    const b = [`${type} access-list ${t.name}`];
    if (t.description) b.push(` remark ${t.description}`);
    for (const r of [...(st!.rules[t.name] ?? [])].sort((a, c) => a.seq - c.seq)) b.push(` seq ${r.seq} ${ruleData(type, r)}${r.remark ? ` remark ${r.remark}` : ""}`);
    return b;
  });
  // Global (Switch) binding — show_global_access_group_running_config; printed after the
  // lists here so the ACL exists when the line is replayed.
  const glob = tables.filter((t) => t.ports.includes("Switch")).map((t) => `${type} access-group ${t.name} ${(t.stage ?? "ingress").toLowerCase() === "egress" ? "out" : "in"}`);
  if (glob.length) blocks.push(glob);
  return blocks;
}
function aclBindings(dev: Device, name: string, type: AclType): string[] {
  const st = peekFeatureState<AclState>(dev, "acl");
  return (st?.tables ?? [])
    .filter((t) => (t.type ?? "ip") === type && t.ports.includes(name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => ` ${type} access-group ${t.name} ${(t.stage ?? "ingress").toLowerCase() === "egress" ? "out" : "in"}`);
}
// Order deviation (replay-driven): the source prints ACLs after the interfaces
// (show_all_config → show_acl_running_config), but an interface `ip access-group`
// needs the ACL to exist, so the lists go before the interface blocks.
for (const [type, order] of [["ip", 46], ["ipv6", 47], ["mac", 48]] as const) {
  registerRcSection({
    id: `acl-${type}`,
    order,
    keywords: [[type, "access-list"]],
    global: (dev) => aclLists(dev, type),
    iface: (dev, name) => aclBindings(dev, name, type),
    ifOrder: 120,
  });
}

// --- sFlow (features/sflow.ts `show running-configuration sflow` branch) ----
registerRcSection({
  id: "sflow",
  order: 130,
  keywords: [["sflow"]],
  global(dev) {
    const st = peekSflowState(dev);
    const out: string[] = [];
    if (st?.enabled) out.push("sflow enable");
    if (st?.pollingInterval !== undefined) out.push(`sflow polling-interval ${st.pollingInterval}`);
    if (st?.agentId) out.push(`sflow agent-id ${st.agentId}`);
    if (st?.sampleRate !== undefined) out.push(`sflow sampling-rate ${st.sampleRate}`);
    for (const c of st?.collectors ?? []) out.push(`sflow collector ${c.ip}${c.port !== DEFAULT_COLLECTOR_PORT ? ` ${c.port}` : ""} vrf ${c.vrf}`);
    return out.length ? [out] : [];
  },
  iface(dev, name) {
    const cfg = peekSflowState(dev)?.interfaces?.[name];
    if (!cfg || cfg.enabled === false || (cfg.enabled === undefined && cfg.sampleRate === undefined)) return [];
    return [" sflow enable", ...(cfg.sampleRate !== undefined ? [` sflow sampling-rate ${cfg.sampleRate}`] : [])];
  },
  ifOrder: 130,
});

// --- SNMP --------------------------------------------------------------------
registerRcSection({
  id: "snmp",
  order: 150,
  keywords: [["snmp"]],
  global(dev) {
    const lines = snmpRunning(peekSnmpConfig(dev)).map((o) => o.text).filter((t) => t !== "!");
    return lines.length ? [lines] : [];
  },
});

// --- QoS ---------------------------------------------------------------------
const qos = (dev: Device) => peekFeatureState<QosState>(dev, "qos");
// Order deviation (replay-driven): the source prints QoS after the interfaces
// (show_all_config → show_qos_config), but `qos-map dscp-tc <map>` in an interface
// block needs the map to exist, so maps/WRED policies go before the interfaces.
registerRcSection({
  id: "qos",
  order: 45,
  keywords: [["qos"]],
  global(dev) {
    const q = qos(dev);
    if (!q) return [];
    const byVal = (e: { key: number; value: number }[]) => [...e].sort((a, b) => a.value - b.value || a.key - b.key);
    const blocks: string[][] = [];
    for (const m of [...(q.dscpTcMaps ?? [])].sort((a, b) => a.name.localeCompare(b.name))) blocks.push([`qos map dscp-tc ${m.name}`, ...byVal(m.entries).map((e) => ` dscp ${e.key} traffic-class ${e.value}`)]);
    for (const m of [...(q.tcQueueMaps ?? [])].sort((a, b) => a.name.localeCompare(b.name))) blocks.push([`qos map tc-queue ${m.name}`, ...byVal(m.entries).map((e) => ` traffic-class ${e.key} queue ${e.value}`)]);
    for (const w of [...(q.wredPolicies ?? [])].sort((a, b) => a.name.localeCompare(b.name))) {
      blocks.push([`qos wred-policy ${w.name}`, ...w.colors.map((c) => ` ${c.color} minimum-threshold ${c.min} maximum-threshold ${c.max} drop-probability ${c.prob}`)]);
    }
    return blocks;
  },
  iface(dev, name) {
    const b = qos(dev)?.interfaces?.[name];
    if (!b) return [];
    const out: string[] = [];
    if (b.schedulerPolicy) out.push(` scheduler-policy ${b.schedulerPolicy}`);
    if (b.dscpTc) out.push(` qos-map dscp-tc ${b.dscpTc}`);
    if (b.tcQueue) out.push(` qos-map tc-queue ${b.tcQueue}`);
    // QUEUE|<port>|0-7 wred_profile (every queue) → one line per queue.
    if (b.wredPolicy) for (let i = 0; i < 8; i++) out.push(` queue ${i} wred-policy ${b.wredPolicy}`);
    return out;
  },
  ifOrder: 150,
});

// Scheduler policies (show_qos_scheduler_policy_config.j2), printed right after the
// maps/WRED policies. Note: the simulator's KLISH has no `qos scheduler-policy`
// sub-mode yet (features/qos.ts), so these lines do not replay.
registerRcSection({
  id: "qos-scheduler",
  order: 45.5,
  keywords: [["qos", "scheduler-policy"]],
  global(dev) {
    return [...(qos(dev)?.schedulers ?? [])]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => {
        const b = [`qos scheduler-policy ${s.name}`];
        for (const qu of [...s.queues].sort((a, c) => a.queue - c.queue)) {
          b.push(" !", ` queue ${qu.queue}`, `  type ${qu.type}`);
          if (qu.weight !== undefined) b.push(`  weight ${qu.weight}`);
        }
        return b;
      });
  },
});

// --- CoPP action groups ------------------------------------------------------
// Printed with the FBS sections, before the interfaces (show_all_fbs_config). Note:
// the simulator's `copp-action` (features/copp.ts) enters no sub-mode yet, so the
// `set …`/`police …` lines do not replay.
registerRcSection({
  id: "copp",
  order: 42,
  keywords: [["copp-action"]],
  global(dev) {
    const st = peekFeatureState<CoppState>(dev, "copp");
    return [...(st?.actions ?? [])]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((g) => {
        const b = [`copp-action ${g.name}`];
        if (g.trapAction) b.push(` set trap-action ${g.trapAction.toLowerCase()}`);
        if (g.trapPriority !== undefined) b.push(` set trap-priority ${g.trapPriority}`);
        if (g.trapQueue !== undefined) b.push(` set trap-queue ${g.trapQueue}`);
        if (g.cir !== undefined) b.push(` police cir ${g.cir}${g.cbs !== undefined ? ` cbs ${g.cbs}` : ""}`);
        if (g.meterType) b.push(` police meter-type ${String(g.meterType).toLowerCase()}`);
        return b;
      });
  },
});

// --- spanning-tree (features/stp.ts renderRunning; interface lines merged) ----
registerRcSection({
  id: "stp",
  order: 25,
  keywords: [["spanning-tree"]],
  global(dev) {
    if (!cpGet(dev, "stp")) return [];
    const lines = stpRunning(dev).map((o) => o.text);
    const cut = lines.findIndex((l) => l.startsWith("interface "));
    const blocks: string[][] = [[]];
    for (const l of cut >= 0 ? lines.slice(0, cut) : lines) {
      if (l === "!") blocks.push([]);
      else if (!l.startsWith("%")) blocks[blocks.length - 1].push(l);
    }
    return blocks.filter((b) => b.length);
  },
  iface(dev, name) {
    const it = cpList(dev, "stp", "interfaces").find((i) => i.ifname === name);
    return it ? stpIntf(it).map((t) => ` ${t}`) : [];
  },
  ifOrder: 195,
});

// --- mirror sessions (show_config_mirror.py) ---------------------------------
registerRcSection({
  id: "mirror",
  order: 210,
  keywords: [["mirror-session"]],
  global(dev) {
    return (cpList(dev, "mirror", "sessions") as Record<string, string>[]).map((s) => {
      const b = [`mirror-session ${s.name}`];
      // Interface names kept joined ("Ethernet4"): the simulator's mirror handler takes
      // the destination as one token (the source splits it, "Ethernet 4").
      let cmd = "";
      if (s.type === "erspan") {
        cmd = "destination erspan";
        for (const [k, f] of [["dst-ip", "dst_ip"], ["src-ip", "src_ip"], ["dscp", "dscp"], ["gre", "gre"], ["ttl", "ttl"], ["queue", "queue"]]) if (s[f]) cmd += ` ${k} ${s[f]}`;
      } else if (s.dst) cmd = `destination ${s.dst === "CPU" ? "cpu" : s.dst}`;
      if (cmd && s.src) cmd += ` source ${s.src}`;
      if (cmd && s.direction) cmd += ` direction ${s.direction.toLowerCase()}`;
      if (cmd) b.push(` ${cmd}`);
      return b;
    });
  },
});

// --- storm-control (interface) -----------------------------------------------
const STORM_ORDER = ["broadcast", "unknown-multicast", "unknown-unicast"];
registerRcSection({
  id: "storm-control",
  order: 215,
  keywords: [["storm-control"]],
  iface(dev, name) {
    return (cpList(dev, "storm_control", "ports") as Record<string, string>[])
      .filter((e) => e.iface === name)
      .sort((a, b) => STORM_ORDER.indexOf(a.type) - STORM_ORDER.indexOf(b.type))
      .map((e) => ` storm-control ${e.type} ${e.kbps}`);
  },
  ifOrder: 185,
});

// --- DHCP snooping -----------------------------------------------------------
registerRcSection({
  id: "dhcp-snooping",
  order: 220,
  keywords: [["dhcp-snooping"], ["ip", "dhcp", "snooping"]],
  global(dev) {
    const st = cpGet(dev, "dhcp_snooping");
    if (!st) return [];
    const out: string[] = [];
    for (const [fam, kw] of [["v4", "ip"], ["v6", "ipv6"]] as const) {
      if (st[`${fam}_enabled`]) out.push(`${kw} dhcp snooping`);
      for (const v of cpList(dev, "dhcp_snooping", `${fam}_vlans`)) out.push(`${kw} dhcp snooping ${v.vlan}`);
      if (st[`${fam}_verify_mac`]) out.push(`${kw} dhcp snooping verify mac-address`);
    }
    return out.length ? [out] : [];
  },
  iface(dev, name) {
    const out: string[] = [];
    for (const [fam, kw] of [["v4", "ip"], ["v6", "ipv6"]] as const) if (cpList(dev, "dhcp_snooping", `${fam}_trust`).some((t) => t.iface === name)) out.push(` ${kw} dhcp snooping trust`);
    return out;
  },
  ifOrder: 187,
});

// --- DHCP relay (interface `ip dhcp-relay <server>`) -------------------------
registerRcSection({
  id: "dhcp-relay",
  order: 225,
  keywords: [["ip", "dhcp-relay"]],
  iface(dev, name) {
    const m = peekFeatureState<Record<string, string[]>>(dev, "dhcpRelay");
    return (m?.[name] ?? []).map((s) => ` ip dhcp-relay ${s}`);
  },
  ifOrder: 75,
});

// --- UDLD --------------------------------------------------------------------
registerRcSection({
  id: "udld",
  order: 230,
  keywords: [["udld"]],
  global(dev) {
    const st = cpGet(dev, "udld");
    if (!st) return [];
    const out: string[] = [];
    if (st.enable) out.push("udld enable");
    if (st.aggressive) out.push("udld aggressive");
    if (isSet(st.msg_time)) out.push(`udld message-time ${st.msg_time}`);
    if (isSet(st.multiplier)) out.push(`udld multiplier ${st.multiplier}`);
    return out.length ? [out] : [];
  },
  iface(dev, name) {
    const p = cpList(dev, "udld", "ports").find((x) => x.ifname === name);
    if (!p) return [];
    return [...(p.admin_enable ? [" udld enable"] : []), ...(p.aggressive ? [" udld aggressive"] : [])];
  },
  ifOrder: 190,
});

// --- errdisable --------------------------------------------------------------
registerRcSection({
  id: "errdisable",
  order: 250,
  keywords: [["errdisable"]],
  global(dev) {
    const st = cpGet(dev, "errdisable");
    if (!st) return [];
    const out = cpList(dev, "errdisable", "causes")
      .map((c) => String(c.cause))
      .sort()
      .map((c) => `errdisable recovery cause ${c}`);
    if (isSet(st.interval)) out.push(`errdisable recovery interval ${st.interval}`);
    return out.length ? [out] : [];
  },
});

// --- IGMP snooping (Vlan interface block) ------------------------------------
registerRcSection({
  id: "igmp-snooping",
  order: 205,
  keywords: [["igmp-snooping"], ["ip", "igmp", "snooping"]],
  iface(dev, name) {
    const r = cpList(dev, "igmp_snooping", "vlans").find((v) => v.vlan === name) as
      | { querier?: boolean; fastLeave?: boolean; queryInterval?: number; lastMemberQueryInterval?: number; maxResponseTime?: number; version?: number; mrouters?: string[]; staticGroups?: { group: string; intf: string }[] }
      | undefined;
    if (!r) return [];
    const out = [" ip igmp snooping"];
    if (r.querier) out.push(" ip igmp snooping querier");
    if (r.fastLeave) out.push(" ip igmp snooping fast-leave");
    if (r.queryInterval !== undefined) out.push(` ip igmp snooping query-interval ${r.queryInterval}`);
    if (r.lastMemberQueryInterval !== undefined) out.push(` ip igmp snooping last-member-query-interval ${r.lastMemberQueryInterval}`);
    if (r.maxResponseTime !== undefined) out.push(` ip igmp snooping query-max-response-time ${r.maxResponseTime}`);
    if (r.version !== undefined) out.push(` ip igmp snooping version ${r.version}`);
    for (const m of [...(r.mrouters ?? [])].sort(natCompare)) out.push(` ip igmp snooping mrouter interface ${m}`);
    for (const g of r.staticGroups ?? []) out.push(` ip igmp snooping static-group ${g.group} interface ${g.intf}`);
    return out;
  },
  ifOrder: 192,
});
