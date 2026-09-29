/**
 * AAA SONiC feature module. Source: aaa.txt. Follows the ./vlan.ts pattern;
 * config-plane state lives in the per-device feature store (feature-state.ts).
 *
 * Models the AAA authentication settings aaa.txt actually configures + renders:
 *
 *   config aaa authentication login <methods...>            (login default group ...)
 *   config aaa authentication login default                 (reset to local)
 *   config aaa authentication failthrough <enable|disable|default>
 *   config aaa authentication fallback   <enable|disable|default>
 *   show aaa                                                 AAA Authentication Information
 *
 * A `tacacs+` login method is rejected because no passkey exists in this sim,
 * matching aaa.txt TC-4/TC-5; bad enums map to the "Invalid input" error
 * (TC-16/TC-17). Authorization/accounting are display-only on the DUT with no
 * config CLI (TC-19/TC-20), so they are intentionally not modelled here.
 */
import { CommandContext, CommandResult, OutputLine, line, err, muted } from "../types";
import { SonicCmd, SonicFeatureModule, positional } from "./types";
import { featureState } from "../../models/feature-state";

interface AaaState {
  /** Ordered login method-list; empty = default (local). */
  loginMethods: string[];
  failthrough: boolean;
  fallback: boolean;
}

const VALID_METHODS = ["local", "tacacs+", "radius"];
const INVALID_INPUT = '% Error: Invalid input detected at "^" marker.';
const TACACS_NO_PASSKEY =
  "%Error: Authentication with 'tacacs+' is not allowed when passkey not exists.";

function aaaState(ctx: CommandContext): AaaState {
  return featureState<AaaState>(ctx.device, "aaa", () => ({
    loginMethods: [],
    failthrough: false,
    fallback: false,
  }));
}

/** enable -> true; disable/default -> false; anything else -> null (invalid). */
function parseToggle(tok: string | undefined): boolean | null {
  if (tok === "enable") return true;
  if (tok === "disable" || tok === "default") return false;
  return null;
}

const config: SonicCmd[] = [
  {
    path: ["aaa", "authentication", "login"],
    summary: "Set the login authentication method-list (e.g. radius local)",
    run(args, ctx): CommandResult {
      const st = aaaState(ctx);
      const methods = positional(args);
      if (methods.length === 0) {
        return { output: [err("Usage: config aaa authentication login <local|radius|tacacs+ ...|default>")] };
      }
      if (methods.length === 1 && methods[0] === "default") {
        st.loginMethods = [];
        return { output: [muted("login-method : local (default)")] };
      }
      if (methods.some((m) => !VALID_METHODS.includes(m))) {
        return { output: [err(INVALID_INPUT)] };
      }
      if (methods.includes("tacacs+")) {
        return { output: [err(TACACS_NO_PASSKEY)] };
      }
      st.loginMethods = methods;
      return { output: [muted(`login-method : ${methods.join(", ")}`)] };
    },
  },
  {
    path: ["aaa", "authentication", "failthrough"],
    summary: "Allow AAA fail-through [enable|disable|default]",
    run(args, ctx): CommandResult {
      const v = parseToggle(positional(args)[0]);
      if (v === null) return { output: [err(INVALID_INPUT)] };
      aaaState(ctx).failthrough = v;
      return { output: [muted(`failthrough : ${v ? "enabled" : "disabled (default)"}`)] };
    },
  },
  {
    path: ["aaa", "authentication", "fallback"],
    summary: "Allow AAA fallback [enable|disable|default]",
    run(args, ctx): CommandResult {
      const v = parseToggle(positional(args)[0]);
      if (v === null) return { output: [err(INVALID_INPUT)] };
      aaaState(ctx).fallback = v;
      return { output: [muted(`fallback : ${v ? "enabled" : "disabled (default)"}`)] };
    },
  },
];

function renderAaa(ctx: CommandContext): OutputLine[] {
  const st = aaaState(ctx);
  return [
    line("AAA Authentication Information"),
    line(`failthrough : ${st.failthrough ? "enabled" : "disabled (default)"}`),
    line(`fallback : ${st.fallback ? "enabled" : "disabled (default)"}`),
    line(`login-method : ${st.loginMethods.length ? st.loginMethods.join(", ") : "local (default)"}`),
  ];
}

const show: SonicCmd[] = [
  { path: ["aaa"], summary: "Show AAA authentication information", run: (_a, ctx) => ({ output: renderAaa(ctx) }) },
];

export const aaaModule: SonicFeatureModule = { id: "aaa", config, show };
