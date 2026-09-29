import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features";
import { Simulation, resetIds, CaptureRecord, SimEvent } from "../lib/engine";
import { execute, CommandContext } from "../lib/commands";
import { useLabStore } from "../lib/store/lab-store";
import { Device } from "../lib/models/device";
import { NetworkState } from "../lib/models/topology";
import { isValidHostname } from "../lib/models/ip";

const ctxFor = (net: NetworkState, d: Device): CommandContext => ({
  device: d, network: net, captures: [] as CaptureRecord[],
  runSim<T>(fn: (s: Simulation) => T) { const s = new Simulation(net); return { value: fn(s), events: s.events as SimEvent[] }; },
});
const out = (r: { output: { text: string }[] }) => r.output.map((o) => o.text).join("\n");

function upstreamPc(): { net: NetworkState; pc: Device } {
  useLabStore.getState().newLab();
  useLabStore.getState().loadFeatureLab("ntp-upstream");
  resetIds();
  const net = useLabStore.getState().network;
  const pc = Object.values(net.devices).find((d) => d.type === "pc")!;
  (pc.config.features ??= {}).dns = { nameservers: ["8.8.8.8"] }; // resolve hostnames via internet
  return { net, pc };
}

describe("NTP server by hostname + real associations", () => {
  it("isValidHostname accepts DNS names, rejects junk and IPs", () => {
    expect(isValidHostname("time.google.com")).toBe(true);
    expect(isValidHostname("pool.ntp.org")).toBe(true);
    expect(isValidHostname("1.2.3.4")).toBe(false); // an IP is not a hostname
    expect(isValidHostname("bad_host!")).toBe(false);
  });

  it("config ntp add accepts a hostname", () => {
    const { net, pc } = upstreamPc();
    expect(out(execute("config ntp add time.google.com", ctxFor(net, pc)))).toContain("added");
    expect(out(execute("show ntp", ctxFor(net, pc)))).toContain("time.google.com");
  });

  it("config ntp add rejects an invalid address/hostname", () => {
    const { net, pc } = upstreamPc();
    expect(out(execute("config ntp add bad_host!", ctxFor(net, pc)))).toMatch(/not a valid/);
  });

  it("show ntp associations shows real sync data for a reachable server", () => {
    const { net, pc } = upstreamPc();
    execute("config ntp add time.google.com", ctxFor(net, pc));
    execute("config ntp add 216.239.35.0", ctxFor(net, pc));
    const table = out(execute("show ntp associations", ctxFor(net, pc)));
    expect(table).toMatch(/reach/); // header
    expect(table).toMatch(/\*\s+time\.google\.com/); // synced (starred)
    expect(table).toMatch(/377/); // reachable
  });

  it("show ntp associations shows .INIT./reach 0 for an unreachable server", () => {
    useLabStore.getState().newLab();
    const id = useLabStore.getState().addDevice("switch", { x: 0, y: 0 });
    const net = useLabStore.getState().network;
    const sw = net.devices[id];
    (sw.config.features ??= {}).ntp = { servers: ["203.0.113.99"], sourceInterface: undefined, vrf: undefined };
    const table = out(execute("show ntp associations", ctxFor(net, sw)));
    expect(table).toMatch(/\.INIT\./);
    expect(table).toMatch(/203\.0\.113\.99/);
  });

  it("ntpdate resolves a hostname via DNS then syncs", () => {
    const { net, pc } = upstreamPc();
    const r = out(execute("ntpdate time.google.com", ctxFor(net, pc)));
    expect(r).toContain("resolved time.google.com");
    expect(r).toMatch(/stratum/);
  });
});
