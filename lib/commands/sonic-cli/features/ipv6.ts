/**
 * IPv6 modal behaviour (sonic-cli).
 *
 * Interface sub-views (configure-if-view / configure-vlan-view / configure-lag-view,
 * cli-xml/ipv6.xml):
 *   ipv6 address <X:X::X/M>      → config interface ipv6 add <ifname> <addr>
 *   no ipv6 address <X:X::X/M>   → config interface ipv6 del <ifname> <addr>
 *   ipv6 nd suppress-ra | ra-interval <1-1800> | managed-config-flag | other-config-flag
 *   no ipv6 nd suppress-ra | ra-interval | managed-config-flag | other-config-flag
 *                                (ipv6.xml:566-602) → radvd (lib/protocols/radv-daemon.ts)
 *
 * OSPFv3 — the KLISH tree has no ospfv3 view, so FRR ospf6d vtysh syntax is
 * accepted in the same places (frr/ospf6d/ospf6_top.c, ospf6_interface.c):
 *   sonic(config)# router ospf6                          -> configure-router-ospf6-view
 *   sonic(config)# no router ospf6
 *   sonic(config-router-ospf6)# ospf6 router-id A.B.C.D | no ospf6 router-id
 *   sonic(config-router-ospf6)# [no] log-adjacency-changes [detail]
 *   sonic(config-if-Ethernet0)# ipv6 ospf6 area A.B.C.D | cost <n> | hello-interval <n>
 *                               | dead-interval <n> | priority <n>
 *                               | network point-to-point|broadcast | passive
 *   sonic(config-if-Ethernet0)# no ipv6 ospf6 <param>
 * stored in device.config.features.ospf6 (lib/protocols/ospf6-config.ts).
 *
 * Other `ipv6 ...` forms (enable, address autoconfig, nd dad, nd-proxy, neighbor) return
 * null and fall through to the other handlers / grammar fallback.
 */
import { err, line } from "../../types";
import { registerModal } from "../registry";
import { subViewFrame } from "../../../sonic/grammar";
import { featureState } from "../../../models/feature-state";
import { isValidIpv4 } from "../../../models/ip";
import { normalizeArea } from "../../sonic/ospf";
import { ND_KEY, NdIfConfig, renderRaInterfaces } from "../../../protocols/radv-daemon";
import { OSPF6_KEY, Ospf6Config, Ospf6IfParams } from "../../../protocols/ospf6-config";

// `show ipv6 nd ra-interfaces [<if>]` (klish-xml/ipv6-neighbors.xml:1229, ifName PHY_PO_VL_SUBINTERFACE).
registerModal({
  id: "ipv6-nd-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ ctx, args }) {
    if (args[0]?.toLowerCase() !== "ipv6" || args[1]?.toLowerCase() !== "nd" || args[2]?.toLowerCase() !== "ra-interfaces") return null;
    const ifname = args.slice(3).join("") || undefined; // "Ethernet 0" -> "Ethernet0"
    return { output: renderRaInterfaces(ctx.device, ifname).map((t) => line(t)) };
  },
});

const IF_VIEWS = ["configure-if-view", "configure-vlan-view", "configure-lag-view"];

const ospf6 = (device: Parameters<typeof featureState>[0]) => featureState<Ospf6Config>(device, OSPF6_KEY, () => ({ ifParams: {} }));

registerModal({
  id: "ipv6",
  views: IF_VIEWS,
  keywords: ["ipv6"],
  run({ ctx, isNo, args, ifname, delegate }) {
    const sub = args[0]?.toLowerCase();
    const name = ifname ?? "";
    if (sub === "address") {
      // `ipv6 address autoconfig` is a distinct, unsupported command.
      if (args[1]?.toLowerCase() === "autoconfig") return null;
      return { output: delegate(`config interface ipv6 ${isNo ? "del" : "add"} ${name} ${args[1] ?? ""}`) };
    }
    if (sub === "nd") return nd(ctx.device, name, isNo, args.slice(1));
    if (sub === "ospf6") return ospf6If(ctx.device, name, isNo, args.slice(1));
    return null;
  },
});

function nd(device: Parameters<typeof featureState>[0], name: string, isNo: boolean, a: string[]) {
  const sub = a[0]?.toLowerCase();
  const all = featureState<Record<string, NdIfConfig>>(device, ND_KEY, () => ({}));
  const c = (all[name] ??= {});
  const done = () => {
    if (!Object.keys(c).length) delete all[name];
    return { output: [] };
  };
  if (sub === "suppress-ra") {
    if (isNo) delete c.suppressRa;
    else c.suppressRa = true;
    return done();
  }
  if (sub === "managed-config-flag") {
    if (isNo) delete c.managed;
    else c.managed = true;
    return done();
  }
  if (sub === "other-config-flag") {
    if (isNo) delete c.other;
    else c.other = true;
    return done();
  }
  if (sub === "ra-interval") {
    if (isNo) {
      delete c.raInterval;
      return done();
    }
    const v = Number(a[1]);
    if (!Number.isInteger(v) || v < 1 || v > 1800) return { output: [err("% Error: Invalid value for ra-interval-val (1-1800)")] };
    c.raInterval = v;
    return done();
  }
  done();
  return null; // `ipv6 nd dad …` etc.: grammar fallback
}

const NUM_PARAMS: Record<string, keyof Ospf6IfParams> = { cost: "cost", "hello-interval": "hello", "dead-interval": "dead", priority: "priority" };
const RANGES: Record<string, [number, number]> = { cost: [1, 65535], "hello-interval": [1, 65535], "dead-interval": [1, 65535], priority: [0, 255] };

function ospf6If(device: Parameters<typeof featureState>[0], name: string, isNo: boolean, a: string[]) {
  const sub = a[0]?.toLowerCase();
  if (!sub) return null;
  const cfg = ospf6(device);
  const p = (cfg.ifParams[name] ??= {});
  const done = () => {
    if (!Object.keys(p).length) delete cfg.ifParams[name];
    return { output: [] };
  };
  if (sub === "area") {
    if (isNo) {
      delete p.area;
      return done();
    }
    const area = normalizeArea(a[1]);
    if (!area) return { output: [err(`% Invalid area "${a[1] ?? ""}"`)] };
    p.area = area;
    return done();
  }
  if (sub === "passive") {
    if (isNo) delete p.passive;
    else p.passive = true;
    return done();
  }
  if (sub === "network") {
    if (isNo) {
      delete p.network;
      return done();
    }
    const t = a[1]?.toLowerCase();
    if (t !== "point-to-point" && t !== "broadcast") return { output: [err("% Error: network type must be point-to-point or broadcast")] };
    p.network = t;
    return done();
  }
  const key = NUM_PARAMS[sub];
  if (!key) {
    done();
    return null;
  }
  if (isNo) {
    delete p[key];
    return done();
  }
  const v = Number(a[1]);
  const [lo, hi] = RANGES[sub];
  if (!Number.isInteger(v) || v < lo || v > hi) return { output: [err(`% Error: ${sub} must be ${lo}-${hi}`)] };
  (p as Record<string, number>)[key] = v;
  return done();
}

registerModal({
  id: "ospf6-enter",
  views: ["configure-view"],
  keywords: ["router"],
  run({ ctx, isNo, args }) {
    if (args[0]?.toLowerCase() !== "ospf6") return null;
    if (isNo) {
      // Interface `ipv6 ospf6` lines stay (as in FRR), the instance goes away.
      if (ctx.device.config.features) delete ctx.device.config.features[OSPF6_KEY];
      return { output: [] };
    }
    ospf6(ctx.device);
    return { output: [], enter: subViewFrame("configure-router-ospf6-view") };
  },
});

registerModal({
  id: "ospf6",
  views: ["configure-router-ospf6-view"],
  keywords: ["ospf6", "log-adjacency-changes"],
  run({ ctx, head, isNo, args }) {
    const cfg = ospf6(ctx.device);
    if (head === "log-adjacency-changes") {
      if (isNo) cfg.logAdjacencyChanges = false;
      else cfg.logAdjacencyChanges = args[0]?.toLowerCase() === "detail" ? "detail" : true;
      return { output: [] };
    }
    if (args[0]?.toLowerCase() !== "router-id") return null;
    if (isNo) {
      delete cfg.routerId;
      return { output: [] };
    }
    const id = args[1];
    if (!id || !isValidIpv4(id) || id === "0.0.0.0") return { output: [err("% Malformed OSPF6 router-id")] };
    cfg.routerId = id;
    return { output: [] };
  },
});
