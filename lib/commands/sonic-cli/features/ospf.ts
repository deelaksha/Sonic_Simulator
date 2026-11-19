/**
 * OSPFv2 KLISH behaviour (sonic-cli). Grammar from
 * data/device-capture/klish-xml/ospf.xml:
 *
 *   sonic(config)# router ospf [vrf <name>]           -> configure-router-ospf-view (ospf.xml:15)
 *   sonic(config)# no router ospf [vrf <name>]        -> removes the instance
 *   sonic(config-router-ospf)# ospf router-id 1.1.1.1
 *   sonic(config-router-ospf)# network 10.10.3.0/24 area 1
 *   sonic(config-router-ospf)# area 0.0.0.1 stub [no-summary] | nssa [no-summary]
 *   sonic(config-router-ospf)# area 0.0.0.1 range 10.1.0.0/16 [not-advertise|cost N] (ospf.xml:99)
 *   sonic(config-router-ospf)# redistribute connected|static|bgp [metric N] [metric-type 1|2] (ospf.xml:1057)
 *   sonic(config-router-ospf)# default-information originate [always] [metric N] [metric-type 1|2] (ospf.xml:580)
 *   sonic(config-router-ospf)# log-adjacency-changes [detail]                    (ospf.xml:763)
 *   sonic(config-router-ospf)# passive-interface Ethernet0 | default     (ospf.xml:1001)
 *   sonic(config-router-ospf)# auto-cost reference-bandwidth 100000
 *   sonic(config-if-Ethernet0)# ip ospf cost 38 | hello-interval 5 | dead-interval 20
 *   sonic(config-if-Ethernet0)# ip ospf priority 0 | network point-to-point | bfd | area 0
 *   sonic(config-if-Ethernet0)# no ip ospf <param> | no ip ospf interface
 *                                                    (configure-if/vlan/lag/lo/subif views, ospf.xml:1306+)
 *   sonic# show ip ospf neighbor                      -> show_ip_ospf_neighbor.j2 layout
 *
 * Every config line delegates to the Click `config router ospf …` commands
 * (lib/commands/sonic/ospf.ts); inside `router ospf vrf X` they become
 * `config router ospf vrf X …` (the VRF is the view context). Other `show ip ospf …` forms fall through to
 * the Click show layer (FRR vtysh layout). Unmodelled interface sub-commands
 * (authentication, mtu-ignore, …) return null and are stored by the generic
 * config-plane fallback.
 */
import { line } from "../../types";
import { registerModal } from "../registry";
import { subViewFrame } from "../../../sonic/grammar";
import { renderKlishNeighbors } from "../../../protocols/ospf-show";
import { vrfOf, DEFAULT_VRF } from "../../../models/vrf";

registerModal({
  id: "ospf-enter",
  views: ["configure-view"],
  keywords: ["router"],
  run({ isNo, args, delegate }) {
    if (args[0]?.toLowerCase() !== "ospf") return null; // not ours (e.g. `router bgp`)
    const vrf = args[1]?.toLowerCase() === "vrf" && args[2] && args[2] !== "default" ? args[2] : undefined;
    const base = vrf ? `config router ospf vrf ${vrf}` : "config router ospf";
    if (isNo) return { output: delegate(`${base} disable`) };
    return { output: delegate(`${base} enable`), enter: subViewFrame("configure-router-ospf-view", vrf ?? "") };
  },
});

registerModal({
  id: "ospf",
  views: ["configure-router-ospf-view"],
  keywords: ["ospf", "network", "area", "passive-interface", "auto-cost", "redistribute", "default-information", "log-adjacency-changes"],
  run({ head, isNo, args, viewctx, delegate }) {
    const no = isNo ? "no " : "";
    const base = viewctx ? `config router ospf vrf ${viewctx}` : "config router ospf";
    if (head === "ospf") {
      if (args[0]?.toLowerCase() !== "router-id") return null;
      if (isNo) return { output: delegate(`${base} no router-id`) };
      return { output: delegate(`${base} router-id ${args.slice(1).join(" ")}`) };
    }
    if (head === "network") return { output: delegate(`${base} ${no}network ${args.join(" ")}`) };
    if (head === "area") return { output: delegate(`${base} ${no}area ${args.join(" ")}`) };
    if (head === "passive-interface") return { output: delegate(`${base} ${no}passive-interface ${args.join(" ")}`) };
    if (head === "auto-cost" && args[0]?.toLowerCase() === "reference-bandwidth") {
      return { output: delegate(`${base} ${no}auto-cost reference-bandwidth ${args.slice(1).join(" ")}`) };
    }
    if (head === "redistribute") {
      if (args.includes("route-map")) return null; // route-maps not modelled
      return { output: delegate(`${base} ${no}redistribute ${(isNo ? args.slice(0, 1) : args).join(" ")}`) };
    }
    if (head === "default-information" && args[0]?.toLowerCase() === "originate") {
      if (args.includes("route-map")) return null;
      return { output: delegate(`${base} ${no}default-information originate ${isNo ? "" : args.slice(1).join(" ")}`.trim()) };
    }
    if (head === "log-adjacency-changes") return { output: delegate(`${base} ${no}log-adjacency-changes ${args.join(" ")}`.trim()) };
    return null;
  },
});

const IF_PARAMS = new Set(["cost", "hello-interval", "dead-interval", "priority", "network", "bfd", "area"]);

registerModal({
  id: "ospf-if",
  views: ["configure-if-view", "configure-vlan-view", "configure-lag-view", "configure-lo-view", "configure-subif-view"],
  keywords: ["ip"],
  run({ isNo, args, ifname, ctx, delegate }) {
    if (args[0]?.toLowerCase() !== "ospf" || !ifname) return null;
    const sub = args[1]?.toLowerCase();
    // Interface parameters belong to the instance of the interface's VRF.
    const vrf = vrfOf(ctx.device, ctx.device.interfaces.find((i) => i.name === ifname.replace(/\s+/g, "")));
    const base = vrf === DEFAULT_VRF ? "config router ospf" : `config router ospf vrf ${vrf}`;
    if (isNo && sub === "interface") return { output: delegate(`${base} no interface ${ifname}`) };
    if (!sub || !IF_PARAMS.has(sub)) return null;
    if (sub === "bfd" && args[2]?.toLowerCase() === "profile") return null; // BFD profiles not modelled
    if (sub === "dead-interval" && args[2]?.toLowerCase() === "minimal") return null; // fast hellos not modelled
    if (isNo) return { output: delegate(`${base} no interface ${ifname} ${sub}`) };
    // The optional trailing <ip-address> selects one address of the interface; the sim has one.
    const value = sub === "bfd" ? "" : (args[2] ?? "");
    return { output: delegate(`${base} interface ${ifname} ${sub} ${value}`.trim()) };
  },
});

registerModal({
  id: "ospf-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "ip" || args[1]?.toLowerCase() !== "ospf" || args[2]?.toLowerCase() !== "neighbor") return null;
    const filter = args.slice(3).join("") || undefined;
    return { output: renderKlishNeighbors(ctx.device, Date.now(), filter).map((t) => line(t)) };
  },
});
