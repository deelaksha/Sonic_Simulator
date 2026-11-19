/**
 * mclagdctl — iccpd's control tool (sonic-buildimage src/iccpd/src/mclagdctl/
 * mclagdctl.c), reading the live iccpd model (lib/protocols/mclag-daemon.ts):
 *
 *   mclagdctl dump state -i <id>   mclagdctl_parse_dump_state (:285-333)
 *   mclagdctl dump arp -i <id>     mclagdctl_parse_dump_arp (:372-410): L = learned here, R = from the peer
 *   mclagdctl dump mac -i <id>     mclagdctl_parse_dump_mac (:466-517)
 */
import { CommandHandler, CommandResult, OutputLine, err, line } from "./types";
import { Device, isSwitch } from "../models/device";
import { isActiveRole, mclagConfig, mclagRuntime } from "../protocols/mclag-daemon";
import { featureEnabled } from "../protocols/cpu-features";

const pad = (s: string | number, n: number) => String(s).padEnd(n);
const lower = (m: string) => m.toLowerCase();

function dumpState(d: Device): string[] {
  const c = mclagConfig(d)!;
  const rt = mclagRuntime(d);
  const pl = d.interfaces.find((i) => i.name === c.peerLink);
  return [
    `The MCLAG's keepalive is: ${rt?.session ? "OK" : "ERROR"}`,
    `MCLAG info sync is: ${rt?.session ? "completed" : "incomplete"}`,
    `Domain id: ${c.id}`,
    `Local Ip: ${c.sourceIp}`,
    `Peer Ip: ${c.peerIp}`,
    `Peer Link Interface: ${c.peerLink ?? ""}`,
    `Keepalive time: ${c.keepalive}`,
    `sesssion Timeout : ${c.sessionTimeout}`,
    `Peer Link Mac: ${lower(pl?.mac ?? "00:00:00:00:00:00")} `,
    `Role: ${isActiveRole(c) ? "Active" : "Standby"}`,
    `MCLAG Interface: ${c.interfaces.join(",")}`,
    "Loglevel: NOTICE",
  ];
}

function dumpArp(d: Device): string[] {
  const rt = mclagRuntime(d);
  const out = [`${pad("No.", 6)}${pad("IP", 20)}${pad("MAC", 20)}${pad("DEV", 20)}Flag`];
  const rows: { ip: string; mac: string; dev: string; flag: string }[] = [];
  for (const [ip, v] of Object.entries(rt?.sentArps ?? {})) {
    const [dev, mac] = v.split("|");
    rows.push({ ip, mac, dev, flag: "L" });
  }
  for (const [ip, v] of Object.entries(rt?.remoteArps ?? {})) if (!(ip in (rt?.sentArps ?? {}))) rows.push({ ip, mac: v.mac, dev: v.ifname, flag: "R" });
  rows.forEach((r, i) => out.push(`${pad(i + 1, 6)}${pad(r.ip, 20)}${lower(r.mac)}   ${pad(r.dev, 20)}${r.flag}`));
  return out;
}

function dumpMac(d: Device): string[] {
  const rt = mclagRuntime(d);
  const out = [
    `${pad("TYPE: S-STATIC, D-DYNAMIC; AGE: L-Local age, P-Peer age", 60)}`,
    `${pad("No.", 6)}${pad("TYPE", 5)}${pad("MAC", 20)}${pad("VID", 5)}${pad("DEV", 20)}${pad("ORIGIN-DEV", 20)}${pad("AGE", 5)}`,
  ];
  const keys = new Set([...Object.keys(rt?.sentMacs ?? {}), ...Object.keys(rt?.remoteMacs ?? {})]);
  let n = 0;
  for (const key of keys) {
    const [mac, vid] = key.split("|");
    const local = rt?.sentMacs[key];
    const remote = rt?.remoteMacs[key];
    const fdb = d.macTable.find((e) => e.mac.toUpperCase() === mac && e.vlan === Number(vid));
    const dev = (fdb && d.interfaces.find((i) => i.id === fdb.interfaceId)?.name) ?? local ?? remote ?? "";
    // MAC_AGE_LOCAL_CTL: not (or no longer) learned here; MAC_AGE_PEER_CTL: not learned on the peer.
    const age = (local ? "" : "L") + (remote ? "" : "P");
    out.push(`${pad(++n, 6)}${pad("D", 5)}${pad(lower(mac), 20)}${pad(vid, 5)}${pad(dev, 20)}${pad(remote ?? local ?? "", 20)}${pad(age || " ", 5)}`);
  }
  return out;
}

export const mclagdctlCommand: CommandHandler = {
  name: "mclagdctl",
  summary: "iccpd control: dump MCLAG state / synced ARP / MAC tables",
  usage: "mclagdctl dump state|arp|mac -i <mclag-id>",
  help: ["mclagdctl dump state -i <id>", "mclagdctl dump arp -i <id>", "mclagdctl dump mac -i <id>"],
  run(args, ctx): CommandResult {
    const d = ctx.device;
    if (!isSwitch(d.type)) return { output: [err("mclagdctl: command not found")] };
    const i = args.indexOf("-i");
    const id = i >= 0 ? args[i + 1] : undefined;
    const what = args[0] === "dump" ? args[1] : undefined;
    if (!what || !["state", "arp", "mac"].includes(what)) return { output: [line("Usage: mclagdctl dump state|arp|mac -i <mclag-id>")] };
    if (!id) return { output: [err("Need to specify mclag-id through the parameter i !")] };
    // No iccpd (container stopped) or unknown domain: the control socket answers nothing useful.
    if (!featureEnabled(d, "iccpd")) return { output: [err("Mclagdctl:Connect to server error:Connection refused")] };
    const c = mclagConfig(d);
    if (!c || c.id !== id) return { output: [] };
    const lines = what === "state" ? dumpState(d) : what === "arp" ? dumpArp(d) : dumpMac(d);
    const out: OutputLine[] = lines.map((t) => line(t));
    return { output: out };
  },
};
