/**
 * Auditd-system (audit) — CONFIG-PLANE feature (no engine/kernel backend).
 *
 * Real KLISH (data/device-capture/klish-xml/audit.xml):
 *   sonic(config)# auditd-system                       create global auditd entry
 *   sonic(config)# auditd-system rules basic|detail|custom   select rule profile
 *   sonic(config)# no auditd-system                    delete global entry
 *   sonic(config)# no auditd-system rules              clear rule profile
 *   sonic# show auditd-system                          render configured settings
 *   sonic# show auditd-system rules                    render selected rule profile
 *
 * We store exactly what is configured (the global entry + rule profile) and
 * render it back on `show`. The DATA-plane — the kernel auditd daemon actually
 * loading rules and generating the audit log (`show audit-log`,
 * `show auditd-system log`) — is NOT simulated, so those runtime views are left
 * to the grammar fallback rather than fabricated here.
 */
import { line, err, muted } from "../../types";
import { registerModal } from "../registry";
import { cpSet, cpUnset, cpGet } from "../config-plane";

const PROFILES = ["basic", "detail", "custom"];
const DASHES = "-".repeat(73);

// configure-view: auditd-system [rules <profile>]  (+ the `no` forms)
registerModal({
  id: "audit",
  views: ["configure-view"],
  keywords: ["auditd-system"],
  run({ isNo, args, ctx }) {
    const sub = (args[0] ?? "").toLowerCase();

    if (sub === "rules") {
      if (isNo) {
        cpUnset(ctx.device, "audit", "rules_profile");
        return { output: [] };
      }
      const profile = (args[1] ?? "").toLowerCase();
      if (!PROFILES.includes(profile)) {
        return { output: [err(`% audit rules profile must be one of ${PROFILES.join("|")}`)] };
      }
      cpSet(ctx.device, "audit", "rules_profile", profile);
      return { output: [] };
    }

    if (sub) return { output: [err(`% Unknown auditd-system subcommand "${sub}"`)] };

    // bare `auditd-system` — the global AUDITD_SYSTEM entry
    if (isNo) {
      cpUnset(ctx.device, "audit", "enabled");
      return { output: [] };
    }
    cpSet(ctx.device, "audit", "enabled", true);
    return { output: [] };
  },
});

// enable-view: show auditd-system [rules]  — render only what was configured
registerModal({
  id: "audit-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "auditd-system") return null; // not ours
    const sub = args[1]?.toLowerCase();
    if (sub === "log") return null; // kernel audit log is runtime — not simulated, not faked

    const st = cpGet(ctx.device, "audit") ?? {};
    const profile = st.rules_profile as string | undefined;

    if (sub === "rules") {
      if (!profile) return { output: [muted("No audit rules profile configured")] };
      return { output: [line(DASHES), line(`Audit rules profile:  ${profile}`), line(DASHES)] };
    }

    const out = [];
    if (st.enabled) out.push(line("auditd-system: enabled"));
    if (profile) out.push(line(`Audit rules profile:  ${profile}`));
    return { output: out.length ? out : [muted("auditd-system not configured")] };
  },
});
