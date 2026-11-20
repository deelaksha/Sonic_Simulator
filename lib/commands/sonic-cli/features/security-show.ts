/**
 * KLISH `show` for crypto / object-groups / per-interface ACL counters (enable-view):
 *
 *   show crypto                                 pki.xml:190 — keyword container (no ACTION)
 *   show crypto ca-cert all|file <n>|<n>        pki.xml:191-201 → show_pki_ca_cert.j2
 *   show crypto cert all|file <n>|<n>           pki.xml:202-212 → show_pki_host_cert.j2
 *       sonic_cli_pki.py:445-455 renders only when the RPC returns certificates; a lab
 *       switch has none installed (crypto ca-cert/cert install are not simulated), so
 *       nothing is printed.
 *   show crypto ssh-key ecdsa|rsa               pki.xml:218-224 → show_crypto_sshkey_rpc.j2
 *       prints the switch's SSH host public key (one OpenSSH line). The simulated switch's
 *       key is derived deterministically from its id (stable across shows, distinct per switch).
 *   show object-groups [<name> | type network]  acl.xml:193-201 → show_object_group.j2
 *       object-group config is not in the device grammar this lab accepts, so none exist:
 *       the template iterates an empty dict and prints nothing.
 *   show {ip|ipv6|mac} access-lists <name> interface <if> | Switch
 *       acl.xml:121-140 → show_access_list_intf.j2 via
 *       sonic_cli_acl.py:1346-1421 (__get_and_show_acl_counters_by_name_and_intf):
 *       "interface <if>" / "Switch" heading, the ACL with its stage, rules with counters.
 */
import { CommandContext, OutputLine, err, line } from "../../types";
import { registerModal } from "../registry";
import { peekFeatureState } from "../../../models/feature-state";
import { AclState, AclType, counterKey, ruleData, ruleName } from "../../../protocols/acl-rules";
import { ifArg, incomplete, noAction } from "./klish-show-util";

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Deterministic pseudo-random base64 body seeded by the device id (xorshift32). */
function keyBody(seed: string, len: number): string {
  let x = 2166136261;
  for (const c of seed) x = Math.imul(x ^ c.charCodeAt(0), 16777619) >>> 0;
  let s = "";
  for (let i = 0; i < len; i++) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    s += B64[x & 63];
  }
  return s;
}

function sshKey(ctx: CommandContext, kind: "ecdsa" | "rsa"): string {
  const host = ctx.device.config.hostname ?? ctx.device.name;
  if (kind === "ecdsa") {
    // ecdsa-sha2-nistp256 wire header (key type + curve + 0x04 point prefix) is fixed.
    return `ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBB${keyBody(ctx.device.id + "ecdsa", 87)}= root@${host}`;
  }
  return `ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQ${keyBody(ctx.device.id + "rsa", 514)}= root@${host}`;
}

const ACL_TYPES: Record<string, AclType> = { ip: "ip", ipv6: "ipv6", mac: "mac" };

function aclOnInterface(ctx: CommandContext, type: AclType, name: string, where: string): OutputLine[] {
  const st = peekFeatureState<AclState>(ctx.device, "acl");
  const t = st?.tables.find((x) => x.name === name && (x.type ?? "ip") === type);
  // The REST GET of the ACL / its interface binding fails → response.error_message().
  if (!t || (where !== "Switch" && !t.ports.includes(where)) || (where === "Switch" && !t.ports.includes("Switch"))) {
    return [err("%Error: Resource not found")];
  }
  const stage = (t.stage ?? "ingress").toLowerCase() === "egress" ? "Egress" : "Ingress";
  const out = [line(where === "Switch" ? "Switch" : `interface ${where}`), line(`   ${type} access-list ${name} at ${stage}`)];
  if (t.description) out.push(line(`    remark ${t.description}`));
  for (const r of [...(st!.rules[name] ?? [])].sort((a, b) => a.seq - b.seq)) {
    const c = st!.counters?.[counterKey(name, ruleName(r.seq))] ?? { packets: 0, bytes: 0 };
    out.push(line(`      seq ${r.seq} ${ruleData(type, r)} (${c.packets} packets) [${c.bytes} bytes]`));
    if (r.remark) out.push(line(`        remark ${r.remark}`));
  }
  return out;
}

registerModal({
  id: "security-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    const a = args.map((x) => x.toLowerCase());

    if (a[0] === "crypto") {
      if (a[1] === undefined) return noAction();
      if (a[1] === "ca-cert" || a[1] === "cert") return a[2] ? { output: [] } : incomplete();
      if (a[1] === "ssh-key") {
        if (a[2] !== "ecdsa" && a[2] !== "rsa") return incomplete();
        return { output: [line(sshKey(ctx, a[2]))] };
      }
      return null;
    }

    if (a[0] === "object-groups") {
      if (a[1] === "type" && a[2] !== "network") return incomplete();
      return { output: [] };
    }

    const type = ACL_TYPES[a[0]];
    if (type && a[1] === "access-lists" && args[2] && (a[3] === "interface" || a[3] === "switch")) {
      if (a[3] === "switch") return { output: aclOnInterface(ctx, type, args[2], "Switch") };
      const p = ifArg(args, 4);
      if (!p) return incomplete();
      return { output: aclOnInterface(ctx, type, args[2], p.name) };
    }
    return null;
  },
});
