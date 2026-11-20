/**
 * KLISH `show ipv6 ospfv3 [vrf <name>] …` (ospfv3.xml:4242) over the ospf6d model
 * (lib/protocols/ospf6-daemon.ts). Mirrors the OSPFv2 split in ospf.ts: the
 * neighbor table renders the KLISH template, the other forms the ospf6d vtysh
 * layout the Click `show ipv6 ospf6 …` already prints.
 *
 *   show ipv6 ospfv3 neighbor [<if>]    sonic_cli_show_ospfv3.py generate_show_ipv6_ospf_interfaces
 *                                       → show_ipv6_ospf_neighbor.j2 (sm-occli/brcm_files/version4.5/cli)
 *   show ipv6 ospfv3 [interface [<if>] | database]   ospf6-show.ts renderers
 *   show ipv6 ospfv3 route              ospf6_route.c ospf6_route_show ("%c%1s %2s %-30s %-25s %6.*s %s")
 *   show ipv6 ospfv3 border-routers     show_ipv6_ospf_border_routers.j2
 * No instance → "% OSPFv3 instance not found" (check_ospfv3_instance in the actioner).
 */
import { OutputLine, line } from "../../types";
import { registerModal } from "../registry";
import { findInterface } from "../../../models/device";
import { ospf6Config } from "../../../protocols/ospf6-config";
import { ospf6Runtime, nsm6Name } from "../../../protocols/ospf6-daemon";
import { renderOspf6Database, renderOspf6Interface, renderOspf6Summary, timerstring } from "../../../protocols/ospf6-show";

const L = (rows: string[]): { output: OutputLine[] } => ({ output: rows.map((r) => line(r)) });

/** "Ethernet 0" / "Ethernet0" → one name. */
const ifArg = (t: string[]) => (t[1] && /^\d/.test(t[1]) ? t[0] + t[1] : t[0]);

registerModal({
  id: "klish-ospfv3-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    const a = args.map((x) => x.toLowerCase());
    if (a[0] !== "ipv6" || a[1] !== "ospfv3") return null;
    let i = 2;
    let vrf = "default";
    if (a[i] === "vrf") {
      vrf = args[i + 1] ?? "default";
      i += 2;
    }
    const dev = ctx.device;
    // ospf6d runs in the default VRF only.
    if (!ospf6Config(dev) || vrf !== "default") return L(["% OSPFv3 instance not found"]);
    const now = Date.now();
    const sub = a[i];
    const rt = ospf6Runtime(dev);

    if (!sub) return L(renderOspf6Summary(dev, now));
    if (sub === "interface") return L(renderOspf6Interface(dev, now, args[i + 1] ? ifArg(args.slice(i + 1)) : undefined));
    if (sub === "database") return L(renderOspf6Database(dev, now));

    if (sub === "neighbor") {
      const want = args[i + 1] && a[i + 1] !== "detail" ? ifArg(args.slice(i + 1)) : undefined;
      const out = [`VRF Name: ${vrf}`, "Neighbor ID     Pri    DeadTime      State/IfState      Duration         Interface[State]"];
      for (const oif of rt?.oifs ?? []) {
        if (want && oif.name !== want) continue;
        for (const n of oif.nbrs) {
          // template: DR / BDR by router-id, "-" when no DR elected (point-to-point), else DROther
          const role = n.dr === "0.0.0.0" || oif.type === "point-to-point" ? "-" : n.rid === n.dr ? "DR" : n.rid === n.bdr ? "BDR" : "DROther";
          out.push(`${n.rid.padEnd(15)} ${String(Math.max(0, n.priority)).padEnd(3)} ${timerstring(n.deadDue - now).padStart(11)}      ${`${nsm6Name(n.state)}/${role}`.padEnd(13)}      ${timerstring(now - n.progressMs).padEnd(16)} ${`${oif.name}[${oif.state}]`.padEnd(22)}`);
        }
      }
      return L([...out, " "]);
    }

    if (sub === "route") {
      // Intra-area network routes ospf6d installed in the RIB (one SPF area in every lab).
      const rows = (dev.routingTable6 ?? []).filter((r) => r.type === "ospf" && (r.vrf ?? "default") === "default");
      return L(
        rows.map((r) => {
          const ifn = findInterface(dev, r.interfaceId)?.name ?? "";
          return `*N IA ${`${r.destination}/${r.prefix}`.padEnd(30)} ${(r.nextHop ?? "::").padEnd(25)} ${ifn.padStart(6)} ${timerstring(now - (r.installedAtMs ?? now))}`;
        }),
      );
    }

    // Single-area labs have no ABR / ASBR to list.
    if (sub === "border-routers") return L([`VRF Name: ${vrf}`, "Router-ID       Rtr-Bits Options        Path-Type  Area", " "]);
    return null;
  },
});
