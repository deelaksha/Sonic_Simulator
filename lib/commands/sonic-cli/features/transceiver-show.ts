/**
 * KLISH `show interface transceiver …` (interface.xml:431-485, intf_xcvr.xml:13-56).
 *
 * The lab has no optics subsystem: a cabled front-panel port carries the simulated
 * passive copper DAC that matches its speed, an uncabled port has no module
 * ("Not present"). Passive DACs have no DOM, diagnostics, CMIS state machine or
 * laser, so those tables report N/A — what the box prints for such a module.
 *
 *   show interface transceiver [<Ethernet>] [summary]     inventory table
 *   show interface transceiver [<Ethernet>] dom           DOM (N/A for DAC)
 *   show interface transceiver [<Ethernet>] diagnostics capability|status
 *   show interface transceiver wattage
 *   show interface transceiver cmis status [<range>]
 *   show interface transceiver laser status [<range>]
 */
import { OutputLine, line, err } from "../../types";
import { registerModal } from "../registry";
import { Device } from "../../../models/device";
import { NetInterface } from "../../../models/interface";
import { parseIf, resolveIf, ifacesOfType } from "./l2-ifargs";

interface Optic {
  present: boolean;
  name: string;
  power: string;
}

/** The simulated module in a port: a passive DAC matching the port speed when cabled. */
export function optic(i: NetInterface): Optic {
  if (!i.connectedTo) return { present: false, name: "Not present", power: "-" };
  const g = i.speed / 1000;
  const name =
    g >= 400 ? "QSFP-DD 400GBASE-CR8-1.0M" : g >= 100 ? "QSFP28 100GBASE-CR4-1.0M" : g >= 40 ? "QSFP+ 40GBASE-CR4-1.0M" : g >= 25 ? "SFP28 25GBASE-CR-1.0M" : g >= 10 ? "SFP+ 10GBASE-CR-1.0M" : "SFP 1000BASE-T";
  return { present: true, name, power: g >= 100 ? "0.5" : "0.1" };
}

const dash = (n: number) => "-".repeat(n);

function inventory(ifs: NetInterface[]): string[] {
  const cols: [string, number][] = [["Interface", 13], ["Name", 40], ["Vendor", 18], ["Part No.", 18], ["Serial No.", 18], ["QSA Adapter", 18], ["Qualified", 0]];
  const row = (v: string[]) => v.map((x, k) => x.padEnd(cols[k][1])).join("").trimEnd();
  const out = [dash(125), row(cols.map((c) => c[0])), dash(125)];
  for (const i of ifs) {
    const o = optic(i);
    out.push(o.present ? row([i.name, o.name, "SIMULATED", "SIM-DAC-1M", `SIM${i.name.replace("Ethernet", "").padStart(6, "0")}`, "N/A", "True"]) : row([i.name, o.name]));
  }
  return out;
}

function dom(ifs: NetInterface[]): string[] {
  const out: string[] = [];
  for (const i of ifs) {
    const o = optic(i);
    out.push(`${i.name}: ${o.present ? `${o.name} - DOM not supported (passive copper)` : "Transceiver not present"}`);
  }
  return out;
}

function diag(ifs: NetInterface[], what: "capability" | "status"): string[] {
  const out = ["Interface".padEnd(13) + (what === "capability" ? "Diagnostics Capability" : "Diagnostics Status"), `${dash(11)}  ${dash(22)}`];
  for (const i of ifs) out.push(i.name.padEnd(13) + (optic(i).present ? "Not supported" : "Not present"));
  return out;
}

function wattage(ifs: NetInterface[]): string[] {
  const out = ["Interface".padEnd(13) + "Module Max Power(W)".padEnd(22) + "Port Max Power(W)", `${dash(11)}  ${dash(20)}  ${dash(17)}`];
  for (const i of ifs) out.push(i.name.padEnd(13) + optic(i).power.padEnd(22) + (i.speed >= 100000 ? "3.5" : "1.5"));
  return out;
}

function cmis(ifs: NetInterface[], what: "cmis" | "laser"): string[] {
  const out = ["Interface".padEnd(13) + (what === "cmis" ? "CMIS State" : "Laser Status"), `${dash(11)}  ${dash(12)}`];
  for (const i of ifs) out.push(i.name.padEnd(13) + (optic(i).present ? "N/A" : "Not present"));
  return out;
}

const L = (ss: string[]): { output: OutputLine[] } => ({ output: ss.map((s) => line(s)) });

function run(d: Device, t: string[]): { output: OutputLine[] } | null {
  const k = t[0]?.toLowerCase();
  if (k === "wattage") return t.length === 1 ? L(wattage(ifacesOfType(d, "Ethernet"))) : null;
  if (k === "cmis" || k === "laser") {
    // the grammar takes the port before or after `status`: `laser Ethernet 0 status` = `laser status Ethernet 0`
    if (t[1] && /^eth/i.test(t[1])) {
      const a = parseIf(t.slice(1));
      if (!a || a.rest[0]?.toLowerCase() !== "status" || a.rest.length !== 1) return null;
      t = [k, "status", ...t.slice(1, t.length - 1)];
    }
    if (t[1]?.toLowerCase() !== "status") return null;
    let ifs = ifacesOfType(d, "Ethernet");
    if (t.length > 2) {
      const a = parseIf(t.slice(2));
      if (!a || a.type !== "Ethernet" || a.rest.length) return null;
      ifs = resolveIf(d, a);
    }
    return L(cmis(ifs, k));
  }
  // `dom Ethernet 0` / `summary Ethernet 0` = `Ethernet 0 dom|summary`
  if ((k === "dom" || k === "summary") && t[1] && /^eth/i.test(t[1])) t = [...t.slice(1), t[0]];
  let ifs = ifacesOfType(d, "Ethernet");
  let rest = t;
  if (t.length && /^eth/i.test(t[0])) {
    const a = parseIf(t);
    if (!a || a.type !== "Ethernet" || !a.ids || a.ids.length !== 1) return null;
    ifs = resolveIf(d, a);
    if (!ifs.length) return { output: [err(`% Error: Interface Ethernet${a.ids[0]} not found`)] };
    rest = a.rest;
  }
  const r0 = rest[0]?.toLowerCase();
  if (rest.length === 0 || (r0 === "summary" && rest.length === 1)) return L(inventory(ifs));
  if (r0 === "dom" && rest.length === 1) return L(dom(ifs));
  if (r0 === "diagnostics" && rest.length >= 2) {
    const w = rest[1].toLowerCase();
    if (w !== "capability" && w !== "status") return null;
    // `diagnostics capability|status [summary|Ethernet N]` (interface.xml DOCGEN examples)
    let sel = ifs;
    if (rest.length > 2 && rest[2].toLowerCase() !== "summary") {
      const a = parseIf(rest.slice(2));
      if (!a || a.type !== "Ethernet" || a.rest.length) return null;
      sel = resolveIf(d, a);
    }
    return L(diag(sel, w));
  }
  return null;
}

registerModal({
  id: "transceiver-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "interface" || args[1]?.toLowerCase() !== "transceiver") return null;
    return run(ctx.device, args.slice(2));
  },
});
