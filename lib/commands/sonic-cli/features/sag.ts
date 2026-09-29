/**
 * Static Anycast Gateway (SAG) — CONFIG-PLANE feature. There is no Click module
 * and no packet/engine backend, so we STORE exactly what is configured
 * (SAG_GLOBAL + per-interface SAG_LIST in CONFIG_DB) and RENDER it back on
 * `show`. Nothing runtime is fabricated: SAG is a data-plane feature (the box
 * answers ARP/ND for the anycast gateway IP/MAC and routes for it) that this sim
 * does not forward for — dataPlaneNotSimulated. The operational Admin/Oper state
 * shown by the real box is therefore not invented here.
 *
 * Wired from data/device-capture/klish-xml/sag.xml:
 *
 * configure-view (global SAG_GLOBAL):
 *   ip anycast-mac-address <MAC>                 store global anycast gateway MAC
 *   ip anycast-mac-address router-mac-for-forwarding   use router MAC for forwarding
 *   ip anycast-address enable|disable            global IPv4 SAG admin state
 *   ipv6 anycast-address enable|disable          global IPv6 SAG admin state
 *   no ip anycast-mac-address [router-mac-for-forwarding]
 *   no ip|ipv6 anycast-address
 *
 * configure-vlan-view / configure-subif-view (per-interface SAG_LIST):
 *   ip anycast-address <A.B.C.D/M>               add IPv4 gateway address
 *   ipv6 anycast-address <X:X::X/M>              add IPv6 gateway address
 *   no ip|ipv6 anycast-address [<addr>]          remove one / all of that family
 *
 * enable-view:
 *   show ip static-anycast-gateway               render IPv4 config
 *   show ipv6 static-anycast-gateway             render IPv6 config
 */
import { line, err, muted, OutputLine } from "../../types";
import { registerModal } from "../registry";
import { cpSet, cpUnset, cpGet, cpUpsert, cpRemove, cpList } from "../config-plane";

const FEATURE = "sag";
const MAC_RE = /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/;

interface SagGw {
  id: string; // "<iface>|<family>|<addr>"
  iface: string;
  family: "IPv4" | "IPv6";
  addr: string;
}

// configure-view: global SAG_GLOBAL settings.
registerModal({
  id: "sag",
  views: ["configure-view"],
  keywords: ["ip", "ipv6"],
  run({ head, isNo, args, ctx }) {
    const sub = (args[0] ?? "").toLowerCase();

    // ip anycast-mac-address <MAC> | router-mac-for-forwarding
    if (head === "ip" && sub === "anycast-mac-address") {
      const arg = args[1];
      if (isNo) {
        if ((arg ?? "").toLowerCase() === "router-mac-for-forwarding") {
          cpUnset(ctx.device, FEATURE, "rmac-forwarding");
        } else {
          cpUnset(ctx.device, FEATURE, "gwmac");
          cpUnset(ctx.device, FEATURE, "rmac-forwarding");
        }
        return { output: [] };
      }
      if (!arg) return { output: [err("% Usage: ip anycast-mac-address <MAC> | router-mac-for-forwarding")] };
      if (arg.toLowerCase() === "router-mac-for-forwarding") {
        cpSet(ctx.device, FEATURE, "rmac-forwarding", "enable");
        return { output: [] };
      }
      if (!MAC_RE.test(arg)) return { output: [err(`% Invalid MAC address "${arg}".`)] };
      cpSet(ctx.device, FEATURE, "gwmac", arg);
      if ((args[2] ?? "").toLowerCase() === "router-mac-for-forwarding") cpSet(ctx.device, FEATURE, "rmac-forwarding", "enable");
      return { output: [] };
    }

    // ip|ipv6 anycast-address enable|disable — global admin state.
    if (sub === "anycast-address") {
      const key = head === "ipv6" ? "ipv6-enable" : "ipv4-enable";
      if (isNo) {
        cpUnset(ctx.device, FEATURE, key);
        return { output: [] };
      }
      const st = (args[1] ?? "").toLowerCase();
      if (st !== "enable" && st !== "disable") return { output: [err(`% Usage: ${head} anycast-address enable|disable`)] };
      cpSet(ctx.device, FEATURE, key, st);
      return { output: [] };
    }

    return null; // not ours (e.g. `ip route`, `ipv6 route`)
  },
});

// configure-vlan-view / configure-subif-view: per-interface gateway addresses.
registerModal({
  id: "sag-if",
  views: ["configure-vlan-view", "configure-subif-view"],
  keywords: ["ip", "ipv6"],
  run({ head, isNo, args, ifname, ctx }) {
    if ((args[0] ?? "").toLowerCase() !== "anycast-address") return null; // not ours (e.g. `ip address`)
    const iface = ifname ?? "";
    const family: SagGw["family"] = head === "ipv6" ? "IPv6" : "IPv4";
    const addr = args[1];

    // Bare `no ip|ipv6 anycast-address` — clear every gateway of this family on the interface.
    if (isNo && !addr) {
      for (const g of cpList(ctx.device, FEATURE, "gateways") as unknown as SagGw[]) {
        if (g.iface === iface && g.family === family) cpRemove(ctx.device, FEATURE, "gateways", "id", g.id);
      }
      return { output: [] };
    }
    if (!addr) return { output: [err(`% Usage: ${head} anycast-address <addr/mask>`)] };
    if (!addr.includes("/")) return { output: [err("% Anycast address must include a prefix length (addr/mask).")] };
    const looksV6 = addr.includes(":");
    if (family === "IPv6" && !looksV6) return { output: [err(`% Invalid IPv6 address "${addr}".`)] };
    if (family === "IPv4" && looksV6) return { output: [err(`% Invalid IPv4 address "${addr}".`)] };

    const id = `${iface}|${family}|${addr}`;
    if (isNo) {
      cpRemove(ctx.device, FEATURE, "gateways", "id", id);
      return { output: [] };
    }
    cpUpsert(ctx.device, FEATURE, "gateways", { id, iface, family, addr }, "id");
    return { output: [] };
  },
});

// enable-view: `show ip|ipv6 static-anycast-gateway` — render only configured values.
registerModal({
  id: "sag-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    const fam = (args[0] ?? "").toLowerCase();
    if ((fam !== "ip" && fam !== "ipv6") || args[1]?.toLowerCase() !== "static-anycast-gateway") return null; // not ours
    const family: SagGw["family"] = fam === "ipv6" ? "IPv6" : "IPv4";

    const st = cpGet(ctx.device, FEATURE) ?? {};
    const gws = (cpList(ctx.device, FEATURE, "gateways") as unknown as SagGw[]).filter((g) => g.family === family);
    const enableKey = family === "IPv6" ? "ipv6-enable" : "ipv4-enable";

    const out: OutputLine[] = [];
    out.push(line(`Configured Anycast Gateway MAC address: ${(st.gwmac as string) ?? "not configured"}`));
    if (st["rmac-forwarding"] === "enable") out.push(line("Router MAC address used as source MAC for forwarding: enable"));
    // Default admin state is enable (per the box); reflect the configured override if any.
    out.push(line(`${family} Anycast Gateway MAC address: ${(st[enableKey] as string) ?? "enable"}`));
    out.push(line(`Total number of gateway: ${gws.length}`));

    if (gws.length) {
      out.push(line(`${"Interfaces".padEnd(11)}${"Gateway Address".padEnd(21)}Vrf`));
      out.push(muted(`${"----------".padEnd(11)}${"---------------".padEnd(21)}------`));
      for (const g of gws) out.push(line(`${g.iface.padEnd(11)}${g.addr.padEnd(21)}`));
      out.push(muted("% Admin/Oper state is runtime operational data; SAG forwarding is not simulated in this lab."));
    } else {
      out.push(muted("No anycast gateways configured"));
    }
    return { output: out };
  },
});
