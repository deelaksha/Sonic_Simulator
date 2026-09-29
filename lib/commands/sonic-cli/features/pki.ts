/**
 * PKI (crypto) — CONFIG-PLANE feature (no engine backend; store + show).
 *
 *   sonic(config)# crypto trust-store <name> ca-cert <ca-cert-name>
 *   sonic(config)# no crypto trust-store <name>
 *   sonic(config)# crypto security-profile <name>
 *   sonic(config)# crypto security-profile certificate <name> <cert>
 *   sonic(config)# crypto security-profile trust-store <name> <store>
 *   sonic(config)# crypto security-profile cdp-list  <name> <url>
 *   sonic(config)# crypto security-profile ocsp-list <name> <url>
 *   sonic(config)# crypto security-profile <name> [key-usage-check true|false]
 *                        [peer-name-check true|false] [revocation-check true|false] [vrf mgmt]
 *   sonic(config)# no crypto security-profile <name> [certificate|trust-store|...]
 *   sonic# show crypto trust-store [name]        render TRUST_STORES from store
 *   sonic# show crypto security-profile [name]   render SECURITY_PROFILES from store
 *
 * Mirrors the real box's sonic-pki CONFIG_DB tables (TRUST_STORES /
 * SECURITY_PROFILES, see data/device-capture/klish-xml/pki.xml): configuration is
 * stored honestly and `show` renders exactly what was set — nothing fabricated.
 *
 * NOT modelled (data-plane): the enable-view crypto operations that touch real
 * files/keys — `crypto ca-cert install/delete/verify`, `crypto cert
 * install/delete/verify`, `crypto cert generate request`, `crypto ssh-keygen`,
 * and the `show crypto ca-cert|cert|ssh-key` displays of installed certs/keys.
 * Those read/write actual PKI material the sim cannot produce, so they are left
 * to the grammar fallback rather than faked.
 */
import { OutputLine, line, err, muted } from "../../types";
import { registerModal } from "../registry";
import { cpUpsert, cpRemove, cpList } from "../config-plane";

// security-profile field sub-keywords that take an explicit <profile> <value>.
const SP_RESERVED = ["certificate", "trust-store", "cdp-list", "ocsp-list"];

interface SpField {
  key: string; // stored field = KLISH sub-keyword
  label: string; // label used by `show`
  bool?: boolean; // rendered True/False
}
// Display order for `show crypto security-profile`.
const SP_FIELDS: SpField[] = [
  { key: "certificate", label: "Certificate" },
  { key: "trust-store", label: "Trust Store" },
  { key: "cdp-list", label: "CDP List" },
  { key: "ocsp-list", label: "OCSP List" },
  { key: "key-usage-check", label: "Key Usage Check", bool: true },
  { key: "peer-name-check", label: "Peer Name Check", bool: true },
  { key: "revocation-check", label: "Revocation Check", bool: true },
  { key: "vrf", label: "VRF" },
];

// Optional checks for the bare `crypto security-profile <name> ...` form.
const SP_OPTS: Record<string, { bool?: boolean; vrf?: boolean }> = {
  "key-usage-check": { bool: true },
  "peer-name-check": { bool: true },
  "revocation-check": { bool: true },
  vrf: { vrf: true },
};

function renderBool(v: unknown): string {
  return String(v).toLowerCase() === "true" ? "True" : "False";
}

// configure-view: `crypto trust-store ...` / `crypto security-profile ...`.
registerModal({
  id: "pki",
  views: ["configure-view"],
  keywords: ["crypto"],
  run({ isNo, args, ctx }) {
    const sub = (args[0] ?? "").toLowerCase();
    const dev = ctx.device;

    if (sub === "trust-store") {
      const name = args[1];
      if (!name) return { output: [err("% trust-store name required")] };
      if (isNo) {
        cpRemove(dev, "pki", "trust_stores", "name", name);
        return { output: [] };
      }
      if ((args[2] ?? "").toLowerCase() !== "ca-cert" || !args[3])
        return { output: [err("% usage: crypto trust-store <name> ca-cert <ca-cert-name>")] };
      cpUpsert(dev, "pki", "trust_stores", { name, "ca-cert": args[3] }, "name");
      return { output: [] };
    }

    if (sub === "security-profile") {
      const kw = (args[1] ?? "").toLowerCase();

      // field forms: certificate|trust-store|cdp-list|ocsp-list <profile> [<value>]
      if (SP_RESERVED.includes(kw)) {
        const profile = args[2];
        if (!profile) return { output: [err("% security-profile name required")] };
        if (isNo) {
          const item = cpList(dev, "pki", "security_profiles").find((e) => e["profile-name"] === profile);
          if (item) delete item[kw];
          return { output: [] };
        }
        const value = args[3];
        if (!value) return { output: [err(`% ${kw} value required`)] };
        cpUpsert(dev, "pki", "security_profiles", { "profile-name": profile, [kw]: value }, "profile-name");
        return { output: [] };
      }

      // bare form: crypto security-profile <profile> [key-usage-check <bool>] ...
      const profile = args[1];
      if (!profile) return { output: [err("% security-profile name required")] };

      if (isNo) {
        const optKw = (args[2] ?? "").toLowerCase();
        if (!optKw) {
          cpRemove(dev, "pki", "security_profiles", "profile-name", profile);
          return { output: [] };
        }
        if (!SP_OPTS[optKw]) return { output: [err(`% unknown security-profile option "${args[2]}"`)] };
        const item = cpList(dev, "pki", "security_profiles").find((e) => e["profile-name"] === profile);
        if (item) delete item[optKw];
        return { output: [] };
      }

      // create/ensure the profile, then apply any optional checks.
      cpUpsert(dev, "pki", "security_profiles", { "profile-name": profile }, "profile-name");
      for (let i = 2; i < args.length; i += 2) {
        const optKw = args[i].toLowerCase();
        const opt = SP_OPTS[optKw];
        if (!opt) return { output: [err(`% unknown security-profile option "${args[i]}"`)] };
        const val = (args[i + 1] ?? "").toLowerCase();
        if (opt.bool && val !== "true" && val !== "false")
          return { output: [err(`% ${optKw} value must be true|false`)] };
        if (opt.vrf && val !== "mgmt") return { output: [err("% vrf value must be mgmt")] };
        cpUpsert(dev, "pki", "security_profiles", { "profile-name": profile, [optKw]: val }, "profile-name");
      }
      return { output: [] };
    }

    return null; // not ours (e.g. `crypto fips` belongs to another feature)
  },
});

// enable-view: `show crypto trust-store` / `show crypto security-profile`.
registerModal({
  id: "pki-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if ((args[0] ?? "").toLowerCase() !== "crypto") return null; // not ours
    const sub = (args[1] ?? "").toLowerCase();
    const dev = ctx.device;

    if (sub === "trust-store") {
      const filter = args[2];
      let stores = cpList(dev, "pki", "trust_stores");
      if (filter) stores = stores.filter((s) => s.name === filter);
      if (!stores.length) return { output: [muted("No trust stores configured")] };
      const out: OutputLine[] = [];
      for (const s of stores) {
        out.push(line(`Trust Store: ${String(s.name)}`));
        out.push(line(`  CA Certificate: ${String(s["ca-cert"] ?? "-")}`));
      }
      return { output: out };
    }

    if (sub === "security-profile") {
      const filter = args[2];
      let profs = cpList(dev, "pki", "security_profiles");
      if (filter) profs = profs.filter((p) => p["profile-name"] === filter);
      if (!profs.length) return { output: [muted("No security profiles configured")] };
      const out: OutputLine[] = [];
      for (const p of profs) {
        out.push(line(`Security Profile: ${String(p["profile-name"])}`));
        for (const f of SP_FIELDS) {
          const v = p[f.key];
          if (v === undefined) continue;
          out.push(line(`  ${f.label.padEnd(17)}: ${f.bool ? renderBool(v) : String(v)}`));
        }
      }
      return { output: out };
    }

    return null; // show crypto ca-cert|cert|ssh-key are runtime cert/key ops — not simulated
  },
});
