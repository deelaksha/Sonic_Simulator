/**
 * LDAP — CONFIG-PLANE feature (no engine backend; store + show).
 *
 *   sonic(config)# ldap-server binddn dc=sji,dc=example,dc=com   global option
 *   sonic(config)# ldap-server nss ssl start_tls                 nss/pam/sudo option
 *   sonic(config)# ldap-server host 1.1.1.1 use-type nss priority 1 ssl on retry 2
 *   sonic(config)# ldap-server vrf Vrf1
 *   sonic(config)# ldap-server source-interface Loopback 3
 *   sonic(config)# no ldap-server binddn                         clear
 *   sonic# show ldap-server                                      render from stored state
 *
 * Modelled after the banner config-plane template: config commands write to the
 * config-plane store and `show ldap-server` renders exactly what was configured.
 * LDAP authentication itself (contacting servers, authenticating users) is a
 * data-plane the sim does not model — only CONFIG_DB is stored and reflected.
 *
 * Real KLISH: data/device-capture/klish-xml/ldap.xml (configure-view) and
 * show_ldap.xml (enable-view `show ldap-server`).
 */
import { line, err, muted } from "../../types";
import { registerModal } from "../registry";
import { cpSet, cpUnset, cpUpsert, cpRemove, cpGet } from "../config-plane";

// Option keywords accepted after `ldap-server [nss|pam|sudo]`. The global set is
// a superset of the per-type sets in ldap.xml, so it validates every scope.
const OPTIONS = new Set([
  "timelimit", "bind-timelimit", "idle-timelimit", "retry", "port", "scope",
  "version", "base", "ssl", "binddn", "bindpw", "security-profile",
  "pam-filter", "pam-login-attribute", "pam-group-dn", "pam-member-attribute",
  "sudoers-base", "sudoers-search-filter", "nss-base-passwd", "nss-base-group",
  "nss-base-shadow", "nss-base-netgroup", "nss-base-sudoers",
  "nss-initgroups-ignoreusers", "nss-skipmembers",
]);

const TYPES = ["nss", "pam", "sudo"]; // scopes with a leading keyword; anything else is "global"
const TYPE_TITLE: Record<string, string> = { global: "Global", nss: "NSS", pam: "PAM", sudo: "SUDO" };
const HOST_FIELDS: Record<string, string> = { "use-type": "use_type", port: "port", priority: "priority", ssl: "ssl", retry: "retry" };

// configure-view: `ldap-server ...`
registerModal({
  id: "ldap",
  views: ["configure-view"],
  keywords: ["ldap-server"],
  run({ isNo, args, ctx }) {
    const sub = (args[0] ?? "").toLowerCase();

    if (sub === "host") {
      const name = args[1];
      if (!name) return { output: [err("% ldap-server host requires a hostname or IP address.")] };
      if (isNo) {
        cpRemove(ctx.device, "ldap", "hosts", "name", name);
        return { output: [] };
      }
      const item: Record<string, unknown> = { name };
      for (let i = 2; i < args.length; i += 2) {
        const field = HOST_FIELDS[args[i].toLowerCase()];
        if (!field) return { output: [err(`% Unknown ldap-server host option "${args[i]}".`)] };
        if (!args[i + 1]) return { output: [err(`% ldap-server host ${args[i]} requires a value.`)] };
        item[field] = args[i + 1];
      }
      cpUpsert(ctx.device, "ldap", "hosts", item, "name");
      return { output: [] };
    }

    if (sub === "vrf") {
      if (isNo) { cpUnset(ctx.device, "ldap", "global.vrf"); return { output: [] }; }
      if (!args[1]) return { output: [err("% ldap-server vrf requires a VRF name.")] };
      cpSet(ctx.device, "ldap", "global.vrf", args[1]);
      return { output: [] };
    }

    if (sub === "source-interface") {
      if (isNo) { cpUnset(ctx.device, "ldap", "global.source-interface"); return { output: [] }; }
      if (!args[1] || !args[2]) return { output: [err("% ldap-server source-interface requires an interface type and id.")] };
      cpSet(ctx.device, "ldap", "global.source-interface", `${args[1]} ${args[2]}`);
      return { output: [] };
    }

    // Scalar option: `ldap-server <opt> <val>` (global) or `ldap-server <type> <opt> <val>`.
    const scoped = TYPES.includes(sub);
    const type = scoped ? sub : "global";
    const optIdx = scoped ? 1 : 0;
    const opt = (args[optIdx] ?? "").toLowerCase();
    if (!opt) return { output: [err("% ldap-server requires an option.")] };
    if (!OPTIONS.has(opt)) return { output: [err(`% Unknown ldap-server option "${opt}".`)] };
    const key = `${type}.${opt}`;
    if (isNo) { cpUnset(ctx.device, "ldap", key); return { output: [] }; }
    const val = args[optIdx + 1];
    if (!val) return { output: [err(`% ldap-server ${opt} requires a value.`)] };
    cpSet(ctx.device, "ldap", key, val);
    return { output: [] };
  },
});

const SEP1 = "-".repeat(57);
const SEP2 = "-".repeat(80);
const kv = (k: string, v: unknown): string => `${k.padEnd(21)}: ${v}`;

// enable-view: `show ldap-server` — render exactly what was stored.
registerModal({
  id: "ldap-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "ldap-server") return null; // not ours
    const st = cpGet(ctx.device, "ldap") ?? {};
    const out = [];

    for (const type of ["global", "nss", "pam", "sudo"]) {
      const prefix = `${type}.`;
      const opts = Object.entries(st).filter(([k]) => k.startsWith(prefix));
      if (!opts.length) continue;
      out.push(line(SEP1), line(`LDAP ${TYPE_TITLE[type]} Configuration`), line(SEP1));
      for (const [k, v] of opts) out.push(line(kv(k.slice(prefix.length), v)));
    }

    const hosts = (st.hosts as Record<string, unknown>[] | undefined) ?? [];
    if (hosts.length) {
      out.push(line(SEP2));
      out.push(line(`${"HOST".padEnd(16)}${"USE-TYPE".padEnd(10)}${"PORT".padEnd(10)}${"PRIORITY".padEnd(9)}${"SSL".padEnd(10)}RETRY`));
      out.push(line(SEP2));
      for (const h of hosts) {
        const cell = (v: unknown) => (v == null ? "-" : String(v));
        out.push(line(
          `${cell(h.name).padEnd(16)}` +
          `${cell(h.use_type).toUpperCase().padEnd(10)}` +
          `${cell(h.port).padEnd(10)}` +
          `${cell(h.priority).padEnd(9)}` +
          `${cell(h.ssl).toUpperCase().padEnd(10)}` +
          `${cell(h.retry)}`,
        ));
      }
    }

    return { output: out.length ? out : [muted("No LDAP configuration")] };
  },
});
