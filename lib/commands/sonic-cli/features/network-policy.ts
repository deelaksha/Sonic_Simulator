/**
 * Network-policy profiles (LLDP-MED) — CONFIG-PLANE feature (no engine/packet
 * backend; store + show).
 *
 *   sonic(config)# network-policy profile 1                 -> create + enter sub-view
 *   sonic(config-network-policy-1)# voice vlan 100 cos 4 dscp 20
 *   sonic(config-network-policy-1)# voice-signaling vlan dot1p cos 3 dscp 10
 *   sonic(config-network-policy-1)# no voice vlan
 *   sonic(config)# no network-policy profile 1              -> delete
 *   sonic# show network-policy [profile <1-128>]            -> render from stored config
 *
 * `network-policy profile <n>` (configure-view) has its config in a DEDICATED
 * SUB-MODE (grammar view="configure-network-policy-view"), so we follow the
 * sub-mode pattern: the entry handler upserts the profile and returns
 * `enter: subViewFrame(...)`, and a sub-view handler stores the voice /
 * voice-signaling application attributes keyed on the profile number.
 *
 * Network-policy profiles are advertised to endpoints via LLDP-MED TLVs. The sim
 * does not send LLDP-MED packets, so the advertisement (the protocol / data-plane
 * effect) is not simulated — we store + show exactly what was configured and mark
 * dataPlaneNotSimulated. Nothing operational is fabricated.
 */
import { line, err, muted, OutputLine } from "../../types";
import { registerModal } from "../registry";
import { cpUpsert, cpRemove, cpList } from "../config-plane";
import { subViewFrame } from "../../../sonic/grammar";
import type { Device } from "../../../models/device";

// A configured application-type entry within a profile. Keyed by `type`.
type App = {
  type: string; // "voice" | "voice-signaling"
  vlan: string; // VLAN id or "dot1p" (priority-tagged)
  untagged?: boolean;
  cos?: string; // 0-7
  dscp?: string; // 0-63
};
type Profile = { number: string; apps?: App[] };

function profiles(device: Device): Profile[] {
  return cpList(device, "network-policy", "profiles") as Profile[];
}

// Store `app` under profile `num`, replacing any existing entry of the same type.
function setApp(device: Device, num: string, app: App): void {
  const existing = profiles(device).find((p) => p.number === num);
  const apps = (existing?.apps ?? []).filter((a) => a.type !== app.type);
  apps.push(app);
  cpUpsert(device, "network-policy", "profiles", { number: num, apps }, "number");
}

// Remove the app of `type` from profile `num` (the `no` form).
function delApp(device: Device, num: string, type: string): void {
  const existing = profiles(device).find((p) => p.number === num);
  if (!existing) return;
  const apps = (existing.apps ?? []).filter((a) => a.type !== type);
  cpUpsert(device, "network-policy", "profiles", { number: num, apps }, "number");
}

// configure-view: `network-policy profile <1-128>` — create (upsert) + enter the
// sub-view; `no network-policy profile <n>` — delete the profile.
registerModal({
  id: "network-policy-enter",
  views: ["configure-view"],
  keywords: ["network-policy"],
  run({ isNo, args, ctx }) {
    if (args[0]?.toLowerCase() !== "profile") return { output: [err("% Usage: network-policy profile <1-128>")] };
    const num = args[1];
    const n = Number(num);
    if (!num || !Number.isInteger(n) || n < 1 || n > 128) {
      return { output: [err("% Network policy number must be 1-128.")] };
    }
    if (isNo) {
      cpRemove(ctx.device, "network-policy", "profiles", "number", num);
      return { output: [] };
    }
    cpUpsert(ctx.device, "network-policy", "profiles", { number: num }, "number");
    return { output: [], enter: subViewFrame("configure-network-policy-view", num) };
  },
});

// configure-network-policy-view: `voice` / `voice-signaling` application config.
//   voice vlan <vlan-id|dot1p> [untagged] [cos <0-7>] [dscp <0-63>]
registerModal({
  id: "network-policy",
  views: ["configure-network-policy-view"],
  keywords: ["voice", "voice-signaling"],
  run({ head, isNo, args, viewctx, ctx }) {
    if (!viewctx) return null;
    const type = head; // "voice" | "voice-signaling"

    if (isNo) {
      delApp(ctx.device, viewctx, type);
      return { output: [] };
    }

    if (args[0]?.toLowerCase() !== "vlan") {
      return { output: [err(`% Usage: ${type} vlan <vlan-id|dot1p> [untagged] [cos <0-7>] [dscp <0-63>]`)] };
    }
    const vlan = args[1];
    if (!vlan) return { output: [err("% Voice VLAN id or dot1p required.")] };
    const isDot1p = vlan.toLowerCase() === "dot1p";
    if (!isDot1p) {
      const v = Number(vlan);
      if (!Number.isInteger(v) || v < 1 || v > 4094) return { output: [err("% Voice VLAN id must be 1-4094 or dot1p.")] };
    }

    const app: App = { type, vlan: isDot1p ? "dot1p" : vlan };
    const opts = args.slice(2);
    for (let i = 0; i < opts.length; i++) {
      const t = opts[i].toLowerCase();
      if (t === "untagged") {
        app.untagged = true;
      } else if (t === "cos") {
        const c = Number(opts[++i]);
        if (!Number.isInteger(c) || c < 0 || c > 7) return { output: [err("% cos value must be 0-7.")] };
        app.cos = String(c);
      } else if (t === "dscp") {
        const d = Number(opts[++i]);
        if (!Number.isInteger(d) || d < 0 || d > 63) return { output: [err("% dscp value must be 0-63.")] };
        app.dscp = String(d);
      } else {
        return { output: [err(`% Unknown option "${opts[i]}".`)] };
      }
    }
    setApp(ctx.device, viewctx, app);
    return { output: [] };
  },
});

function renderApp(a: App): string {
  let s = `${a.type} vlan ${a.vlan}`;
  if (a.untagged) s += " untagged";
  if (a.cos !== undefined) s += ` cos ${a.cos}`;
  if (a.dscp !== undefined) s += ` dscp ${a.dscp}`;
  return s;
}

// enable-view: `show network-policy [profile <n>]` — render exactly what was
// configured, in the same syntax used to configure it (mirrors the box's
// per-profile `show configuration`). No operational/advertised state is shown.
registerModal({
  id: "network-policy-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "network-policy") return null; // not ours
    let list = profiles(ctx.device);
    if (args[1]?.toLowerCase() === "profile") {
      const num = args[2];
      list = list.filter((p) => p.number === num);
    }
    if (!list.length) return { output: [muted("No network-policy profiles configured")] };
    list = [...list].sort((a, b) => Number(a.number) - Number(b.number));
    const out: OutputLine[] = [];
    for (const p of list) {
      out.push(line(`network-policy profile ${p.number}`));
      for (const a of p.apps ?? []) out.push(line(` ${renderApp(a)}`));
    }
    return { output: out };
  },
});
