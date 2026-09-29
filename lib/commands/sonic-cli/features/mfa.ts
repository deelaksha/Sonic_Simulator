/**
 * MFA (multi-factor authentication) — CONFIG-PLANE feature (no engine backend).
 *
 *   sonic(config)# mfa key-seed <seed> [encrypted]
 *   sonic(config)# mfa security-profile <name>
 *   sonic(config)# mfa client-secret <secret> [encrypted]
 *   sonic(config)# mfa rsa-server host <hostname> [port <p>]
 *                    [client-id <id> client-key <key> [encrypted]]
 *                    [connection-timeout <t>] [read-timeout <t>]
 *   sonic(config)# mfa rsa-server security-profile <name>
 *   sonic(config)# no mfa <key-seed|security-profile|client-secret|rsa-server ...>
 *   sonic# show mfa
 *   sonic# show mfa rsa-servers
 *
 * Mirrors the real box's sonic-mfa CONFIG_DB tables: every `mfa ...` command
 * writes to the config-plane store and `show mfa` renders exactly what was
 * configured. The runtime effect — actually authenticating users against the
 * RSA SecurID servers via the MFA REST service — is NOT simulated here; only the
 * stored configuration is reflected. Secrets are never echoed back.
 */
import { line, err, muted } from "../../types";
import { registerModal } from "../registry";
import { cpSet, cpUnset, cpGet, cpUpsert, cpRemove } from "../config-plane";
import { Device } from "../../../models/device";

const SUBS = ["key-seed", "security-profile", "client-secret", "rsa-server"];

type RsaServer = {
  hostname: string;
  port?: string;
  clientId?: string;
  clientKey?: string;
  encrypted?: boolean;
  connectionTimeout?: string;
  readTimeout?: string;
};

// configure-view: all `mfa ...` config commands (and their `no` forms).
registerModal({
  id: "mfa",
  views: ["configure-view"],
  keywords: ["mfa"],
  run({ isNo, args, ctx }) {
    const dev = ctx.device;
    const sub = (args[0] ?? "").toLowerCase();
    switch (sub) {
      case "key-seed": {
        if (isNo) { cpUnset(dev, "mfa", "keySeed"); return { output: [] }; }
        const seed = args[1];
        if (!seed) return { output: [err("% MFA key seed string required")] };
        const encrypted = (args[2] ?? "").toLowerCase() === "encrypted";
        cpSet(dev, "mfa", "keySeed", { seed, encrypted });
        return { output: [] };
      }
      case "security-profile": {
        if (isNo) { cpUnset(dev, "mfa", "securityProfile"); return { output: [] }; }
        const name = args[1];
        if (!name) return { output: [err("% MFA security profile name required")] };
        cpSet(dev, "mfa", "securityProfile", name);
        return { output: [] };
      }
      case "client-secret": {
        if (isNo) { cpUnset(dev, "mfa", "clientSecret"); return { output: [] }; }
        const secret = args[1];
        if (!secret) return { output: [err("% MFA client secret required")] };
        const encrypted = (args[2] ?? "").toLowerCase() === "encrypted";
        cpSet(dev, "mfa", "clientSecret", { secret, encrypted });
        return { output: [] };
      }
      case "rsa-server":
        return rsaServer(isNo, args, dev);
      default:
        return { output: [err(`% mfa parameter must be one of ${SUBS.join("|")}`)] };
    }
  },
});

function rsaServer(isNo: boolean, args: string[], dev: Device) {
  const what = (args[1] ?? "").toLowerCase();
  if (what === "security-profile") {
    if (isNo) { cpUnset(dev, "mfa", "rsaSecurityProfile"); return { output: [] }; }
    const name = args[2];
    if (!name) return { output: [err("% RSA security profile name required")] };
    cpSet(dev, "mfa", "rsaSecurityProfile", name);
    return { output: [] };
  }
  if (what === "host") {
    const rest = args.slice(2);
    const hostname = rest[0];
    if (!hostname) return { output: [err("% RSA server hostname required")] };
    if (isNo) { cpRemove(dev, "mfa", "rsaServers", "hostname", hostname); return { output: [] }; }
    const item: Record<string, unknown> = { hostname };
    let i = 1;
    while (i < rest.length) {
      const k = rest[i].toLowerCase();
      if (k === "port") { item.port = rest[++i]; i++; }
      else if (k === "client-id") { item.clientId = rest[++i]; i++; }
      else if (k === "client-key") { item.clientKey = rest[++i]; i++; }
      else if (k === "encrypted") { item.encrypted = true; i++; }
      else if (k === "connection-timeout") { item.connectionTimeout = rest[++i]; i++; }
      else if (k === "read-timeout") { item.readTimeout = rest[++i]; i++; }
      else i++;
    }
    cpUpsert(dev, "mfa", "rsaServers", item, "hostname");
    return { output: [] };
  }
  return { output: [err("% mfa rsa-server parameter must be one of host|security-profile")] };
}

// enable-view: `show mfa` / `show mfa rsa-servers` — render from stored config.
registerModal({
  id: "mfa-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "mfa") return null; // not ours
    const st = cpGet(ctx.device, "mfa") ?? {};
    if (args[1]?.toLowerCase() === "rsa-servers") return { output: renderRsaServers(st) };
    return { output: renderMfa(st) };
  },
});

function renderMfa(st: Record<string, unknown>) {
  const keySeed = st.keySeed as { encrypted?: boolean } | undefined;
  const secProfile = st.securityProfile as string | undefined;
  const clientSecret = st.clientSecret as { encrypted?: boolean } | undefined;
  const rsaProfile = st.rsaSecurityProfile as string | undefined;
  const servers = (st.rsaServers as RsaServer[] | undefined) ?? [];
  if (!keySeed && !secProfile && !clientSecret && !rsaProfile && !servers.length) {
    return [muted("MFA not configured")];
  }
  const out = [];
  out.push(line(`Security profile     : ${secProfile ?? "not set"}`));
  out.push(line(`RSA security profile : ${rsaProfile ?? "not set"}`));
  out.push(line(`Key seed             : ${keySeed ? `configured${keySeed.encrypted ? " (encrypted)" : ""}` : "not set"}`));
  out.push(line(`Client secret        : ${clientSecret ? `configured${clientSecret.encrypted ? " (encrypted)" : ""}` : "not set"}`));
  out.push(line(`RSA servers          : ${servers.length}`));
  return out;
}

function renderRsaServers(st: Record<string, unknown>) {
  const servers = (st.rsaServers as RsaServer[] | undefined) ?? [];
  if (!servers.length) return [muted("No RSA servers configured")];
  const out = [];
  for (const s of servers) {
    out.push(line(`RSA server: ${s.hostname}`));
    out.push(line(`  Port               : ${s.port ?? "5555 (default)"}`));
    if (s.clientId) out.push(line(`  Client ID          : ${s.clientId}`));
    if (s.clientKey) out.push(line(`  Client key         : configured${s.encrypted ? " (encrypted)" : ""}`));
    out.push(line(`  Connection timeout : ${s.connectionTimeout ?? "20 (default)"}`));
    out.push(line(`  Read timeout       : ${s.readTimeout ?? "120 (default)"}`));
  }
  return out;
}
