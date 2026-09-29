/**
 * SSH — CONFIG-PLANE feature (no engine backend; store + show).
 *
 *   sonic(config)# ip ssh max-auth-retries 5              store a global SSHD option
 *   sonic(config)# ip ssh permit-root-login true
 *   sonic(config)# ip ssh ciphers aes128-ctr,aes192-ctr
 *   sonic(config)# no ip ssh permit-root-login            clear it
 *   sonic(config)# ip ssh client ciphers aes256-ctr       store an SSH-client option
 *   sonic(config)# no ip ssh client ciphers
 *   sonic# show ip ssh                                    render SSHD_COMMON from store
 *   sonic# show ip ssh client                             render SSHC_CONFIG from store
 *
 * Real box: CONFIG_DB SSHD_COMMON (global server) + SSHC_CONFIG (client). See
 * data/device-capture/klish-xml/ssh.xml. We store exactly what is configured and
 * render it back in the golden `show ip ssh` / `show ip ssh client` format —
 * nothing fabricated (no sshd defaults are invented for unset options). The
 * runtime effect (the sshd daemon actually honouring these settings, and its
 * accept/reject of live SSH sessions) is not simulated.
 *
 * The `ssh-server`/`ssh-server vrf` VRF-binding commands (ssh-vrf.xml) are a
 * separate sub-feature and are not modelled here.
 */
import { OutputLine, line, err, muted } from "../../types";
import { registerModal } from "../registry";
import { cpSet, cpUnset, cpGet } from "../config-plane";

type Kind = "bool" | "int" | "str";
interface Field {
  key: string; // KLISH subcommand name = CONFIG_DB field
  label: string; // exact label used by the box's `show` output
  kind: Kind;
}

// SSHD_COMMON (global server). Order matches the `show ip ssh` golden output.
const GLOBAL: Field[] = [
  { key: "ciphers", label: "Ciphers", kind: "str" },
  { key: "disable-forwarding", label: "Disable-forwarding", kind: "bool" },
  { key: "kexalgorithms", label: "Kexalgorithms", kind: "str" },
  { key: "macs", label: "Macs", kind: "str" },
  { key: "hostkeyalgorithms", label: "HostKeyalgorithms", kind: "str" },
  { key: "max-auth-retries", label: "Max-auth-retries", kind: "int" },
  { key: "permit-root-login", label: "Permit-root-login", kind: "bool" },
  { key: "permit-user-environment", label: "Permit-user-environment", kind: "bool" },
  { key: "x11-forwarding", label: "X11-forwarding", kind: "bool" },
  { key: "permit-user-rc", label: "Permit-user-rc", kind: "bool" },
  { key: "disable-password-authentication", label: "Disable-password-authentication", kind: "bool" },
  { key: "disable-publickey-authentication", label: "Disable-publickey-authentication", kind: "bool" },
];

// SSHC_CONFIG (client). Rendered by `show ip ssh client`.
const CLIENT: Field[] = [
  { key: "ciphers", label: "Ciphers", kind: "str" },
  { key: "kexalgorithms", label: "Kexalgorithms", kind: "str" },
  { key: "macs", label: "Macs", kind: "str" },
];

const DASH = "-".repeat(39);

/** Validate + normalise a value for storage; string result stores, object = error. */
function normalise(f: Field, value: string): string | { error: string } {
  if (f.kind === "bool") {
    const v = value.toLowerCase();
    if (v !== "true" && v !== "false") return { error: `% ${f.key} value must be true|false` };
    return v;
  }
  if (f.kind === "int") {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > 10) return { error: `% ${f.key} value must be an integer 0-10` };
    return String(n);
  }
  return value; // comma-separated algorithm list, stored verbatim
}

/** Render a stored value in the box's `show` style (BOOLs shown as True/False). */
function renderVal(f: Field, v: unknown): string {
  if (f.kind === "bool") return String(v).toLowerCase() === "true" ? "True" : "False";
  return String(v);
}

function renderSection(title: string, fields: Field[], st: Record<string, unknown>, prefix: string, width: number, empty: string): OutputLine[] {
  const rows = fields
    .filter((f) => st[prefix + f.key] !== undefined)
    .map((f) => line(`${f.label.padEnd(width)}: ${renderVal(f, st[prefix + f.key])}`));
  if (!rows.length) return [muted(empty)];
  return [line(DASH), line(title), line(DASH), ...rows];
}

// configure-view: `ip ssh <opt> <val>` (global) and `ip ssh client <opt> <val>`.
registerModal({
  id: "ssh",
  views: ["configure-view"],
  keywords: ["ip"],
  run({ isNo, args, ctx }) {
    if (args[0]?.toLowerCase() !== "ssh") return null; // not ours (e.g. `ip route`, `ip access-list`)
    const isClient = args[1]?.toLowerCase() === "client";
    const fields = isClient ? CLIENT : GLOBAL;
    const prefix = isClient ? "client:" : "";
    const optIdx = isClient ? 2 : 1;
    const opt = (args[optIdx] ?? "").toLowerCase();
    const f = fields.find((x) => x.key === opt);
    if (!f) return { output: [err(`% Unknown ip ssh${isClient ? " client" : ""} option "${args[optIdx] ?? ""}"`)] };
    if (isNo) {
      cpUnset(ctx.device, "ssh", prefix + f.key);
      return { output: [] };
    }
    const value = args[optIdx + 1];
    if (value === undefined) return { output: [err(`% ${f.key} requires a value`)] };
    const norm = normalise(f, value);
    if (typeof norm === "object") return { output: [err(norm.error)] };
    cpSet(ctx.device, "ssh", prefix + f.key, norm);
    return { output: [] };
  },
});

// enable-view: `show ip ssh` (global) and `show ip ssh client`.
registerModal({
  id: "ssh-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "ip" || args[1]?.toLowerCase() !== "ssh") return null; // not ours
    const st = cpGet(ctx.device, "ssh") ?? {};
    if (args[2]?.toLowerCase() === "client") {
      return { output: renderSection("SSH Client Configuration Parameters", CLIENT, st, "client:", 21, "No SSH client parameters configured") };
    }
    return { output: renderSection("SSH Global Information", GLOBAL, st, "", 31, "No SSH global parameters configured") };
  },
});
