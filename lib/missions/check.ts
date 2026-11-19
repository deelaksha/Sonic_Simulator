/**
 * Read-only view of the live network for mission objectives. Every probe
 * (ping, show command) runs on a deep copy, so checking never changes the
 * learner's network, ARP tables, counters or terminals.
 */
import { NetworkState } from "../models/topology";
import { Device } from "../models/device";
import { Route } from "../models/route";
import { Simulation } from "../engine";
import { execute, CommandContext } from "../commands";
import { enterSonicCli, runSonicCli } from "../commands/sonic-cli";

export interface CheckCtx {
  net: NetworkState;
  /** Device by name (throws if missing: the objective counts as not met). */
  dev(name: string): Device;
  /** One-shot IPv4 ping on a copy of the network. */
  ping(from: string, ip: string): boolean;
  ping6(from: string, ip: string): boolean;
  /** Output of a Linux/Click command run on a copy (e.g. `show ip route`). */
  shell(device: string, cmd: string): string;
  /** Output of a KLISH exec-mode command run on a copy. */
  klish(device: string, cmd: string): string;
  /** Best route on a device for exactly prefix/len (IPv4), optional VRF. */
  route(device: string, prefix: string, vrf?: string): Route | undefined;
  /** Did the learner type a command matching `re` on this device's terminal? */
  typed(device: string, re: RegExp): boolean;
}

export function makeCheckCtx(net: NetworkState, typedLines: Record<string, string[]>, wallNow: number): CheckCtx {
  const byName = (n: NetworkState, name: string) => {
    const d = Object.values(n.devices).find((x) => x.name === name);
    if (!d) throw new Error(`no device ${name}`);
    return d;
  };
  const withCopy = <T>(fn: (copy: NetworkState) => T): T => fn(structuredClone(net));
  const run = (device: string, cmd: string, klish: boolean) =>
    withCopy((copy) => {
      const d = byName(copy, device);
      const ctx: CommandContext = {
        device: d,
        network: copy,
        captures: [],
        runSim: (fn) => {
          const sim = new Simulation(copy, { wallBase: wallNow });
          return { value: fn(sim), events: sim.events };
        },
      };
      const out = klish ? runSonicCli(cmd, enterSonicCli().stack, ctx).output : execute(cmd, ctx).output;
      return out.map((l) => l.text).join("\n");
    });
  return {
    net,
    dev: (name) => byName(net, name),
    ping: (from, ip) => withCopy((copy) => new Simulation(copy, { wallBase: wallNow }).runPing(byName(copy, from).id, ip, { count: 1 }).received > 0),
    ping6: (from, ip) => withCopy((copy) => new Simulation(copy, { wallBase: wallNow }).runPing6(byName(copy, from).id, ip, { count: 1 }).received > 0),
    shell: (device, cmd) => run(device, cmd, false),
    klish: (device, cmd) => run(device, cmd, true),
    route: (device, prefix, vrf = "default") => {
      const [dst, len] = prefix.split("/");
      return byName(net, device).routingTable.find((r) => r.destination === dst && r.prefix === Number(len) && (r.vrf ?? "default") === vrf);
    },
    typed: (device, re) => (typedLines[byName(net, device).id] ?? []).some((l) => re.test(l)),
  };
}

/** Evaluate one objective; any exception (missing device, bad output) counts as not met. */
export function holds(check: (c: CheckCtx) => boolean, c: CheckCtx): boolean {
  try {
    return check(c) === true;
  } catch {
    return false;
  }
}
