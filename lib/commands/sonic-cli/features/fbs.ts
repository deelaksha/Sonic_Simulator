/**
 * FBS (Flow-Based Services) modal behaviour (KLISH qos_fbs.xml). Config is
 * delegated to the tested `config fbs ...` Click commands
 * (lib/commands/sonic/fbs.ts); forwarding policies are enforced on routed
 * traffic by lib/protocols/pbr.ts, which also renders the shows.
 *
 *   configure-view:
 *     class-map <name> match-type fields [match-all]   → configure-fields-classifier-view
 *     policy-map <name> type <qos|forwarding|monitoring> → configure-policy-view
 *     no class-map <name> / no policy-map <name>
 *   configure-fields-classifier-view:
 *     match source-address|destination-address ip <cidr> | host <ip>
 *     match ip protocol <0-255|tcp|udp|icmp>, match dscp <0-63>, match vlan <id>, match pcp <0-7>
 *     match l4-port source|destination eq <port> | range <begin> <end>
 *     no match ..., description <text>
 *   configure-policy-view:
 *     class <name> [priority <n>]  → configure-<type>-flow-view;  no class <name>; description
 *   configure-forwarding-flow-view:
 *     set ip next-hop <ip> [vrf <name>] [priority <n>] | set interface <if>|null [priority <n>]
 *     no set ip next-hop <ip> | no set interface <if>|null; description
 *   configure-if-view / -vlan-view / -lag-view:
 *     service-policy type <t> <in|out> <policy> / no service-policy type <t> <in|out>
 *   enable-view:
 *     show class-map [<name>] | show policy-map [<name> | type <t>]
 *     show service-policy interface <if> [type <t>] | summary [interface <if>] | policy-map <name> [interface <if>]
 *     clear counters service-policy [interface <if> | policy-map <name>]
 */
import { err, muted, line, OutputLine } from "../../types";
import { registerModal } from "../registry";
import { subViewFrame } from "../../../sonic/grammar";
import { featureState, peekFeatureState } from "../../../models/feature-state";
import type { FbsState } from "../../sonic/fbs";
import { Device } from "../../../models/device";
import {
  renderClassMaps,
  renderPolicyMaps,
  renderServicePolicy,
  renderServicePolicySummary,
  clearServicePolicyCounters,
} from "../../../protocols/pbr";

const DIRECTIONS = ["in", "out"];
const USAGE = err("% Usage: service-policy type <type> <in|out> <policy>");

/** Keep only error lines of a delegated Click command (KLISH config is silent on success). */
const errorsOnly = (out: OutputLine[]) => out.filter((o) => o.kind === "error");

/** "Ethernet 4" / "Ethernet4" / "PortChannel 1" → interface name; returns [name, tokens consumed]. */
function ifName(toks: string[]): [string, number] {
  if (toks[0] && /^[A-Za-z]+$/.test(toks[0]) && toks[1] && /^\d+(\/\d+)*$/.test(toks[1])) return [`${toks[0]}${toks[1]}`, 2];
  return [toks[0] ?? "", toks[0] ? 1 : 0];
}

const fbs = (dev: Device) => featureState<FbsState>(dev, "fbs", () => ({ classifiers: [], policies: [], bindings: [] }));

registerModal({
  id: "fbs",
  views: ["configure-view", "configure-if-view", "configure-vlan-view", "configure-lag-view"],
  keywords: ["service-policy", "policy-map", "class-map"],
  run({ view, head, isNo, args, ifname, ctx, delegate }) {
    if (view === "configure-view") {
      if (head === "policy-map") {
        if (!args[0]) return { output: [err("% policy-map name required.")] };
        if (isNo) return { output: delegate(`config fbs policy del ${args[0]}`) };
        if (args[1]?.toLowerCase() !== "type" || !args[2]) return { output: [err("% Usage: policy-map <name> type <qos|forwarding|monitoring>")] };
        const e = errorsOnly(delegate(`config fbs policy add ${args[0]} ${args[2].toLowerCase()}`));
        return e.length ? { output: e } : { output: [], enter: subViewFrame("configure-policy-view", args[0]) };
      }
      if (head === "class-map") {
        if (!args[0]) return { output: [err("% class-map name required.")] };
        if (isNo) return { output: delegate(`config fbs classifier del ${args[0]}`) };
        if (args[1]?.toLowerCase() !== "match-type" || args[2]?.toLowerCase() !== "fields") return null; // acl / copp classifiers: not modelled
        delegate(`config fbs classifier add ${args[0]}`);
        return { output: [], enter: subViewFrame("configure-fields-classifier-view", args[0]) };
      }
      return null; // switch/global service-policy binds to "Switch", not modelled here
    }

    // Interface-family views: service-policy bind / unbind.
    if (head !== "service-policy") return null;
    const iface = ifname ?? "";
    if (args[0]?.toLowerCase() !== "type") return { output: [USAGE] };
    const type = args[1]?.toLowerCase();
    const dir = args[2]?.toLowerCase() ?? "";
    if (!type || !DIRECTIONS.includes(dir)) return { output: [USAGE] };

    if (isNo) {
      // KLISH omits the policy name here; resolve it from the stored binding.
      const st = peekFeatureState<FbsState>(ctx.device, "fbs");
      const bound = st
        ? st.bindings.find((b) => b.iface === iface && b.direction === dir && st.policies.find((p) => p.name === b.policy)?.type === type)
        : undefined;
      if (!bound) return { output: [muted(`${iface}: no ${type} service-policy bound ${dir} (no-op)`)] };
      return { output: delegate(`config fbs unbind ${bound.policy} ${iface} ${dir}`) };
    }

    const policy = args[3];
    if (!policy) return { output: [USAGE] };
    return { output: delegate(`config fbs bind ${policy} ${iface} ${dir}`) };
  },
});

/** `match ...` tokens (after "match") → Click field + value, or an error. */
function parseMatch(a: string[]): { field: string; value?: string } | { error: string } {
  const k = a.map((t) => t.toLowerCase());
  if (k[0] === "source-address" || k[0] === "destination-address") {
    if (k[1] !== "ip") return { error: "% Only IPv4 address matches are modelled (source-address|destination-address ip ...)" };
    const field = k[0] === "source-address" ? "src-ip" : "dst-ip";
    if (k[2] === undefined) return { field };
    return { field, value: k[2] === "host" ? `${a[3]}/32` : a[2] };
  }
  if (k[0] === "ip" && k[1] === "protocol") {
    const v = k[2] === undefined ? undefined : ({ tcp: "6", udp: "17", icmp: "1" } as Record<string, string>)[k[2]] ?? a[2];
    return { field: "ip-protocol", value: v };
  }
  if (k[0] === "dscp" || k[0] === "vlan" || k[0] === "pcp") return { field: k[0], value: a[1] };
  if (k[0] === "l4-port" && (k[1] === "source" || k[1] === "destination")) {
    const field = k[1] === "source" ? "src-port" : "dst-port";
    if (k[2] === undefined) return { field };
    if (k[2] === "eq") return { field, value: a[3] };
    if (k[2] === "range") return { field, value: `${a[3]}-${a[4]}` };
    return { error: "% Usage: match l4-port source|destination eq <port> | range <begin> <end>" };
  }
  return { error: `% Match '${a.join(" ")}' is not modelled` };
}

registerModal({
  id: "fbs-classifier",
  views: ["configure-fields-classifier-view"],
  keywords: ["match", "description"],
  run({ head, isNo, args, viewctx, ctx, delegate }) {
    const name = viewctx ?? "";
    if (head === "description") {
      const c = fbs(ctx.device).classifiers.find((x) => x.name === name);
      if (c) c.description = isNo ? undefined : args.join(" ");
      return { output: [] };
    }
    const m = parseMatch(args);
    if ("error" in m) return { output: [err(m.error)] };
    if (isNo) return { output: errorsOnly(delegate(`config fbs classifier no-match ${name} ${m.field}`)) };
    if (m.value === undefined) return { output: [err(`% match ${args.join(" ")}: value required`)] };
    return { output: errorsOnly(delegate(`config fbs classifier match ${name} ${m.field} ${m.value}`)) };
  },
});

registerModal({
  id: "fbs-policy",
  views: ["configure-policy-view"],
  keywords: ["class", "description"],
  run({ head, isNo, args, viewctx, ctx, delegate }) {
    const policy = viewctx ?? "";
    const p = fbs(ctx.device).policies.find((x) => x.name === policy);
    if (head === "description") {
      if (p) p.description = isNo ? undefined : args.join(" ");
      return { output: [] };
    }
    const cls = args[0];
    if (!cls) return { output: [err("% class name required.")] };
    if (isNo) return { output: errorsOnly(delegate(`config fbs policy flow del ${policy} ${cls}`)) };
    const pi = args.findIndex((t) => t.toLowerCase() === "priority");
    const existing = p?.flows.find((f) => f.classifier === cls);
    const prio = pi >= 0 ? args[pi + 1] : String(existing?.priority ?? 0);
    const e = errorsOnly(delegate(`config fbs policy flow add ${policy} ${cls} ${prio}`));
    if (e.length) return { output: e };
    return { output: [], enter: subViewFrame(`configure-${p?.type ?? "qos"}-flow-view`, `${policy} ${cls}`) };
  },
});

registerModal({
  id: "fbs-forwarding-flow",
  views: ["configure-forwarding-flow-view"],
  keywords: ["set", "description"],
  run({ head, isNo, args, viewctx, ctx, delegate }) {
    const [policy, cls] = (viewctx ?? "").split(" "); // "<policy> <class>" (frames use "|" as separator)
    if (head === "description") {
      const f = fbs(ctx.device).policies.find((x) => x.name === policy)?.flows.find((x) => x.classifier === cls);
      if (f) f.description = isNo ? undefined : args.join(" ");
      return { output: [] };
    }
    const k = args.map((t) => t.toLowerCase());
    let action: string;
    let target: string;
    let rest: string[];
    if (k[0] === "ip" && k[1] === "next-hop" && args[2]) {
      action = "set-ip-nexthop";
      target = args[2];
      rest = args.slice(3);
    } else if (k[0] === "interface" && args[1]) {
      action = "set-interface";
      const [n, used] = k[1] === "null" ? ["null", 1] : ifName(args.slice(1));
      target = n;
      rest = args.slice(1 + used);
    } else {
      return { output: [err("% Usage: set ip next-hop <ip> [vrf <name>] [priority <n>] | set interface <if>|null [priority <n>]")] };
    }
    if (isNo) return { output: errorsOnly(delegate(`config fbs policy flow no-action ${policy} ${cls} ${action} ${target}`)) };
    const opts: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const t = rest[i].toLowerCase();
      if ((t === "priority" || t === "vrf") && rest[i + 1] && !(t === "vrf" && rest[i + 1].toLowerCase() === "default")) opts.push(t, rest[i + 1]);
      if (t === "priority" || t === "vrf") i++;
    }
    return { output: errorsOnly(delegate(`config fbs policy flow action ${policy} ${cls} ${action} ${target} ${opts.join(" ")}`.trim())) };
  },
});

/** `interface <if...>` option anywhere in the tokens. */
function ifOpt(args: string[]): string | undefined {
  const i = args.findIndex((t) => t.toLowerCase() === "interface");
  return i >= 0 ? ifName(args.slice(i + 1))[0] || undefined : undefined;
}

function typeOpt(args: string[]): string | undefined {
  const i = args.findIndex((t) => t.toLowerCase() === "type");
  return i >= 0 ? args[i + 1]?.toLowerCase() : undefined;
}

const lines = (t: string[]) => ({ output: t.map((s) => line(s)) });

registerModal({
  id: "fbs-show",
  views: ["enable-view"],
  keywords: ["show", "clear"],
  run({ head, args, ctx }) {
    const k = args.map((t) => t.toLowerCase());
    const dev = ctx.device;
    if (head === "clear") {
      if (k[0] !== "counters" || k[1] !== "service-policy") return null;
      const pi = k.indexOf("policy-map");
      clearServicePolicyCounters(dev, { iface: ifOpt(args.slice(2)), policy: pi >= 0 ? args[pi + 1] : undefined });
      return { output: [] };
    }
    if (k[0] === "class-map") return lines(renderClassMaps(dev, k[1] === "match-type" ? undefined : args[1]));
    if (k[0] === "policy-map") return lines(renderPolicyMaps(dev, k[1] === "type" ? undefined : args[1], typeOpt(args)));
    if (k[0] !== "service-policy") return null;
    if (k[1] === "summary") return lines(renderServicePolicySummary(dev, ifOpt(args.slice(2))));
    if (k[1] === "interface") return lines(renderServicePolicy(dev, { iface: ifName(args.slice(2))[0], type: typeOpt(args) }));
    if (k[1] === "policy-map" && args[2]) return lines(renderServicePolicy(dev, { policy: args[2], iface: ifOpt(args.slice(3)) }));
    return null;
  },
});
