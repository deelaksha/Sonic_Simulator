/**
 * MCLAG — CONFIG-PLANE feature (no engine/packet backend; store + show).
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
 *   sonic# show mclag [brief]                      render MCLAG_DOMAIN config
 *
 * Mirrors the real box's sonic-mclag MCLAG_DOMAIN_LIST / MCLAG_GW_MAC CONFIG_DB
 * tables (see data/device-capture/klish-xml/mclag.xml). Config is stored honestly
 * and `show mclag brief` renders exactly what was configured.
 *
 * DATA-PLANE NOT SIMULATED: the MCLAG control-plane / session state is not
 * modelled — operational fields in `show mclag brief` (Role, Session Status,
 * Peer Link Status, System Mac) are left blank, and the operational display
 * commands (`show mclag interface`, `show mclag mac remote`,
 * `show mclag separate-ip-interfaces`, `show mclag peer-gateway-interfaces`) are
 * NOT handled here (they fall through rather than being fabricated).
 */
import { OutputLine, line, err, muted } from "../../types";
import { registerModal } from "../registry";
import { cpSet, cpUnset, cpUpsert, cpRemove, cpList, cpGet } from "../config-plane";
import { subViewFrame } from "../../../sonic/grammar";
import { Device } from "../../../models/device";

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
    const value = args.join(" ");
    if (!value) return { output: [err(`% ${head} requires a value`)] };
    if (f.numeric && !/^\d+$/.test(value)) return { output: [err(`% ${head} must be an integer`)] };
    setField(ctx.device, id, f.field, value);
    return { output: [] };
  },
});

// `show mclag brief` layout (matches the box). Rows without a `field` are
// operational state we do NOT simulate — they are rendered blank, never faked.
const BRIEF_ROWS: { label: string; field?: string; suffix?: string }[] = [
  { label: "Domain ID", field: "domain_id" },
  { label: "Role" },
  { label: "Session Status" },
  { label: "Peer Link Status" },
  { label: "Source Address", field: "source_ip" },
  { label: "Peer Address", field: "peer_ip" },
  { label: "Peer Link", field: "peer_link" },
  { label: "Keepalive Interval", field: "keepalive_interval", suffix: " secs" },
  { label: "Session Timeout", field: "session_timeout", suffix: " secs" },
  { label: "Delay Restore", field: "delay_restore", suffix: " secs" },
  { label: "System Mac" },
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

// enable-view: `show mclag` / `show mclag brief` render the configured domains.
registerModal({
  id: "mclag-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "mclag") return null; // not ours
    const sub = args[1]?.toLowerCase();
    if (sub && sub !== "brief") return null; // operational displays — not simulated

    const domains = cpList(ctx.device, "mclag", "domains");
    const gwMac = (cpGet(ctx.device, "mclag") ?? {})["gateway_mac"] as string | undefined;
    if (!domains.length && !gwMac) return { output: [muted("No MCLAG domains configured")] };

    const out: OutputLine[] = [];
    if (gwMac) out.push(line(fmt("Gateway Mac", gwMac)));
    for (const d of domains) {
      out.push(line(""));
      for (const r of BRIEF_ROWS) {
        const v = r.field ? d[r.field] : undefined;
        out.push(line(fmt(r.label, v === undefined || v === "" ? "" : String(v) + (r.suffix ?? ""))));
      }
      for (const r of EXTRA_ROWS) {
        const v = d[r.field];
        if (v !== undefined && v !== "") out.push(line(fmt(r.label, String(v) + (r.suffix ?? ""))));
      }
    }
    return { output: out };
  },
});
