/**
 * AAA modal behaviour. configure-view (real KLISH grammar: data/device-capture/
 * klish-xml/aaa.xml):
 *   aaa authentication failthrough <enable|disable>          fail-through status
 *   aaa authentication login default [group] <methods...>    login method-list
 *   aaa authentication login-method <methods...>  (hidden)   login method-list
 *   no aaa authentication login default | login-method       reset to local
 * Each delegates to the tested Click `config aaa authentication ...` so the
 * behaviour is not duplicated.
 *
 * Not wired (Click has no equivalent — see the module's own docstring): the MFA
 * (`aaa authentication login mfa`, `aaa cac-piv ...`), console-auth
 * (`aaa authentication login console`), authorization (`aaa authorization ...`)
 * and name-service (`aaa name-service ...`) commands. There is no
 * `aaa authentication fallback` command in the grammar, so the Click `fallback`
 * config is unreachable from the modal CLI.
 */
import { err } from "../../types";
import { registerModal } from "../registry";

registerModal({
  id: "aaa",
  views: ["configure-view"],
  keywords: ["aaa"],
  run({ isNo, args, delegate }) {
    if (args[0]?.toLowerCase() !== "authentication") return null;
    const sub = args[1]?.toLowerCase();

    // aaa authentication failthrough <enable|disable>  (no `no` form in the grammar)
    if (sub === "failthrough") {
      if (isNo) return null;
      const status = args[2];
      if (!status) return { output: [err("% AAA failthrough status required (enable|disable).")] };
      return { output: delegate(`config aaa authentication failthrough ${status}`) };
    }

    // aaa authentication login default <methods> | aaa authentication login-method <methods>
    const isLoginDefault = sub === "login" && args[2]?.toLowerCase() === "default";
    if (sub === "login-method" || isLoginDefault) {
      if (isNo) return { output: delegate("config aaa authentication login default") };
      const start = sub === "login-method" ? 2 : 3;
      // Drop the "group"/"remote" grouping keywords the KLISH grammar uses; the
      // ordered remainder is the method-list Click expects.
      const methods = args.slice(start).filter((t) => !["group", "remote"].includes(t.toLowerCase()));
      if (methods.length === 0) return { output: [err("% AAA login authentication method required.")] };
      return { output: delegate(`config aaa authentication login ${methods.join(" ")}`) };
    }

    return null;
  },
});
