/**
 * MCLAG — KLISH config + show. The ICCP session, role, system-ID rewrite, MAC
 * sync and peer-link isolation run in lib/protocols/mclag-daemon.ts (iccpd).
 *
 *   sonic(config)# mclag domain <1-4095>          create domain + enter sub-view
 *   sonic(config-mclag-domain)# source-ip <ip>    store MCLAG_DOMAIN fields
 *   sonic(config-mclag-domain)# peer-ip <ip>
 *   sonic(config-mclag-domain)# peer-link <if>
 *   sonic(config-mclag-domain)# keepalive-interval <secs>
 *   sonic(config-mclag-domain)# session-timeout <secs>
 *   sonic(config-mclag-domain)# delay-restore <secs>
 *   sonic(config-mclag-domain)# mclag-system-mac <mac>
 *   sonic(config-mclag-domain)# session-vrf <vrf>
 *   sonic(config-mclag-domain)# fast-convergence
 *   sonic(config-mclag-domain)# backup-keepalive source-ip|peer-ip|interval|session-vrf <v>
 *   sonic(config-mclag-domain)# no <any of the above>            clear a field
 *   sonic(config)# mclag gateway-mac <mac>        MCLAG_GW_MAC scalar
 *   sonic(config)# no mclag domain <id>           remove a whole domain
 *   sonic(conf-if-po1)# [no] mclag <domain>       MCLAG_INTERFACE (device interface.xml:1436-1443)
 *   sonic# show mclag [brief]                      show_mclag_brief.j2 (sonic_cli_mclag.py:357-399)
 *   sonic# show mclag interface <po-id> <domain>   show_mclag_iface.j2 (sonic_cli_mclag.py:326-353)
 *
 * Mirrors the real box's sonic-mclag MCLAG_DOMAIN_LIST / MCLAG_INTERFACE_LIST /
 * MCLAG_GW_MAC CONFIG_DB tables (see data/device-capture/klish-xml/mclag.xml).
 * Operational fields (Role, Session Status, Peer Link Status, System Mac,
 * Local/Remote status) come from the iccpd runtime; Role/Session Status stay blank
 * until the first session (no MCLAG_TABLE row yet). keepalive/session-timeout show
 * their defaults 1/30 s when unset (sonic_cli_mclag.py:368-371). `show mclag mac`,
 * `separate-ip-interfaces`, `peer-gateway-interfaces` are not handled.
 */
import { OutputLine, line, err, muted } from "../../types";
import { registerModal } from "../registry";
import { cpSet, cpUnset, cpUpsert, cpRemove, cpList, cpGet } from "../config-plane";
import { subViewFrame } from "../../../sonic/grammar";
import { Device, interfaceByName } from "../../../models/device";
import { localSystemId, mclagConfig, mclagRuntime } from "../../../protocols/mclag-daemon";

// KLISH sub-command -> MCLAG_DOMAIN_LIST field (single-value fields).
const DOMAIN_FIELDS: Record<string, { field: string; numeric?: boolean }> = {
  "source-ip": { field: "source_ip" },
  "peer-ip": { field: "peer_ip" },
  "session-vrf": { field: "session_vrf" },
  "peer-link": { field: "peer_link" },
  "mclag-system-mac": { field: "mclag_system_mac" },
  "keepalive-interval": { field: "keepalive_interval", numeric: true },
  "session-timeout": { field: "session_timeout", numeric: true },
  "delay-restore": { field: "delay_restore", numeric: true },
};

// `backup-keepalive <sub>` -> MCLAG_DOMAIN_LIST field.
const BK_FIELDS: Record<string, { field: string; numeric?: boolean }> = {
  "source-ip": { field: "backup_keepalive_source_ip" },
  "peer-ip": { field: "backup_keepalive_peer_ip" },
  interval: { field: "backup_keepalive_interval", numeric: true },
  "session-vrf": { field: "backup_keepalive_session_vrf" },
};

/** Merge a field onto the domain identified by `id` in the domains list. */
function setField(device: Device, id: string, field: string, value: unknown): void {
  cpUpsert(device, "mclag", "domains", { domain_id: id, [field]: value }, "domain_id");
}

/** Remove a single field from the domain identified by `id` (the `no` form). */
function clearField(device: Device, id: string, field: string): void {
  const domain = cpList(device, "mclag", "domains").find((d) => d.domain_id === id);
  if (!domain) return;
  const copy: Record<string, unknown> = { ...domain };
  delete copy[field];
  cpRemove(device, "mclag", "domains", "domain_id", id);
  cpUpsert(device, "mclag", "domains", copy, "domain_id");
}

// configure-view: `mclag domain <id>` (enter sub-view) and `mclag gateway-mac <mac>`.
registerModal({
  id: "mclag",
  views: ["configure-view"],
  keywords: ["mclag"],
  run({ isNo, args, ctx }) {
    const sub = (args[0] ?? "").toLowerCase();

    if (sub === "domain") {
      const id = args[1];
      if (!id || !/^\d+$/.test(id)) return { output: [err("% MCLAG domain ID must be an integer (1-4095)")] };
      if (isNo) {
        cpRemove(ctx.device, "mclag", "domains", "domain_id", id);
        return { output: [] };
      }
      cpUpsert(ctx.device, "mclag", "domains", { domain_id: id }, "domain_id");
      return { output: [], enter: subViewFrame("configure-mclag-view", id) };
    }

    if (sub === "gateway-mac") {
      if (isNo) {
        cpUnset(ctx.device, "mclag", "gateway_mac");
        return { output: [] };
      }
      const mac = args[1];
      if (!mac) return { output: [err("% MCLAG gateway MAC address required")] };
      cpSet(ctx.device, "mclag", "gateway_mac", mac);
      return { output: [] };
    }

    return { output: [err("% mclag: expected `domain <id>` or `gateway-mac <mac>`")] };
  },
});

// configure-mclag-view: per-domain fields (domain id carried in viewctx).
registerModal({
  id: "mclag-domain",
  views: ["configure-mclag-view"],
  keywords: [...Object.keys(DOMAIN_FIELDS), "fast-convergence", "backup-keepalive"],
  run({ isNo, args, head, viewctx, ctx }) {
    const id = viewctx ?? "";

    if (head === "fast-convergence") {
      if (isNo) clearField(ctx.device, id, "fast_convergence");
      else setField(ctx.device, id, "fast_convergence", "enable");
      return { output: [] };
    }

    if (head === "backup-keepalive") {
      const bk = BK_FIELDS[(args[0] ?? "").toLowerCase()];
      if (!bk) return { output: [err("% backup-keepalive: expected source-ip|peer-ip|interval|session-vrf")] };
      if (isNo) {
        clearField(ctx.device, id, bk.field);
        return { output: [] };
      }
      const value = args.slice(1).join(" ");
      if (!value) return { output: [err(`% backup-keepalive ${args[0]} requires a value`)] };
      if (bk.numeric && !/^\d+$/.test(value)) return { output: [err(`% backup-keepalive ${args[0]} must be an integer`)] };
      setField(ctx.device, id, bk.field, value);
      return { output: [] };
    }

    const f = DOMAIN_FIELDS[head];
    if (!f) return null; // not ours
    if (isNo) {
      clearField(ctx.device, id, f.field);
      return { output: [] };
    }
    // `peer-link PortChannel 2` / `peer-link Ethernet 4` → PortChannel2 / Ethernet4 (sonic_cli_mclag.py:66-71).
    const value = head === "peer-link" ? args.join("").replace(/^portchannel/i, "PortChannel").replace(/^ethernet/i, "Ethernet") : args.join(" ");
    if (!value) return { output: [err(`% ${head} requires a value`)] };
    if (f.numeric && !/^\d+$/.test(value)) return { output: [err(`% ${head} must be an integer`)] };
    setField(ctx.device, id, f.field, value);
    return { output: [] };
  },
});

// configure-lag-view: `mclag <domain>` adds the PortChannel to MCLAG_INTERFACE.
registerModal({
  id: "mclag-interface",
  views: ["configure-lag-view"],
  keywords: ["mclag"],
  run({ isNo, args, ifname, ctx }) {
    const dom = args[0];
    if (!dom || !/^\d+$/.test(dom) || Number(dom) < 1 || Number(dom) > 4095) return { output: [err("% MCLAG domain ID must be an integer (1-4095)")] };
    const key = `${dom}|${ifname}`;
    if (isNo) cpRemove(ctx.device, "mclag", "interfaces", "key", key);
    else cpUpsert(ctx.device, "mclag", "interfaces", { key, domain_id: dom, if_name: ifname, if_type: "PortChannel" }, "key");
    return { output: [] };
  },
});

// `show mclag brief` layout (matches the box). Operational rows read the iccpd runtime.
const BRIEF_ROWS: { label: string; field?: string; op?: "role" | "session" | "peerlink" | "sysmac"; suffix?: string; dflt?: string }[] = [
  { label: "Domain ID", field: "domain_id" },
  { label: "Role", op: "role" },
  { label: "Session Status", op: "session" },
  { label: "Peer Link Status", op: "peerlink" },
  { label: "Source Address", field: "source_ip" },
  { label: "Peer Address", field: "peer_ip" },
  { label: "Peer Link", field: "peer_link" },
  { label: "Keepalive Interval", field: "keepalive_interval", suffix: " secs", dflt: "1" },
  { label: "Session Timeout", field: "session_timeout", suffix: " secs", dflt: "30" },
  { label: "Delay Restore", field: "delay_restore", suffix: " secs" },
  { label: "System Mac", op: "sysmac" },
  { label: "Mclag System Mac", field: "mclag_system_mac" },
];

// Extra configured fields (outside the golden brief block) shown only when set.
const EXTRA_ROWS: { label: string; field: string; suffix?: string }[] = [
  { label: "Session Vrf", field: "session_vrf" },
  { label: "Fast Convergence", field: "fast_convergence" },
  { label: "Backup Source Address", field: "backup_keepalive_source_ip" },
  { label: "Backup Peer Address", field: "backup_keepalive_peer_ip" },
  { label: "Backup Keepalive Interval", field: "backup_keepalive_interval", suffix: " secs" },
  { label: "Backup Session Vrf", field: "backup_keepalive_session_vrf" },
];

const W = 21;
const fmt = (label: string, value: string): string => `${label.padEnd(W)}: ${value}`;
const operOf = (device: Device, name: unknown) => (name ? (interfaceByName(device, String(name))?.operState ?? "down") : "");

function opValue(device: Device, d: Record<string, unknown>, op: string): string {
  const rt = mclagRuntime(device);
  const live = rt && rt.domain === String(d.domain_id) && rt.everUp ? rt : undefined; // MCLAG_TABLE row exists
  if (op === "peerlink") return operOf(device, d.peer_link);
  if (!live) return "";
  if (op === "role") return live.role;
  if (op === "session") return live.session ? "up" : "down";
  if (op === "sysmac") {
    const c = mclagConfig(device);
    return (live.role === "active" && c ? localSystemId(device, c) : (live.remoteSystemId ?? "")).toLowerCase();
  }
  return "";
}

/** Local/remote status per MLAG interface (sonic_cli_mclag.py:308-322). */
function mlagIfaces(device: Device, domainId: unknown): { name: string; local: string; remote: string }[] {
  const rt = mclagRuntime(device);
  return cpList(device, "mclag", "interfaces")
    .filter((i) => i.domain_id === domainId)
    .map((i) => {
      const name = String(i.if_name);
      return { name, local: operOf(device, name), remote: rt?.remoteIfs[name] ?? "down" };
    });
}

// enable-view: `show mclag` / `show mclag brief` / `show mclag interface <po> <domain>`.
registerModal({
  id: "mclag-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "mclag") return null; // not ours
    const sub = args[1]?.toLowerCase();
    if (sub === "interface") {
      const po = args[2];
      const dom = args[3];
      if (!po || !dom) return { output: [err("% Usage: show mclag interface <portchannel-id> <domain-id>")] };
      const name = `PortChannel${po}`;
      const it = mlagIfaces(ctx.device, dom).find((i) => i.name === name);
      if (!it) return { output: [line(`No MCLAG Interface ${name} in MCLAG domain ${dom} or domain not found`)] };
      const rt = mclagRuntime(ctx.device);
      const cfg = cpList(ctx.device, "mclag", "domains").find((d) => d.domain_id === dom);
      const peerLink = cfg ? interfaceByName(ctx.device, String(cfg.peer_link ?? "")) : undefined;
      // MCLAG_LOCAL_INTF_TABLE port_isolate_peer_link: isolation active for this interface.
      const isolate = !!rt?.session && !!peerLink && rt.remoteIfs[name] === "up";
      return {
        output: [
          line(" "),
          line(""),
          line(`${"Local/Remote Status".padEnd(20)} : ${it.local}/${it.remote}`),
          line(`${"TrafficDisable".padEnd(20)} : No`),
          line(`${"IsolateWithPeerLink".padEnd(20)} : ${isolate ? "Yes" : "No"}`),
        ],
      };
    }
    if (sub && sub !== "brief") return null; // other operational displays — not simulated

    const domains = cpList(ctx.device, "mclag", "domains");
    const gwMac = (cpGet(ctx.device, "mclag") ?? {})["gateway_mac"] as string | undefined;
    if (!domains.length && !gwMac) return { output: [muted("No MCLAG domains configured")] };

    const out: OutputLine[] = [];
    if (gwMac) out.push(line(fmt("Gateway Mac", gwMac)));
    for (const d of domains) {
      out.push(line(" "));
      for (const r of BRIEF_ROWS) {
        let v = r.op ? opValue(ctx.device, d, r.op) : d[r.field!];
        if ((v === undefined || v === "") && r.dflt) v = r.dflt;
        out.push(line(fmt(r.label, v === undefined || v === "" ? "" : String(v) + (r.suffix ?? ""))));
      }
      for (const r of EXTRA_ROWS) {
        const v = d[r.field];
        if (v !== undefined && v !== "") out.push(line(fmt(r.label, String(v) + (r.suffix ?? ""))));
      }
      const ifs = mlagIfaces(ctx.device, d.domain_id);
      out.push(line(" "), line(`Number of MLAG Interfaces:${ifs.length}`));
      if (ifs.length) {
        const dash = "-".repeat(59);
        out.push(line(dash), line(`${"MLAG Interface".padEnd(20)} ${"Local/Remote Status".padEnd(20)}`), line(dash));
        for (const i of ifs) out.push(line(`${i.name.padEnd(25)}${i.local}/${i.remote}`));
      }
    }
    return { output: out };
  },
});
