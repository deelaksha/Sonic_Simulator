/**
 * DHCP Snooping — CONFIG-PLANE feature (no engine/packet backend; store + show).
 *
 *   sonic(config)# ip dhcp snooping                     enable v4 globally
 *   sonic(config)# ip dhcp snooping Vlan10,20           enable v4 on vlan(s)
 *   sonic(config)# ip dhcp snooping verify mac-address  enable v4 MAC verification
 *   sonic(config-if-Ethernet0)# ip dhcp snooping trust  mark port trusted
 *   sonic(config)# no ip dhcp snooping ...              clear each of the above
 *   sonic# show ip dhcp snooping                        render from stored state
 *   (the `ipv6 dhcp snooping ...` / `show ipv6 dhcp snooping` family mirrors v4)
 *
 * We model the real box's CONFIG_DB honestly: config commands write to the
 * config-plane store and `show ip|ipv6 dhcp snooping` renders exactly what was
 * configured — nothing is fabricated. DHCP snooping's DATA plane (inspecting
 * DHCP exchanges, learning dynamic bindings, dropping rogue traffic) is NOT
 * simulated; the binding-database and statistics `show` subcommands are runtime
 * data, so they are left to fall through rather than invented here.
 */
import { line, err } from "../../types";
import { registerModal } from "../registry";
import { cpSet, cpUnset, cpUpsert, cpRemove, cpGet, cpList } from "../config-plane";

const ID = "dhcp_snooping";

/** "ip" -> v4 store prefix, "ipv6" -> v6. */
const famOf = (head: string): "v4" | "v6" => (head === "ipv6" ? "v6" : "v4");

// configure-view: `[no] ip|ipv6 dhcp snooping [<vlan-range> | verify mac-address]`.
registerModal({
  id: "dhcp-snooping",
  views: ["configure-view"],
  keywords: ["ip", "ipv6"],
  run({ head, isNo, args, ctx }) {
    // Only `ip|ipv6 dhcp snooping ...` is ours (not `ip dhcp-relay`, `ip route`, ...).
    if (args[0]?.toLowerCase() !== "dhcp" || args[1]?.toLowerCase() !== "snooping") return null;
    const fam = famOf(head);
    const rest = args.slice(2);

    // `ip dhcp snooping verify mac-address`
    if (rest[0]?.toLowerCase() === "verify") {
      if (rest[1]?.toLowerCase() !== "mac-address") return { output: [err("% Only 'verify mac-address' is supported.")] };
      if (isNo) cpUnset(ctx.device, ID, `${fam}_verify_mac`);
      else cpSet(ctx.device, ID, `${fam}_verify_mac`, true);
      return { output: [] };
    }

    // `ip dhcp snooping <vlan-range>` (e.g. Vlan20,70-100,142) — stored as configured.
    if (rest.length > 0) {
      const vlan = rest.join(" ");
      if (isNo) cpRemove(ctx.device, ID, `${fam}_vlans`, "vlan", vlan);
      else cpUpsert(ctx.device, ID, `${fam}_vlans`, { vlan }, "vlan");
      return { output: [] };
    }

    // Bare `ip dhcp snooping` — global enable/disable.
    if (isNo) cpUnset(ctx.device, ID, `${fam}_enabled`);
    else cpSet(ctx.device, ID, `${fam}_enabled`, true);
    return { output: [] };
  },
});

// configure-if-view: `[no] ip|ipv6 dhcp snooping trust` — mark the port trusted.
registerModal({
  id: "dhcp-snooping-trust",
  views: ["configure-if-view"],
  keywords: ["ip", "ipv6"],
  run({ head, isNo, args, ifname, ctx }) {
    if (args[0]?.toLowerCase() !== "dhcp" || args[1]?.toLowerCase() !== "snooping") return null;
    if (args[2]?.toLowerCase() !== "trust") return null;
    const fam = famOf(head);
    const iface = ifname ?? "";
    if (isNo) cpRemove(ctx.device, ID, `${fam}_trust`, "iface", iface);
    else cpUpsert(ctx.device, ID, `${fam}_trust`, { iface }, "iface");
    return { output: [] };
  },
});

// enable-view: `show ip|ipv6 dhcp snooping` — render global config from the store.
registerModal({
  id: "dhcp-snooping-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    const a0 = args[0]?.toLowerCase();
    if (a0 !== "ip" && a0 !== "ipv6") return null; // not ours
    if (args[1]?.toLowerCase() !== "dhcp" || args[2]?.toLowerCase() !== "snooping") return null;
    if (args[3] !== undefined) return null; // `binding`/`statistics` are runtime data — not modelled

    const fam = famOf(a0);
    const st = cpGet(ctx.device, ID) ?? {};
    const enabled = st[`${fam}_enabled`] ? "Enabled" : "Disabled";
    const verify = st[`${fam}_verify_mac`] ? "enabled" : "disabled";
    const vlans = cpList(ctx.device, ID, `${fam}_vlans`).map((v) => String(v.vlan)).join(",");
    const trusted = cpList(ctx.device, ID, `${fam}_trust`);

    const out = [
      line(`DHCP snooping is ${enabled}`),
      line(`DHCP snooping source MAC verification is ${verify}`),
      line(`DHCP snooping is enabled on the following VLANs: ${vlans}`),
      line(""),
      line(`${"Interface".padEnd(12)}Trusted`),
      line(`${"-----------".padEnd(12)}----------`),
    ];
    for (const t of trusted) out.push(line(`${String(t.iface).padEnd(12)}Yes`));
    return { output: out };
  },
});
