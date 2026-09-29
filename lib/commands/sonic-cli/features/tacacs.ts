/**
 * TACACS+ modal behaviour. configure-view (KLISH `tacacs-server ...`):
 *   tacacs-server host <host> [port <n>] [timeout <n>] [key <k> [encrypted]]
 *                            [type <t>] [priority <n>] [vrf mgmt]   add/update a server
 *   no tacacs-server host <host>                                     delete a server
 *   tacacs-server timeout <1-60>                                     global timeout
 *   tacacs-server auth-type <pap|chap|mschap|login>                  global auth-type
 *   tacacs-server key <secret> [encrypted]                          global shared secret
 * Delegates to the tested Click `config tacacs add/delete/timeout/authtype/passkey`.
 *
 * Skipped (no `config tacacs` equivalent): `tacacs-server source-interface`, and the
 * global unset forms `no tacacs-server {timeout,auth-type,key,source-interface}` —
 * the Click layer can only set global values, not clear them.
 */
import { err, muted } from "../../types";
import { registerModal } from "../registry";

/** KLISH `port <n> timeout <n> key <k> [encrypted] type <t> priority <n> vrf mgmt` -> `config tacacs add` flags. */
function buildHostOpts(rest: string[]): string {
  const parts: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const kw = rest[i].toLowerCase();
    const val = rest[i + 1];
    if (kw === "port" && val !== undefined) parts.push(`-o ${rest[++i]}`);
    else if (kw === "timeout" && val !== undefined) parts.push(`-t ${rest[++i]}`);
    else if (kw === "key" && val !== undefined) parts.push(`-k ${rest[++i]}`);
    else if (kw === "type" && val !== undefined) parts.push(`-a ${rest[++i]}`);
    else if (kw === "priority" && val !== undefined) parts.push(`-p ${rest[++i]}`);
    else if (kw === "vrf" && val?.toLowerCase() === "mgmt") { parts.push("-m"); i++; }
    // "encrypted" and any stray tokens are ignored (no Click equivalent).
  }
  return parts.length ? ` ${parts.join(" ")}` : "";
}

registerModal({
  id: "tacacs",
  views: ["configure-view"],
  keywords: ["tacacs-server"],
  run({ isNo, args, delegate }) {
    const sub = args[0]?.toLowerCase() ?? "";

    if (sub === "host") {
      const host = args[1];
      if (!host) return { output: [err("% TACACS+ server host required.")] };
      if (isNo) return { output: delegate(`config tacacs delete ${host}`) };
      return { output: delegate(`config tacacs add ${host}${buildHostOpts(args.slice(2))}`) };
    }

    if (sub === "timeout") {
      if (isNo) return { output: [muted("(no tacacs-server timeout: global timeout cannot be unset via config tacacs)")] };
      if (!args[1]) return { output: [err("% timeout value required.")] };
      return { output: delegate(`config tacacs timeout ${args[1]}`) };
    }

    if (sub === "auth-type") {
      if (isNo) return { output: [muted("(no tacacs-server auth-type: global auth-type cannot be unset via config tacacs)")] };
      if (!args[1]) return { output: [err("% auth-type value required.")] };
      return { output: delegate(`config tacacs authtype ${args[1]}`) };
    }

    if (sub === "key") {
      if (isNo) return { output: [muted("(no tacacs-server key: global key cannot be unset via config tacacs)")] };
      if (!args[1]) return { output: [err("% key value required.")] };
      return { output: delegate(`config tacacs passkey ${args[1]}`) };
    }

    if (sub === "source-interface") {
      return { output: [muted("(tacacs-server source-interface is not modelled — no config tacacs equivalent)")] };
    }

    return null;
  },
});
