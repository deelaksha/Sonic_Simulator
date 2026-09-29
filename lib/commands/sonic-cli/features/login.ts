/**
 * login — CONFIG-PLANE feature (no engine/host backend; store + show).
 *
 *   sonic(config)# login concurrent-session limit <1-12>
 *   sonic(config)# login exec-timeout <0-3600>
 *   sonic(config)# login lockout console-exempt
 *   sonic(config)# login lockout max-retries <0-16>
 *   sonic(config)# login lockout period <0-43200>
 *   sonic(config)# login password-attribute character-restriction {lower|upper|numeric|special-char} <0-31>
 *   sonic(config)# login password-attribute min-length <6-32>
 *   sonic(config)# no login ...                          clear
 *   sonic# show login                                    render from stored state
 *
 * Syntax mirrors data/device-capture/klish-xml/login.xml (VIEW=configure-view).
 * The real box enforces these at runtime (idle-session timeout, account
 * lockout, password complexity); the simulator only stores + renders the
 * configured values — the enforcement behaviour is NOT simulated.
 */
import { line, err, muted, OutputLine } from "../../types";
import { registerModal } from "../registry";
import { cpSet, cpUnset, cpGet } from "../config-plane";

/** Parse an integer token and range-check it; null on any failure. */
function num(tok: string | undefined, min: number, max: number): number | null {
  if (tok === undefined || !/^\d+$/.test(tok)) return null;
  const n = Number(tok);
  return n >= min && n <= max ? n : null;
}

const CHAR_KEYS: Record<string, string> = {
  lower: "pwLower",
  upper: "pwUpper",
  numeric: "pwNumeric",
  "special-char": "pwSpecial",
};

registerModal({
  id: "login",
  views: ["configure-view"],
  keywords: ["login"],
  run({ isNo, args, ctx }) {
    const dev = ctx.device;
    const sub = (args[0] ?? "").toLowerCase();

    // bare `login` / `no login`
    if (!sub) {
      if (isNo) {
        for (const k of [
          "concurrentSessionLimit", "execTimeout", "lockoutConsoleExempt",
          "lockoutMaxRetries", "lockoutPeriod", "pwLower", "pwUpper",
          "pwNumeric", "pwSpecial", "pwMinLength",
        ]) cpUnset(dev, "login", k);
      }
      return { output: [] };
    }

    if (sub === "concurrent-session") {
      if ((args[1] ?? "").toLowerCase() !== "limit")
        return { output: [err("% Expected: login concurrent-session limit <1-12>")] };
      if (isNo) { cpUnset(dev, "login", "concurrentSessionLimit"); return { output: [] }; }
      const n = num(args[2], 1, 12);
      if (n === null) return { output: [err("% concurrent-session limit must be 1-12")] };
      cpSet(dev, "login", "concurrentSessionLimit", n);
      return { output: [] };
    }

    if (sub === "exec-timeout") {
      if (isNo) { cpUnset(dev, "login", "execTimeout"); return { output: [] }; }
      const n = num(args[1], 0, 3600);
      if (n === null) return { output: [err("% exec-timeout must be 0-3600 seconds")] };
      cpSet(dev, "login", "execTimeout", n);
      return { output: [] };
    }

    if (sub === "lockout") {
      const attr = (args[1] ?? "").toLowerCase();
      if (attr === "console-exempt") {
        if (isNo) cpUnset(dev, "login", "lockoutConsoleExempt");
        else cpSet(dev, "login", "lockoutConsoleExempt", true);
        return { output: [] };
      }
      if (attr === "max-retries") {
        if (isNo) { cpUnset(dev, "login", "lockoutMaxRetries"); return { output: [] }; }
        const n = num(args[2], 0, 16);
        if (n === null) return { output: [err("% max-retries must be 0-16")] };
        cpSet(dev, "login", "lockoutMaxRetries", n);
        return { output: [] };
      }
      if (attr === "period") {
        if (isNo) { cpUnset(dev, "login", "lockoutPeriod"); return { output: [] }; }
        const n = num(args[2], 0, 43200);
        if (n === null) return { output: [err("% lockout period must be 0-43200 minutes")] };
        cpSet(dev, "login", "lockoutPeriod", n);
        return { output: [] };
      }
      return { output: [err("% Expected: login lockout {console-exempt|max-retries <0-16>|period <0-43200>}")] };
    }

    if (sub === "password-attribute") {
      const attr = (args[1] ?? "").toLowerCase();
      if (attr === "min-length") {
        if (isNo) { cpUnset(dev, "login", "pwMinLength"); return { output: [] }; }
        const n = num(args[2], 6, 32);
        if (n === null) return { output: [err("% min-length must be 6-32")] };
        cpSet(dev, "login", "pwMinLength", n);
        return { output: [] };
      }
      if (attr === "character-restriction") {
        const kind = (args[2] ?? "").toLowerCase();
        const key = CHAR_KEYS[kind];
        if (!key) return { output: [err("% character-restriction must be one of lower|upper|numeric|special-char")] };
        if (isNo) { cpUnset(dev, "login", key); return { output: [] }; }
        const n = num(args[3], 0, 31);
        if (n === null) return { output: [err(`% ${kind} restriction must be 0-31`)] };
        cpSet(dev, "login", key, n);
        return { output: [] };
      }
      return { output: [err("% Expected: login password-attribute {character-restriction ...|min-length <6-32>}")] };
    }

    return { output: [err("% Unknown login option; expected concurrent-session|exec-timeout|lockout|password-attribute")] };
  },
});

registerModal({
  id: "login-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "login") return null; // not ours
    const st = cpGet(ctx.device, "login") ?? {};
    const out: OutputLine[] = [];
    const add = (label: string, v: unknown) => {
      if (v !== undefined) out.push(line(`${label.padEnd(30)}: ${v}`));
    };
    add("Concurrent session limit", st.concurrentSessionLimit);
    add("Exec-timeout (seconds)", st.execTimeout);
    add("Lockout console-exempt", st.lockoutConsoleExempt === true ? "enabled" : undefined);
    add("Lockout max-retries", st.lockoutMaxRetries);
    add("Lockout period (minutes)", st.lockoutPeriod);
    add("Password min-length", st.pwMinLength);
    add("Password min lower-case", st.pwLower);
    add("Password min upper-case", st.pwUpper);
    add("Password min numeric", st.pwNumeric);
    add("Password min special-char", st.pwSpecial);
    return { output: out.length ? out : [muted("No login configuration")] };
  },
});
