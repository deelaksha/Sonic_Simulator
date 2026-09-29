/**
 * DCBX — CONFIG-PLANE feature (no engine/packet backend; store + show).
 *
 * Grammar: data/device-capture/klish-xml/dcbx.xml (+ clear_dcbx_stats.xml).
 *
 *   configure-view (global):
 *     dcbx enable                      -> DCBX/global/enabled = true
 *     no dcbx enable                   -> clear global enable
 *
 *   configure-if-view (per physical interface):
 *     dcbx enable                      -> DCBX_INTERFACE .../dcbx_enabled = true
 *     no dcbx enable                   -> DCBX_INTERFACE .../dcbx_enabled = false
 *     dcbx tlv-select pfc|ets-conf|ets-reco     -> add advertised TLV
 *     no dcbx tlv-select pfc|ets-conf|ets-reco  -> remove advertised TLV
 *
 *   enable-view (show):
 *     show dcbx [interface <if>]        -> render configured admin/TLV state
 *
 * Mirrors the real box's DCBX / DCBX_INTERFACE CONFIG_DB tables: we store exactly
 * what is configured and `show dcbx` renders only those configured values.
 *
 * DATA-PLANE NOT SIMULATED: the operational side of DCBX — negotiated/peer TLV
 * state (`show dcbx tlv ...`) and the LLDP-carried protocol counters
 * (`show dcbx statistics`, `clear dcbx-statistics`) — is live runtime data we do
 * not fabricate; those `show dcbx` sub-forms return null (grammar fallback).
 */
import { OutputLine, line, err, muted } from "../../types";
import { registerModal } from "../registry";
import { cpSet, cpUnset, cpGet, cpUpsert, cpList } from "../config-plane";

const TLVS = ["pfc", "ets-conf", "ets-reco"];

interface DcbxIf {
  ifname: string;
  enabled?: boolean;
  tlvs?: string[];
}

// configure-view (global) + configure-if-view (per interface): `dcbx ...`.
registerModal({
  id: "dcbx",
  views: ["configure-view", "configure-if-view", "configure-if-range-view"],
  keywords: ["dcbx"],
  run({ view, isNo, args, ctx, ifname }) {
    const sub = (args[0] ?? "").toLowerCase();

    // Global scope.
    if (view === "configure-view") {
      if (sub !== "enable") return { output: [err("% dcbx: expected `enable`")] };
      if (isNo) cpUnset(ctx.device, "dcbx", "global");
      else cpSet(ctx.device, "dcbx", "global", true);
      return { output: [] };
    }

    // Interface scope.
    const port = ifname ?? "";
    if (sub === "enable") {
      cpUpsert(ctx.device, "dcbx", "interfaces", { ifname: port, enabled: !isNo }, "ifname");
      return { output: [] };
    }
    if (sub === "tlv-select") {
      const tlv = (args[1] ?? "").toLowerCase();
      if (!TLVS.includes(tlv)) return { output: [err(`% tlv-select must be one of ${TLVS.join("|")}`)] };
      const cur = (cpList(ctx.device, "dcbx", "interfaces") as unknown as DcbxIf[]).find((i) => i.ifname === port);
      const set = new Set(cur?.tlvs ?? []);
      if (isNo) set.delete(tlv);
      else set.add(tlv);
      cpUpsert(ctx.device, "dcbx", "interfaces", { ifname: port, tlvs: TLVS.filter((t) => set.has(t)) }, "ifname");
      return { output: [] };
    }
    return { output: [err("% dcbx: expected `enable` or `tlv-select`")] };
  },
});

// enable-view: `show dcbx [interface <if>]` renders the stored DCBX config.
registerModal({
  id: "dcbx-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "dcbx") return null; // not ours
    const sub = args[1]?.toLowerCase();
    // Operational/runtime sub-views (peer TLV negotiation, protocol counters): not simulated.
    if (sub === "statistics" || sub === "tlv") return null;

    const globalOn = (cpGet(ctx.device, "dcbx") ?? {}).global === true;
    let list = cpList(ctx.device, "dcbx", "interfaces") as unknown as DcbxIf[];
    if (sub === "interface" && args[2]) list = list.filter((i) => i.ifname.toLowerCase() === args[2].toLowerCase());

    if (!globalOn && list.length === 0) return { output: [muted("DCBX not configured")] };

    const out: OutputLine[] = [line(`DCBX Global Status: ${globalOn ? "Enabled" : "Disabled"}`)];
    if (list.length) {
      const row = (i: string, a: string, t: string) => i.padEnd(16) + a.padEnd(10) + t;
      out.push(line(""), line(row("INTERFACE", "ADMIN", "TLV-SELECT")), line("-".repeat(52)));
      for (const f of list) {
        const admin = f.enabled === true ? "Enabled" : f.enabled === false ? "Disabled" : "-";
        out.push(line(row(f.ifname, admin, f.tlvs && f.tlvs.length ? f.tlvs.join(", ") : "-")));
      }
    }
    return { output: out };
  },
});
