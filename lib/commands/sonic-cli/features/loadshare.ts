/**
 * IP load-share (ECMP hashing) — CONFIG-PLANE feature (no engine backend; store + show).
 *
 *   sonic(config)# ip load-share hash seed <val>                    store scalar
 *   sonic(config)# ip load-share hash offset <0-15> | flow-based    store scalar
 *   sonic(config)# ip load-share hash algorithm <algo>              store scalar
 *   sonic(config)# ip load-share hash roce qpn                      store scalar (flag)
 *   sonic(config)# ip load-share hash ingress-port                  store scalar (flag)
 *   sonic(config)# ip load-share hash ipv4 <field>                  store list item
 *   sonic(config)# ip load-share hash ipv6 <field>                  store list item
 *   sonic(config)# ip load-share hash udf <name> offset <o> size <s> l3-proto <p> [l4-dst-port <d>]
 *   sonic(config)# ip load-share hash resilient nhg-optimization threshold <pct>
 *   sonic(config)# ip load-share hash resilient ip|ipv6 <prefix> [vrf <v>] [size <s>] [seed <s>]
 *   sonic(config)# no ip load-share hash ...                        clear
 *   sonic# show ip load-share [resilient]                           render from stored state
 *
 * Mirrors the real box's ECMP_LOADSHARE_TABLE_* / SWITCH CONFIG_DB tables (see
 * data/device-capture/klish-xml/loadshare.xml): config is stored honestly and
 * `show ip load-share` renders exactly what was set. Nothing is fabricated —
 * unset parameters are simply not shown. The DATA plane (the actual ECMP hash
 * bucket selection / packet distribution the ASIC performs from these fields) is
 * NOT simulated; only the configuration is modelled.
 */
import { OutputLine, line, err, muted } from "../../types";
import { registerModal } from "../registry";
import { cpSet, cpUnset, cpUpsert, cpRemove, cpGet } from "../config-plane";

const IPV4_FIELDS = ["ipv4-src-ip", "ipv4-dst-ip", "ipv4-ip-proto", "ipv4-l4-src-port", "ipv4-l4-dst-port", "symmetric"];
const IPV6_FIELDS = ["ipv6-src-ip", "ipv6-dst-ip", "ipv6-next-hdr", "ipv6-flow-label", "ipv6-l4-src-port", "ipv6-l4-dst-port", "symmetric"];
const ALL_KEYS = ["seed", "offset", "algorithm", "roce", "ingress-port", "rh-threshold", "ipv4", "ipv6", "udf", "rh"];

/** Parse trailing `<key> <value>` option pairs starting at index `start`. */
function opts(args: string[], start: number): Record<string, string> {
  const o: Record<string, string> = {};
  for (let i = start; i + 1 < args.length; i += 2) o[args[i].toLowerCase()] = args[i + 1];
  return o;
}

// configure-view: `ip load-share hash ...` (and the `no` forms).
registerModal({
  id: "loadshare",
  views: ["configure-view"],
  keywords: ["ip"],
  run({ isNo, args, ctx }) {
    if (args[0]?.toLowerCase() !== "load-share") return null; // not ours (ip route, ip ssh, ...)
    const dev = ctx.device;

    // `ip load-share` / `ip load-share hash` parents: no-op on set, clear-all on `no`.
    const sub = (args[1]?.toLowerCase() === "hash" ? args[2] : "")?.toLowerCase() ?? "";
    if (!sub) {
      if (isNo) ALL_KEYS.forEach((k) => cpUnset(dev, "loadshare", k));
      return { output: [] };
    }

    switch (sub) {
      case "seed": {
        if (isNo) {
          cpUnset(dev, "loadshare", "seed");
          return { output: [] };
        }
        if (!/^\d+$/.test(args[3] ?? "")) return { output: [err("% hash seed value must be a number")] };
        cpSet(dev, "loadshare", "seed", args[3]);
        return { output: [] };
      }
      case "offset": {
        if (isNo) {
          cpUnset(dev, "loadshare", "offset");
          return { output: [] };
        }
        const v = (args[3] ?? "").toLowerCase();
        if (v !== "flow-based" && !(/^\d+$/.test(v) && Number(v) <= 15))
          return { output: [err("% hash offset must be 0-15 or flow-based")] };
        cpSet(dev, "loadshare", "offset", v);
        return { output: [] };
      }
      case "algorithm": {
        if (isNo) {
          cpUnset(dev, "loadshare", "algorithm");
          return { output: [] };
        }
        if (!args[3]) return { output: [err("% hash algorithm value required")] };
        cpSet(dev, "loadshare", "algorithm", args[3]);
        return { output: [] };
      }
      case "roce": {
        if (isNo) {
          cpUnset(dev, "loadshare", "roce");
          return { output: [] };
        }
        cpSet(dev, "loadshare", "roce", "qpn");
        return { output: [] };
      }
      case "ingress-port": {
        if (isNo) {
          cpUnset(dev, "loadshare", "ingress-port");
          return { output: [] };
        }
        cpSet(dev, "loadshare", "ingress-port", "enabled");
        return { output: [] };
      }
      case "ipv4":
      case "ipv6": {
        const fields = sub === "ipv4" ? IPV4_FIELDS : IPV6_FIELDS;
        const field = (args[3] ?? "").toLowerCase();
        if (!fields.includes(field)) return { output: [err(`% ${sub} hash field must be one of ${fields.join("|")}`)] };
        if (isNo) {
          cpRemove(dev, "loadshare", sub, "field", field);
          return { output: [] };
        }
        cpUpsert(dev, "loadshare", sub, { field }, "field");
        return { output: [] };
      }
      case "udf": {
        const name = args[3];
        if (!name) return { output: [err("% udf name required")] };
        if (isNo) {
          cpRemove(dev, "loadshare", "udf", "name", name);
          return { output: [] };
        }
        const o = opts(args, 4);
        if (!o.offset || !o.size || !o["l3-proto"]) return { output: [err("% udf requires offset, size and l3-proto")] };
        const item: Record<string, unknown> = { name, offset: o.offset, size: o.size, l3proto: o["l3-proto"] };
        if (o["l4-dst-port"] !== undefined) item.l4dstport = o["l4-dst-port"];
        cpUpsert(dev, "loadshare", "udf", item, "name");
        return { output: [] };
      }
      case "resilient": {
        const kind = (args[3] ?? "").toLowerCase();
        if (kind === "nhg-optimization") {
          if (isNo) {
            cpUnset(dev, "loadshare", "rh-threshold");
            return { output: [] };
          }
          if (!/^\d+$/.test(args[5] ?? "")) return { output: [err("% nhg-optimization threshold must be a number")] };
          cpSet(dev, "loadshare", "rh-threshold", args[5]);
          return { output: [] };
        }
        if (kind === "ip" || kind === "ipv6") {
          const prefix = args[4];
          if (!prefix) return { output: [err("% resilient hash prefix required")] };
          if (isNo) {
            cpRemove(dev, "loadshare", "rh", "prefix", prefix);
            return { output: [] };
          }
          const o = opts(args, 5);
          const item: Record<string, unknown> = { family: kind, prefix };
          if (o.vrf !== undefined) item.vrf = o.vrf;
          if (o.size !== undefined) item.size = o.size;
          if (o.seed !== undefined) item.seed = o.seed;
          cpUpsert(dev, "loadshare", "rh", item, "prefix");
          return { output: [] };
        }
        return { output: [err("% resilient: expected nhg-optimization|ip|ipv6")] };
      }
      default:
        return { output: [err(`% Unknown ip load-share hash option "${args[2]}"`)] };
    }
  },
});

const PAD = 22;
function row(label: string, val: string): OutputLine {
  return line(`${label.padEnd(PAD)}: ${val}`);
}

/** `show ip load-share` — general hash configuration. */
function renderGeneral(st: Record<string, unknown>): OutputLine[] {
  const rows: OutputLine[] = [];
  if (st.seed !== undefined) rows.push(row("Hash Seed", String(st.seed)));
  if (st.offset !== undefined) rows.push(row("Hash Offset", String(st.offset)));
  if (st.algorithm !== undefined) rows.push(row("Hash Algorithm", String(st.algorithm)));
  if (st.roce !== undefined) rows.push(row("ROCE QPN Hash", "Enabled"));
  if (st["ingress-port"] !== undefined) rows.push(row("Ingress Port Hash", "Enabled"));
  const ipv4 = (st.ipv4 as Record<string, unknown>[] | undefined) ?? [];
  if (ipv4.length) rows.push(row("IPv4 Hash Fields", ipv4.map((f) => String(f.field)).join(", ")));
  const ipv6 = (st.ipv6 as Record<string, unknown>[] | undefined) ?? [];
  if (ipv6.length) rows.push(row("IPv6 Hash Fields", ipv6.map((f) => String(f.field)).join(", ")));
  const udf = (st.udf as Record<string, unknown>[] | undefined) ?? [];
  if (udf.length) {
    rows.push(line("UDF Fields:"));
    for (const u of udf) {
      let s = `  ${String(u.name)}  offset ${String(u.offset)}  size ${String(u.size)}  l3-proto ${String(u.l3proto)}`;
      if (u.l4dstport !== undefined) s += `  l4-dst-port ${String(u.l4dstport)}`;
      rows.push(line(s));
    }
  }
  if (!rows.length) return [muted("No IP load-share hash parameters configured")];
  return [line("ECMP Load-share Configuration"), line("-".repeat(40)), ...rows];
}

/** `show ip load-share resilient` — resilient-hash configuration. */
function renderResilient(st: Record<string, unknown>): OutputLine[] {
  const rows: OutputLine[] = [];
  if (st["rh-threshold"] !== undefined) rows.push(row("NHG Optimization Threshold", String(st["rh-threshold"])));
  const rh = (st.rh as Record<string, unknown>[] | undefined) ?? [];
  if (rh.length) {
    rows.push(line("Resilient Hash Prefixes:"));
    for (const p of rh) {
      let s = `  ${String(p.family)}  ${String(p.prefix)}`;
      if (p.vrf !== undefined) s += `  vrf ${String(p.vrf)}`;
      if (p.size !== undefined) s += `  size ${String(p.size)}`;
      if (p.seed !== undefined) s += `  seed ${String(p.seed)}`;
      rows.push(line(s));
    }
  }
  if (!rows.length) return [muted("No IP load-share resilient hash configured")];
  return [line("ECMP Resilient Hash Configuration"), line("-".repeat(40)), ...rows];
}

// enable-view: `show ip load-share [resilient]`.
registerModal({
  id: "loadshare-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "ip" || args[1]?.toLowerCase() !== "load-share") return null; // not ours
    const st = cpGet(ctx.device, "loadshare") ?? {};
    if (args[2]?.toLowerCase() === "resilient") return { output: renderResilient(st) };
    return { output: renderGeneral(st) };
  },
});
