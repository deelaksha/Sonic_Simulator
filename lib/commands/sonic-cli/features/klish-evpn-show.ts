/**
 * KLISH `show evpn …` / `show vxlan …` forms with no handler yet. The EVPN shows
 * run FRR zebra through the show-bgp-evpn RPC and dump its text
 * (sonic_cli_show_evpn.py get_evpn → dump.j2), so they print zebra's vty layout:
 *
 *   show evpn                    show_evpn.xml:13   zebra_vxlan.c zebra_vxlan_print_evpn + zebra_evpn_mh_print
 *   show evpn es-evi [detail]    show_evpn.xml:154/170  zebra_evpn_mh.c zebra_evpn_es_evi_show
 *   show evpn es-evi vni <vni>   show_evpn.xml:186  zebra_evpn_es_evi_show_vni
 *   show evpn l2-nh              show_evpn.xml:203  zebra_evpn_l2_nh_show
 *   show vxlan | show vxlan remote            vxlan.xml:17/130 — container COMMANDs, no ACTION: nothing printed
 *   show vxlan remote nexthop-group           vxlan.xml:219, sonic_cli_vxlan show_vxlan_remote_nhg → show_vxlan_remote_nhg.j2
 *
 * State: the VTEP/VNI maps (lib/protocols/vxlan.ts), the ES config and the remote
 * ES peers learnt from type-1/type-4 routes (lib/protocols/evpn-mh.ts).
 */
import { OutputLine, line } from "../../types";
import { registerModal } from "../registry";
import { Device } from "../../../models/device";
import { peekFeatureState } from "../../../models/feature-state";
import { vlanMembers } from "../../../models/vlan-ops";
import { cpGet } from "../config-plane";
import { l2Maps, vxlanConfig, VxlanConfig } from "../../../protocols/vxlan";
import { l3Vnis } from "../../../protocols/vxlan-daemon";
import { EsPeer, localEss } from "../../../protocols/evpn-mh";

const L = (rows: string[]): { output: OutputLine[] } => ({ output: rows.map((r) => line(r)) });
const ipNum = (ip: string) => ip.split(".").reduce((n, o) => n * 256 + Number(o), 0);

/** zebra only learns VNIs once bgpd enabled EVPN (advertise-all-vni) on a configured VTEP. */
function evpnCfg(dev: Device): VxlanConfig | undefined {
  const cfg = vxlanConfig(dev);
  const bgp = dev.config.features?.bgp as { advertiseAllVni?: boolean } | undefined;
  return cfg && cfg.sourceIp && cfg.nvo && bgp?.advertiseAllVni ? cfg : undefined;
}

/** ESI → remote VTEP → what it advertised (type-1 / type-4). */
const esPeerTable = (dev: Device) => peekFeatureState<{ peers: Record<string, Record<string, EsPeer>> }>(dev, "evpn-mh-rt")?.peers ?? {};

// zebra_evpn_mh.h: EVPN_NH_ID_TYPE_BIT (2 << 24), EVPN_NHG_ID_TYPE_BIT (3 << 24) on top of a 1-based id.
const NH_ID_BASE = 2 << 24;
const NHG_ID_BASE = 3 << 24;

/** Python str.center (CPython: extra pad goes left when the width is odd). */
function center(s: string, w: number): string {
  const marg = w - s.length;
  if (marg <= 0) return s;
  const left = Math.floor(marg / 2) + (marg & w & 1);
  return " ".repeat(left) + s + " ".repeat(marg - left);
}

/** Local ES × L2 VNI pairs: an ES joins every VNI whose VLAN its PortChannel carries. */
function esEvis(dev: Device, cfg: VxlanConfig): { vni: number; esi: string; ready: boolean }[] {
  const out: { vni: number; esi: string; ready: boolean }[] = [];
  for (const m of [...l2Maps(cfg)].sort((a, b) => a.vni - b.vni)) {
    const ports = vlanMembers(dev, m.vlan).map((p) => p.port);
    for (const es of localEss(dev)) if (ports.includes(es.ifname)) out.push({ vni: m.vni, esi: es.esi, ready: es.up });
  }
  return out;
}

registerModal({
  id: "klish-evpn-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    const a = args.map((x) => x.toLowerCase());
    const dev = ctx.device;
    const cfg = evpnCfg(dev);

    if (a[0] === "evpn" && a.length === 1) {
      const mh = cpGet(dev, "evpn_mh") ?? {};
      const val = (k: string, d: number) => (mh[k] !== undefined ? Number(mh[k]) : d);
      return L([
        `L2 VNIs: ${cfg ? l2Maps(cfg).length : 0}`,
        `L3 VNIs: ${cfg ? l3Vnis(dev, cfg).length : 0}`,
        "Advertise gateway mac-ip: No",
        "Advertise svi mac-ip: No",
        "Advertise svi mac: No",
        "Duplicate address detection: Enable",
        "  Detection max-moves 5, time 180",
        "EVPN MH:",
        `  mac-holdtime: ${val("mac-holdtime", 1080)}s, neigh-holdtime: ${val("neigh-holdtime", 1080)}s`,
        // sonic_cli_show_evpn.py DEFAULT_DELAY_RESTORE = 300 is the platform startup-delay default.
        `  startup-delay: ${val("startup-delay", 300)}s, start-delay-timer: --:--:--`,
        "  uplink-cfg-cnt: 0, uplink-active-cnt: 0",
      ]);
    }

    if (a[0] === "evpn" && a[1] === "es-evi") {
      const detail = a[2] === "detail";
      const vni = a[2] === "vni" ? Number(a[3]) : undefined;
      if (a[2] === "vni" && !Number.isInteger(vni)) return null;
      let rows = cfg ? esEvis(dev, cfg) : [];
      const out: string[] = [];
      if (vni !== undefined) {
        if (!cfg || !l2Maps(cfg).some((m) => m.vni === vni)) return L([`VNI ${vni} not found`]);
        rows = rows.filter((r) => r.vni === vni);
      }
      if (detail) return L(rows.flatMap((r) => [`VNI ${r.vni} ESI: ${r.esi}`, " Type: L", ` Ready for BGP: ${r.ready ? "yes" : "no"}`, ""]));
      out.push("Type: L local, R remote", `${"VNI".padEnd(8)} ${"ESI".padEnd(30)} ${"Type".padEnd(4)}`);
      for (const r of rows) out.push(`${String(r.vni).padEnd(8)} ${r.esi.padEnd(30)} ${"L".padEnd(4)}`);
      return L(out);
    }

    if (a[0] === "evpn" && a[1] === "l2-nh" && a.length === 2) {
      // One L2 next-hop per remote VTEP taking part in an ES; #ES = ESes referencing it.
      const refs = new Map<string, number>();
      for (const peers of Object.values(esPeerTable(dev))) for (const ip of Object.keys(peers)) refs.set(ip, (refs.get(ip) ?? 0) + 1);
      const vteps = [...refs.keys()].sort((x, y) => ipNum(x) - ipNum(y));
      return L([`${"VTEP".padEnd(16)} ${"NH id".padEnd(10)} #ES`, ...vteps.map((ip, i) => `${ip.padEnd(16)} ${String(NH_ID_BASE + i + 1).padEnd(10)} ${refs.get(ip)}`)]);
    }

    if (a[0] === "vxlan" && (a.length === 1 || (a[1] === "remote" && a.length === 2))) return { output: [] };

    if (a[0] === "vxlan" && a[1] === "remote" && a[2] === "nexthop-group") {
      // L2_NEXTHOP_GROUP_TABLE: one group per multihomed ES, members = the remote VTEPs of that ES.
      const local = new Map(localEss(dev).map((e) => [e.esi, e.ifname]));
      const groups = Object.entries(esPeerTable(dev))
        .filter(([, p]) => Object.keys(p).length)
        .sort(([x], [y]) => x.localeCompare(y));
      const out = ["", `${center("NHG", 9)} ${center("Remote VTEPs", 15)} ${center("Local Members", 9)} `, `${center("====", 9)} ${center("===========", 15)} ${center("=============", 9)} `, ""];
      groups.forEach(([esi, peers], gi) => {
        Object.keys(peers)
          .sort((x, y) => ipNum(x) - ipNum(y))
          .forEach((ip, i) => out.push(i === 0 ? `${center(String(NHG_ID_BASE + gi + 1), 9)} ${center(ip, 15)} ${center(local.get(esi) ?? "", 9)} ` : `${center("", 9)} ${center(ip, 15)}  `));
        out.push("");
      });
      return L(out);
    }
    return null;
  },
});
