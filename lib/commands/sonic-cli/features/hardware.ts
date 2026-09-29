/**
 * Hardware — CONFIG-PLANE feature (no engine/ASIC backend; store + show).
 *
 *   sonic(config)# hardware                                 enter hardware sub-mode
 *   sonic(config-hardware)# access-list                     enter hardware-acl sub-mode
 *   sonic(config-hardware-acl)# counters per-entry|per-interface-entry
 *   sonic(config-hardware)# tcam                            enter hardware-tcam sub-mode
 *   sonic(config-hardware-tcam)# ip-acl   ingress|egress key-profile pac
 *   sonic(config-hardware-tcam)# qos-fbs  ingress|egress key-profile l2|ipv4|...
 *   sonic(config-hardware-tcam)# no ip-acl ingress key-profile         delete
 *   sonic# show running-configuration hardware [access-list|tcam]      render config
 *   sonic# show hardware tcam key-profile                              render key-profiles
 *
 * The sub-mode transitions (hardware -> access-list / tcam) are driven straight
 * from the real device grammar (COMMAND view=...), so this file only needs to
 * serve the LEAF config commands inside each sub-view plus the config `show`.
 * Mirrors CONFIG_DB: the ASIC ACL counter mode and the TCAM key-profile bindings
 * are stored honestly and rendered exactly as configured — nothing is fabricated.
 * NOTE (dataPlaneNotSimulated): the ASIC effect is not modelled — actual TCAM
 * table allocation is runtime state, so `show hardware`, `show hardware tcam` and
 * `show hardware tcam allocation` are left to fall through (not fabricated here).
 * See data/device-capture/klish-xml/hardware.xml for the source syntax.
 */
import { OutputLine, line, err, muted } from "../../types";
import { registerModal } from "../registry";
import { cpSet, cpUnset, cpUpsert, cpRemove, cpGet, cpList } from "../config-plane";

const ACL_COUNTER_MODES = ["per-entry", "per-interface-entry"];
const STAGES = ["ingress", "egress"];
const FBS_PROFILES = ["l2", "ipv4", "ipv6", "l2-ipv4", "l2-ipv6", "ipv4-ipv6"];

// KLISH feature keyword -> (CONFIG_DB TCAM table name, allowed key-profile values).
const TCAM_FEATURES: Record<string, { tcam: string; profiles: string[] }> = {
  "mac-acl": { tcam: "L2_ACL", profiles: ["pac"] },
  "ip-acl": { tcam: "L3_ACL", profiles: ["pac"] },
  "ipv6-acl": { tcam: "L3V6_ACL", profiles: ["pac"] },
  "qos-fbs": { tcam: "QOS_FBS", profiles: FBS_PROFILES },
  "monitoring-fbs": { tcam: "MONITORING_FBS", profiles: FBS_PROFILES },
  "forwarding-fbs": { tcam: "FORWARDING_FBS", profiles: FBS_PROFILES },
};

// configure-hardware-acl-view: `counters per-entry | per-interface-entry`.
registerModal({
  id: "hardware-acl",
  views: ["configure-hardware-acl-view"],
  keywords: ["counters"],
  run({ isNo, args, ctx }) {
    if (isNo) {
      cpUnset(ctx.device, "hardware", "acl_counters_mode");
      return { output: [] };
    }
    const mode = (args[0] ?? "").toLowerCase();
    if (!ACL_COUNTER_MODES.includes(mode))
      return { output: [err(`% counters mode must be one of ${ACL_COUNTER_MODES.join("|")}`)] };
    cpSet(ctx.device, "hardware", "acl_counters_mode", mode);
    return { output: [] };
  },
});

// configure-hardware-tcam-view: `<feature> <stage> key-profile <profile>` and `no` form.
registerModal({
  id: "hardware-tcam",
  views: ["configure-hardware-tcam-view"],
  keywords: Object.keys(TCAM_FEATURES),
  run({ head, isNo, args, ctx }) {
    const feat = TCAM_FEATURES[head];
    if (!feat) return null;
    const stage = (args[0] ?? "").toLowerCase();
    if (!STAGES.includes(stage)) return { output: [err(`% stage must be one of ${STAGES.join("|")}`)] };
    if ((args[1] ?? "").toLowerCase() !== "key-profile")
      return { output: [err('% expected keyword "key-profile"')] };
    const id = `${head}:${stage}`;
    if (isNo) {
      cpRemove(ctx.device, "hardware", "tcam", "id", id);
      return { output: [] };
    }
    const profile = (args[2] ?? "").toLowerCase();
    if (!feat.profiles.includes(profile))
      return { output: [err(`% ${head} key-profile must be one of ${feat.profiles.join("|")}`)] };
    cpUpsert(ctx.device, "hardware", "tcam", { id, feature: head, tcam: feat.tcam, stage, profile }, "id");
    return { output: [] };
  },
});

/** Render `show running-configuration hardware [access-list|tcam]` from the store. */
function runningConfig(st: Record<string, unknown>, tcam: Record<string, unknown>[], section?: string): OutputLine[] {
  const mode = st.acl_counters_mode as string | undefined;
  const wantAcl = !section || section === "access-list";
  const wantTcam = !section || section === "tcam";
  const hasAcl = wantAcl && mode !== undefined;
  const hasTcam = wantTcam && tcam.length > 0;
  if (!hasAcl && !hasTcam) return [muted("No hardware configuration")];
  const out = [line("!"), line("hardware")];
  if (hasAcl) {
    out.push(line(" access-list"));
    out.push(line(`  counters ${mode}`));
  }
  if (hasTcam) {
    out.push(line(" tcam"));
    for (const t of tcam) out.push(line(`  ${String(t.feature)} ${String(t.stage)} key-profile ${String(t.profile)}`));
  }
  out.push(line("!"));
  return out;
}

/** Render `show hardware tcam key-profile` as a column table of configured bindings. */
function keyProfiles(tcam: Record<string, unknown>[]): OutputLine[] {
  if (!tcam.length) return [muted("No TCAM key-profiles configured")];
  const dash = "-".repeat(54);
  const row = (a: string, b: string, c: string, d: string) => a.padEnd(18) + b.padEnd(16) + c.padEnd(10) + d;
  const out = [line(dash), line(row("FEATURE", "TCAM", "STAGE", "KEY-PROFILE")), line(dash)];
  for (const t of tcam)
    out.push(line(row(String(t.feature), String(t.tcam), String(t.stage), String(t.profile))));
  return out;
}

// enable-view: config-derived `show` renders. Runtime ASIC state is not fabricated.
registerModal({
  id: "hardware-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    const a0 = (args[0] ?? "").toLowerCase();
    // show running-configuration hardware [access-list|tcam]
    if (a0 === "running-configuration" && (args[1] ?? "").toLowerCase() === "hardware") {
      const st = cpGet(ctx.device, "hardware") ?? {};
      const tcam = cpList(ctx.device, "hardware", "tcam");
      return { output: runningConfig(st, tcam, (args[2] ?? "").toLowerCase() || undefined) };
    }
    // show hardware tcam key-profile
    if (a0 === "hardware" && (args[1] ?? "").toLowerCase() === "tcam" && (args[2] ?? "").toLowerCase() === "key-profile") {
      return { output: keyProfiles(cpList(ctx.device, "hardware", "tcam")) };
    }
    return null; // not ours (runtime ASIC state / other features)
  },
});
