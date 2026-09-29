/**
 * WRED / ECN — CONFIG-PLANE feature (no engine/packet backend; store + show).
 *
 * Real KLISH (Dell SONiC, data/device-capture/klish-xml/wred.xml):
 *   sonic(config)# qos wred-policy <name>            -> enters configure-wred-view
 *   sonic(config-wred-<name>)# green minimum-threshold <min> maximum-threshold <max> drop-probability <rate>
 *   sonic(config-wred-<name>)# no green
 *   sonic(config-wred-<name>)# ecn <none|green|all>
 *   sonic(config-wred-<name>)# no ecn
 *   sonic(config)# no qos wred-policy <name>         -> delete the whole policy
 *   sonic# show qos wred-policy [name]               -> render from stored state
 *
 * SUB-MODE feature (like bgp): the configure-view entry creates the policy in the
 * config-plane store and drops into configure-wred-view; the in-mode handlers
 * cpUpsert the WRED_PROFILE fields (keyed by policy name, from a.viewctx). Only
 * yellow/green/red green-color config is supported by the real box's grammar
 * (yellow/red are commented out as unsupported), so only `green` is cloned here.
 * Nothing is fabricated — `show` renders exactly what was configured.
 */
import { line, err, muted, OutputLine } from "../../types";
import { registerModal } from "../registry";
import { cpUpsert, cpRemove, cpList } from "../config-plane";
import { subViewFrame } from "../../../sonic/grammar";

type Profile = Record<string, unknown>;

const ECN_MODES = ["none", "green", "all"];

function findProfile(profiles: Profile[], name: string): Profile | undefined {
  return profiles.find((p) => p.name === name);
}

function isUint(s: string | undefined): boolean {
  return !!s && /^\d+$/.test(s);
}

// configure-view: `qos wred-policy <name>` creates the policy and enters its sub-view.
registerModal({
  id: "wred-enter",
  views: ["configure-view"],
  keywords: ["qos"],
  run({ isNo, args, ctx }) {
    if ((args[0] ?? "").toLowerCase() !== "wred-policy") return null; // not ours
    const name = args[1];
    if (!name) return { output: [err("% WRED policy name required.")] };
    if (isNo) {
      cpRemove(ctx.device, "wred", "profiles", "name", name);
      return { output: [] };
    }
    cpUpsert(ctx.device, "wred", "profiles", { name }, "name"); // create (preserve existing fields)
    return { output: [], enter: subViewFrame("configure-wred-view", name) };
  },
});

// configure-wred-view: green thresholds + ecn mode, scoped to a.viewctx (policy name).
registerModal({
  id: "wred",
  views: ["configure-wred-view"],
  keywords: ["green", "ecn"],
  run({ isNo, head, args, viewctx, ctx }) {
    const name = viewctx ?? "";
    const profiles = cpList(ctx.device, "wred", "profiles");
    const prof = findProfile(profiles, name);

    if (head === "green") {
      if (isNo) {
        if (prof) {
          delete prof.green_min;
          delete prof.green_max;
          delete prof.green_drop;
        }
        return { output: [] };
      }
      // green minimum-threshold <min> maximum-threshold <max> drop-probability <rate>
      const [k0, min, k1, max, k2, rate] = args;
      if (k0 !== "minimum-threshold" || k1 !== "maximum-threshold" || k2 !== "drop-probability" || !isUint(min) || !isUint(max) || !isUint(rate)) {
        return { output: [err("% Usage: green minimum-threshold <min> maximum-threshold <max> drop-probability <rate>")] };
      }
      if (Number(rate) > 100) return { output: [err("% drop-probability must be 0-100 (percent).")] };
      cpUpsert(ctx.device, "wred", "profiles", { name, green_min: Number(min), green_max: Number(max), green_drop: Number(rate) }, "name");
      return { output: [] };
    }

    // ecn
    if (isNo) {
      if (prof) delete prof.ecn;
      return { output: [] };
    }
    const mode = (args[0] ?? "").toLowerCase();
    if (!ECN_MODES.includes(mode)) return { output: [err(`% ecn mode must be one of ${ECN_MODES.join("|")}`)] };
    cpUpsert(ctx.device, "wred", "profiles", { name, ecn: mode }, "name");
    return { output: [] };
  },
});

// enable-view: `show qos wred-policy [name]` renders stored WRED policies.
const SEP = "-".repeat(51);
const row = (k: string, v: unknown) => line(`${k.padEnd(23)}: ${v}`);

registerModal({
  id: "wred-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if ((args[0] ?? "").toLowerCase() !== "qos" || (args[1] ?? "").toLowerCase() !== "wred-policy") return null; // not ours
    const filter = args[2];
    let profiles = cpList(ctx.device, "wred", "profiles");
    if (filter) profiles = profiles.filter((p) => p.name === filter);
    if (!profiles.length) {
      return { output: [muted(filter ? `No WRED policy '${filter}' configured` : "No WRED policies configured")] };
    }
    const out: OutputLine[] = [];
    for (const p of profiles) {
      out.push(line(SEP));
      out.push(row("Profile", p.name));
      if (p.ecn != null) out.push(row("ecn", `ecn_${p.ecn}`));
      if (p.green_min != null) out.push(row("green-min-threshold", `${p.green_min}  KBytes`));
      if (p.green_max != null) out.push(row("green-max-threshold", `${p.green_max}  KBytes`));
      if (p.green_drop != null) out.push(row("green-drop-rate", p.green_drop));
    }
    return { output: out };
  },
});
