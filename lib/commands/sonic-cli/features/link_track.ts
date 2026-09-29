/**
 * Link state tracking (link_track) — CONFIG-PLANE clone (store + show, no engine).
 *
 *   sonic(config)# link state track <group>          -> create group + enter sub-view
 *   sonic(config-link-track)# description <text>
 *   sonic(config-link-track)# timeout <1-1800>
 *   sonic(config-link-track)# downstream all-mclag|all-evpn-es
 *   sonic(config-link-track)# threshold type percentage up <0-100> down <0-100>
 *   sonic(config)# no link state track <group>       -> delete group
 *   sonic(conf-if-EthernetN)# link state track <group> upstream|downstream
 *   sonic# show link state tracking [group]           -> render stored config
 *
 * Mirrors CONFIG_DB LINK_STATE_TRACKING on the real box: we store exactly what
 * was configured (a dedicated sub-mode, like bgp.ts) and render it back on show.
 * The runtime effect — a group bringing downstream links up/down based on
 * upstream link state, and per-interface Up/Down — is a data-plane behaviour this
 * simulator does not model, so it is never fabricated here.
 */
import { line, err, muted, OutputLine } from "../../types";
import { registerModal } from "../registry";
import { cpUpsert, cpRemove, cpList } from "../config-plane";
import { subViewFrame } from "../../../sonic/grammar";
import { Device } from "../../../models/device";

const ID = "link_track";
// LST_GROUP_NAME: begins with a letter/digit, then up to 62 of [-a-zA-Z0-9_].
const NAME_RE = /^[a-zA-Z0-9][-a-zA-Z0-9_]{0,62}$/;

interface Group {
  name: string;
  description?: string;
  timeout?: number;
  downstream?: string;
  thresholdType?: string;
  thresholdUp?: number;
  thresholdDown?: number;
  upstreamIfs?: string[];
  downstreamIfs?: string[];
}

function group(device: Device, name: string): Group | undefined {
  return cpList(device, ID, "groups").find((g) => g.name === name) as Group | undefined;
}

// configure-view: `link state track <group>` — create group, enter its sub-view.
registerModal({
  id: "link-track-enter",
  views: ["configure-view"],
  keywords: ["link"],
  run({ isNo, args, ctx }) {
    if (args[0]?.toLowerCase() !== "state" || args[1]?.toLowerCase() !== "track") return null; // not ours
    const name = args[2];
    if (!name) return { output: [err("% Group name required.")] };
    if (!NAME_RE.test(name)) {
      return { output: [err("% Invalid group name (max 63 chars; must begin with a letter or digit).")] };
    }
    if (isNo) {
      cpRemove(ctx.device, ID, "groups", "name", name);
      return { output: [] };
    }
    cpUpsert(ctx.device, ID, "groups", { name }, "name");
    return { output: [], enter: subViewFrame("configure-link-state-track-view", name) };
  },
});

// configure-link-state-track-view: description / timeout / downstream / threshold.
registerModal({
  id: "link-track",
  views: ["configure-link-state-track-view"],
  keywords: ["description", "timeout", "downstream", "threshold"],
  run({ head, isNo, args, viewctx, ctx }) {
    const g = group(ctx.device, viewctx ?? "");
    if (!g) return { output: [err("% Link state tracking group not found.")] };

    if (head === "description") {
      if (isNo) {
        delete g.description;
        return { output: [] };
      }
      const text = args.join(" ").replace(/^"|"$/g, "");
      if (!text) return { output: [err("% Description required.")] };
      g.description = text;
      return { output: [] };
    }

    if (head === "timeout") {
      if (isNo) {
        delete g.timeout;
        return { output: [] };
      }
      const t = Number(args[0]);
      if (!Number.isInteger(t) || t < 1 || t > 1800) {
        return { output: [err("% Timeout must be an integer in range 1-1800.")] };
      }
      g.timeout = t;
      return { output: [] };
    }

    if (head === "downstream") {
      const opt = args[0]?.toLowerCase();
      if (opt !== "all-mclag" && opt !== "all-evpn-es") {
        return { output: [err("% downstream must be all-mclag or all-evpn-es.")] };
      }
      if (isNo) {
        if (g.downstream === opt) delete g.downstream;
        return { output: [] };
      }
      g.downstream = opt;
      return { output: [] };
    }

    // threshold [type percentage] [up <0-100>] [down <0-100>]
    if (isNo) {
      const which = args[0]?.toLowerCase();
      if (which === "up") delete g.thresholdUp;
      else if (which === "down") delete g.thresholdDown;
      else {
        delete g.thresholdType;
        delete g.thresholdUp;
        delete g.thresholdDown;
      }
      return { output: [] };
    }
    let matched = false;
    for (let i = 0; i < args.length; i++) {
      const tok = args[i].toLowerCase();
      if (tok === "type") {
        g.thresholdType = args[++i]?.toLowerCase();
        matched = true;
      } else if (tok === "up") {
        const n = Number(args[++i]);
        if (!Number.isInteger(n) || n < 0 || n > 100) return { output: [err("% threshold up value must be 0-100.")] };
        g.thresholdUp = n;
        matched = true;
      } else if (tok === "down") {
        const n = Number(args[++i]);
        if (!Number.isInteger(n) || n < 0 || n > 100) return { output: [err("% threshold down value must be 0-100.")] };
        g.thresholdDown = n;
        matched = true;
      }
    }
    if (!matched) return { output: [err("% threshold requires type, up and/or down.")] };
    return { output: [] };
  },
});

// interface views: `link state track <group> upstream|downstream` binds this port.
registerModal({
  id: "link-track-if",
  views: ["configure-if-view", "configure-vlan-view", "configure-lag-view", "configure-subif-view"],
  keywords: ["link"],
  run({ isNo, args, ifname, ctx }) {
    if (args[0]?.toLowerCase() !== "state" || args[1]?.toLowerCase() !== "track") return null; // not ours
    const iface = ifname ?? "";
    const rest = args.slice(2);
    // Group name is optional in the `no` form; direction may be first token.
    let name = "";
    let dir = "";
    if (rest[0] === "upstream" || rest[0] === "downstream") {
      dir = rest[0];
    } else {
      name = rest[0] ?? "";
      dir = (rest[1] ?? "").toLowerCase();
    }

    if (!isNo) {
      if (!name || !NAME_RE.test(name)) return { output: [err("% Group name required.")] };
      if (dir !== "upstream" && dir !== "downstream") return { output: [err("% Specify upstream or downstream.")] };
      cpUpsert(ctx.device, ID, "groups", { name }, "name"); // ensure the group exists
      const g = group(ctx.device, name)!;
      const key = dir === "upstream" ? "upstreamIfs" : "downstreamIfs";
      const arr = g[key] ?? [];
      if (!arr.includes(iface)) arr.push(iface);
      g[key] = arr;
      return { output: [] };
    }

    // no link state track [<group>] upstream|downstream — unbind this port.
    if (dir !== "upstream" && dir !== "downstream") return { output: [err("% Specify upstream or downstream.")] };
    const key = dir === "upstream" ? "upstreamIfs" : "downstreamIfs";
    const groups = cpList(ctx.device, ID, "groups") as unknown as Group[];
    for (const g of groups) {
      if (name && g.name !== name) continue;
      if (g[key]) g[key] = g[key]!.filter((x) => x !== iface);
    }
    return { output: [] };
  },
});

// enable-view: `show link state tracking [group]` — render only configured values.
registerModal({
  id: "link-track-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "link" || args[1]?.toLowerCase() !== "state" || args[2]?.toLowerCase() !== "tracking") {
      return null; // not ours
    }
    const filter = args[3];
    let groups = cpList(ctx.device, ID, "groups") as unknown as Group[];
    if (filter) groups = groups.filter((g) => g.name === filter);
    if (!groups.length) {
      return { output: [muted(filter ? `No link state tracking group "${filter}" configured` : "No link state tracking groups configured")] };
    }
    const out: OutputLine[] = [];
    for (const g of groups) {
      out.push(line(`Name: ${g.name}`));
      if (g.description) out.push(line(`Description: ${g.description}`));
      if (g.timeout !== undefined) out.push(line(`Timeout: ${g.timeout} seconds`));
      if (g.downstream) out.push(line(`Downstream: ${g.downstream}`));
      if (g.thresholdType || g.thresholdUp !== undefined || g.thresholdDown !== undefined) {
        const parts: string[] = [];
        if (g.thresholdType) parts.push(`type ${g.thresholdType}`);
        if (g.thresholdUp !== undefined) parts.push(`up ${g.thresholdUp}`);
        if (g.thresholdDown !== undefined) parts.push(`down ${g.thresholdDown}`);
        out.push(line(`Threshold: ${parts.join(" ")}`));
      }
      if (g.upstreamIfs?.length) {
        out.push(line("Upstream Interfaces:"));
        for (const i of g.upstreamIfs) out.push(line(`    ${i}`));
      }
      if (g.downstreamIfs?.length) {
        out.push(line("Downstream Interfaces:"));
        for (const i of g.downstreamIfs) out.push(line(`    ${i}`));
      }
    }
    out.push(muted("(per-interface operational up/down state is a data-plane effect not simulated in this lab)"));
    return { output: out };
  },
});
