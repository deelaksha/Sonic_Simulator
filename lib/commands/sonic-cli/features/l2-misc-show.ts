/**
 * Remaining L2 KLISH `show` forms with no handler:
 *
 *   show link | show link state            link_track.xml:478-479 — COMMANDs with no ACTION:
 *                                          klish runs nothing (clish shell_execute.c:315
 *                                          returns 0 when no builtin), so the box prints nothing
 *   show mclag mac                         mclag.xml:403 — no ACTION, prints nothing
 *   show mclag mac remote [Vlan N|<if>]    mclag.xml:404-430 — MACs the ICCP peer synced
 *                                          (iccpd MCLAG_REMOTE_FDB = mclag-daemon remoteMacs)
 *   show mclag mac remote count            mclag.xml:431
 *   show mclag separate-ip-interfaces      mclag.xml:338-359 — Vlan SVIs with `mclag-separate-ip`
 *   show mclag peer-gateway-interfaces     mclag.xml:361-382 — Vlan SVIs with `mclag-peer-gateway`
 *   show port-security                     pms.xml:15-34 (EXAMPLE layout)
 *   show port-security interface <if>      pms.xml:36-56 (EXAMPLE layout)
 *   show mac dampening                     mac.xml:153 — threshold/interval (defaults 5/5)
 *   show mac dampening-disabled-ports      mac.xml:157 — no port is dampened in the lab
 *
 * Interface-level PMS / MCLAG-SVI settings are recognized config commands with no
 * dedicated handler, so they live in the config-plane running-config store
 * (cpRunningLines, ctx = interface name); these renders read them back.
 */
import { OutputLine, line, err } from "../../types";
import { registerModal } from "../registry";
import { cpRunningLines } from "../config-plane";
import { Device } from "../../../models/device";
import { mclagRuntime } from "../../../protocols/mclag-daemon";
import { natCompare } from "../../sonic/counters";
import { parseIf, ifName } from "./l2-ifargs";

const L = (ss: string[]): { output: OutputLine[] } => ({ output: ss.map((s) => line(s)) });

/** Interfaces (ctx) carrying a stored config line that starts with `prefix`. */
function ifsWith(d: Device, prefix: string): string[] {
  const set = new Set(cpRunningLines(d).filter((l) => l.line === prefix || l.line.startsWith(prefix + " ")).map((l) => l.ctx));
  return [...set].sort(natCompare);
}

function ifListTable(names: string[]): string[] {
  const eq = "=".repeat(19);
  return ["Interface Name", eq, ...names, eq, `Total count : ${names.length}`, eq];
}

function remoteMacs(d: Device, args: string[]): string[] {
  const rt = mclagRuntime(d);
  let rows = Object.entries(rt?.remoteMacs ?? {}).map(([key, port]) => {
    const [mac, vid] = key.split("|");
    return { vlan: `Vlan${vid}`, mac: mac.toLowerCase(), port };
  });
  if (args.length) {
    const a = parseIf(args);
    const want = ifName(a);
    if (!a || !want || a.rest.length) return [];
    rows = rows.filter((r) => (a.type === "Vlan" ? r.vlan === want : r.port === want));
  }
  rows.sort((x, y) => natCompare(x.vlan, y.vlan) || x.mac.localeCompare(y.mac));
  const eq = "=".repeat(72);
  const out = [eq, "Vlan".padEnd(15) + "Mac".padEnd(19) + "Port".padEnd(13) + "Type", eq];
  for (const r of rows) out.push(r.vlan.padEnd(10) + r.mac.padEnd(21) + r.port.padEnd(17) + "dynamic");
  return out;
}

function pmsCfg(d: Device, ifname: string) {
  const ls = cpRunningLines(d).filter((l) => l.ctx === ifname && l.line.startsWith("port-security"));
  const val = (k: string) => ls.find((l) => l.line.startsWith(`port-security ${k} `))?.line.split(/\s+/)[2];
  return {
    enabled: ls.some((l) => l.line === "port-security enable"),
    max: Number(val("maximum") ?? 1), // "Resets maximum no of secure MAC to 1" (pms.xml:77)
    violation: (val("violation") ?? "protect") === "shutdown" ? "Shutdown" : "Protect", // default protect (pms.xml:109)
    current: d.macTable.filter((e) => d.interfaces.find((i) => i.id === e.interfaceId)?.name === ifname).length,
  };
}

function showPms(d: Device): string[] {
  const out = ["Secure Port       MaxSecureAddr    CurrentAddr  SecurityViolation  SecurityAction  ", " "];
  for (const n of ifsWith(d, "port-security enable")) {
    const c = pmsCfg(d, n);
    out.push(n.padEnd(22) + String(c.max).padEnd(17) + String(Math.min(c.current, c.max)).padEnd(16) + "0".padEnd(16) + c.violation);
  }
  return out;
}

/**
 * `show mac address-table [Vlan N | address M | interface <if> | static|dynamic|sticky-mac [...]]`
 * (mac.xml:17-152): the KLISH filters mapped onto the FDB table renderer (`show mac -v/-p/-a/-t`).
 */
function macFilter(args: string[]): string | null {
  let rest = args;
  const opts: string[] = [];
  const kind = rest[0]?.toLowerCase();
  if (kind === "static" || kind === "dynamic") {
    opts.push("-t", kind);
    rest = rest.slice(1);
  } else if (kind === "sticky-mac") {
    return null; // sticky MACs need port-security learning, which the FDB does not model
  }
  if (!rest.length) return opts.join(" ");
  const k = rest[0].toLowerCase();
  if (k === "address" && rest.length === 2 && /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(rest[1])) return [...opts, "-a", rest[1]].join(" ");
  const ia = parseIf(k === "interface" ? rest.slice(1) : rest);
  const n = ifName(ia);
  if (!ia || !n || ia.rest.length) return null;
  if (k !== "interface" && ia.type === "Vlan") return [...opts, "-v", String(ia.ids![0])].join(" ");
  if (k === "interface" && (ia.type === "Ethernet" || ia.type === "PortChannel")) return [...opts, "-p", n].join(" ");
  return null;
}

registerModal({
  id: "l2-misc-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx, delegate }) {
    const a = args.map((x) => x.toLowerCase());
    const d = ctx.device;
    if (a[0] === "mac" && a[1] === "address-table" && args.length > 2 && !["aging-time", "count"].includes(a[2])) {
      const f = macFilter(args.slice(2));
      // No sticky MACs are ever learned here: render the table with no entries.
      if (f === null) return a[2] === "sticky-mac" ? { output: delegate("show mac -t static -a 00:00:00:00:00:00") } : null;
      return { output: delegate(`show mac ${f}`) };
    }
    if (a[0] === "link" && (a.length === 1 || (a[1] === "state" && a.length === 2))) return { output: [] };

    if (a[0] === "mclag") {
      if (a[1] === "separate-ip-interfaces" && a.length === 2) return L(ifListTable(ifsWith(d, "mclag-separate-ip")));
      if (a[1] === "peer-gateway-interfaces" && a.length === 2) return L(ifListTable(ifsWith(d, "mclag-peer-gateway")));
      if (a[1] === "mac") {
        if (a.length === 2) return { output: [] };
        if (a[2] !== "remote") return null;
        if (a[3] === "count" && a.length === 4) {
          return L([`Total count : ${Object.keys(mclagRuntime(d)?.remoteMacs ?? {}).length}`]);
        }
        return L(remoteMacs(d, args.slice(3)));
      }
      return null;
    }

    if (a[0] === "port-security") {
      if (a.length === 1) return L(showPms(d));
      if (a[1] !== "interface") return null;
      const ia = parseIf(args.slice(2));
      const n = ifName(ia);
      if (!ia || !n || ia.rest.length || (ia.type !== "Ethernet" && ia.type !== "PortChannel")) return null;
      if (!d.interfaces.some((i) => i.name === n)) return { output: [err(`% Error: Interface ${n} not found`)] };
      const c = pmsCfg(d, n);
      return L([
        `Port Security: ${c.enabled ? "Enabled" : "Disabled"}`,
        `Violation mode: ${c.violation}`,
        `Maximum MAC Addresses: ${c.max}`,
        `Total MAC Addresses: ${c.enabled ? Math.min(c.current, c.max) : 0}`,
        "Security Violation count: 0",
      ]);
    }

    if (a[0] === "mac" && a.length === 2 && a[1] === "dampening") {
      const cfg = (k: string, dflt: string) =>
        cpRunningLines(d).find((l) => l.ctx === "config" && l.line.startsWith(`mac address-table dampening-${k} `))?.line.split(/\s+/)[3] ?? dflt;
      return L([`MAC Move Dampening Threshold : ${cfg("threshold", "5")}`, `MAC Move Dampening Interval  : ${cfg("interval", "5")}`]);
    }
    if (a[0] === "mac" && a.length === 2 && a[1] === "dampening-disabled-ports") return L(["MAC Move Dampening Disabled Ports : None"]);
    return null;
  },
});
