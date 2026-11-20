"use client";
/** Inspectors under the device: the selected port, and what the box's CPU / OS is doing. */
import { useCallback } from "react";
import { useLabStore } from "@/lib/store/lab-store";
import { Device } from "@/lib/models/device";
import { ChassisKind, CpuView, HostView, PortView, RouteRow, fmtBps, recentFrames } from "@/lib/switch3d/model";
import { Fact, Heading, click } from "./parts";
import { CableSwatches } from "./CableColorPicker";

const LED_MEANING = { off: "off: no link", green: "green: gigabit+ link, blinks with traffic", amber: "amber: 10/100M link, blinks with traffic" };

export function PortInspector({ device, kind, port: p, sound }: { device: Device; kind: ChassisKind; port: PortView; sound: boolean }) {
  const captures = useLabStore((s) => s.captures);
  const runCliScript = useLabStore((s) => s.runCliScript);
  const execCommand = useLabStore((s) => s.execCommand);
  const appendTerminal = useLabStore((s) => s.appendTerminal);
  const disconnect = useLabStore((s) => s.disconnect);
  const frames = recentFrames(captures, device.id, p.id);
  const setAdmin = useCallback(
    (down: boolean) => {
      if (sound) click(!down);
      // Applied with the device's real CLI so the learner sees the command in its terminal.
      if (kind === "switch") {
        runCliScript(device.id, ["configure terminal", `interface Ethernet ${p.name.replace(/^Ethernet/, "")}`, down ? "shutdown" : "no shutdown", "end"]);
        return;
      }
      const cmd = `ip link set ${p.name} ${down ? "down" : "up"}`;
      appendTerminal(device.id, [{ text: `# ${cmd}   (applied from the hardware view)`, kind: "output", lineKind: "muted" }]);
      const r = execCommand(device.id, cmd);
      appendTerminal(device.id, r.output.map((o) => ({ text: o.text, kind: "output" as const, lineKind: o.kind })));
    },
    [device.id, kind, p.name, runCliScript, execCommand, appendTerminal, sound],
  );
  const status: [string, string] =
    p.admin === "down"
      ? ["ADMIN DOWN", "bg-amber-500/15 text-amber-300 border-amber-500/30"]
      : p.oper === "up"
        ? [`LINK UP · ${p.speedLabel}`, "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"]
        : ["NO LINK", "bg-slate-800 text-slate-400 border-slate-700"];
  const drops = Object.entries(p.drops);
  return (
    <div className="rounded-xl border border-edge bg-panel-2 p-3">
      <div className="flex flex-wrap items-center gap-2 border-b border-edge pb-2">
        <div className="flex h-9 min-w-9 items-center justify-center rounded-lg border border-sky-500/30 bg-sky-500/15 px-1.5 font-mono text-sm font-bold text-sky-400">
          {kind === "switch" ? String(p.label).padStart(2, "0") : p.name}
        </div>
        <div className="mr-auto">
          <div className="text-[13px] font-semibold text-[#e6edf3]">
            {p.name} <span className="font-normal text-[#6b7789]">· {p.kind === "sfp" ? `SFP cage (${p.speedLabel})` : `RJ45 (${p.speedLabel})`}</span>
          </div>
          <div className="text-[11px] text-[#8b98a5]">{p.peer ? `Cable to ${p.peer.deviceName} ${p.peer.ifName} (${p.peer.deviceType})` : "Nothing plugged in"}</div>
        </div>
        <span className={`rounded-full border px-2 py-0.5 font-mono text-[10.5px] font-semibold ${status[1]}`}>{status[0]}</span>
        <button onClick={() => setAdmin(p.admin === "up")} className="rounded border border-edge px-2 py-1 text-[11px] text-[#c9d3de] hover:border-accent-2 hover:text-accent-2" title="Applied with the device's CLI (see the terminal)">
          {kind === "switch" ? (p.admin === "up" ? "shutdown" : "no shutdown") : p.admin === "up" ? "link down" : "link up"}
        </button>
        {p.peer?.connectionId && (
          <button
            onClick={() => {
              if (sound) click(false);
              disconnect(p.peer!.connectionId!);
            }}
            className="rounded border border-edge px-2 py-1 text-[11px] text-[#c9d3de] hover:border-danger hover:text-red-300"
          >
            Unplug
          </button>
        )}
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {kind === "switch" && <Fact k="VLAN / mode" v={p.vlan} />}
        <Fact k="IP" v={p.ipv4.join(", ") || "—"} />
        {kind === "switch" && <Fact k="PortChannel" v={p.lag ? `${p.lag.name} (${p.lag.static ? "static" : p.lag.selected ? "selected" : "not selected"})` : "—"} />}
        <Fact k="MAC" v={p.mac} />
        <Fact k="RX rate" v={fmtBps(p.rate?.rxBps)} />
        <Fact k="TX rate" v={fmtBps(p.rate?.txBps)} />
        {kind === "switch" && <Fact k="LLDP neighbor" v={p.lldp ? `${p.lldp.sysName ?? p.lldp.chassisId} · ${p.lldp.portId}${p.lldp.mgmtIp ? ` · ${p.lldp.mgmtIp}` : ""}` : "—"} />}
        <Fact k="LED meaning" v={LED_MEANING[p.led]} />
      </div>
      {p.peer?.connectionId && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-[#5f6b7a]">Cable colour</span>
          <CableSwatches connectionId={p.peer.connectionId} />
        </div>
      )}

      <div className="mt-1 grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>
          <Heading>Counters{kind === "switch" ? " (show interfaces counters)" : " (ip -s link)"}</Heading>
          <table className="w-full font-mono text-[11px] text-[#c9d3de]">
            <tbody>
              {(
                [
                  ["", "RX", "TX"],
                  ["frames", p.stats.rxFrames, p.stats.txFrames],
                  ["bytes", p.stats.rxBytes, p.stats.txBytes],
                  ["dropped", p.stats.rxDropped, p.stats.txDropped],
                  ["bcast", p.stats.rxBroadcast ?? 0, p.stats.txBroadcast ?? 0],
                  ["mcast", p.stats.rxMulticast ?? 0, p.stats.txMulticast ?? 0],
                ] as const
              ).map((r, i) => (
                <tr key={i} className={i === 0 ? "text-[#5f6b7a]" : ""}>
                  <td className="pr-3">{r[0]}</td>
                  <td className="pr-3 text-right">{r[1]}</td>
                  <td className="text-right">{r[2]}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {(kind === "switch" || kind === "router") && (
            <>
              <Heading>Drops by reason{kind === "switch" ? " (show dropcounters)" : ""}</Heading>
              {drops.length ? (
                drops.map(([r, n]) => (
                  <div key={r} className="flex justify-between font-mono text-[11px] text-red-300">
                    <span>{r}</span>
                    <span>{n}</span>
                  </div>
                ))
              ) : (
                <div className="text-[11px] text-[#6b7789]">No drops on this port.</div>
              )}
            </>
          )}
        </div>
        <div>
          <Heading>Last frames on this wire</Heading>
          {frames.length ? (
            <div className="space-y-0.5">
              {frames.map((f, i) => (
                <div key={i} className="truncate font-mono text-[10.5px] text-[#c9d3de]" title={f.frame.meta.summary}>
                  <span className={f.dir === "rx" ? "text-emerald-400" : "text-sky-400"}>{f.dir === "rx" ? "← in " : "→ out"}</span>
                  {f.trapped && <span className="text-violet-300"> [to CPU]</span>} {f.frame.meta.summary}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[11px] text-[#6b7789]">No traffic captured yet — try a ping across this port.</div>
          )}
        </div>
      </div>
    </div>
  );
}

export function CpuPanel({ cpu }: { cpu: CpuView }) {
  return (
    <div className="rounded-xl border border-edge bg-panel-2 p-3">
      <div className="text-[13px] font-semibold text-[#e6edf3]">CPU &amp; control plane</div>
      <div className="mt-0.5 text-[11px] leading-snug text-[#8b98a5]">
        The ASIC forwards transit traffic by itself. Only control traffic (ARP, LACP, LLDP, OSPF, BGP, BFD, pings to the switch, TTL expiry) is trapped over PCIe to the CPU, into a CPU queue that CoPP polices.
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2">
        <Fact k="Trapped to CPU" v={String(cpu.totalTrapped)} />
        <Fact k="Policed (dropped)" v={String(cpu.totalPoliced)} />
        <Fact k="Busiest trap" v={cpu.traps[0] ? `${cpu.traps[0].trap} (${cpu.traps[0].pps} pps)` : "—"} />
      </div>
      <Heading>Trap groups → CPU queue (show copp counters)</Heading>
      {cpu.groups.length ? (
        <Table head={["group", "queue", "pkts", "dropped"]} rows={cpu.groups.map((g) => [g.group, g.queue, g.pkts, g.dropPkts])} />
      ) : (
        <div className="text-[11px] text-[#6b7789]">Nothing trapped yet.</div>
      )}
      <Heading>Containers (show feature status · docker ps)</Heading>
      <div className="grid grid-cols-2 gap-1">
        {cpu.containers.map((c) => (
          <div key={c.name} className="flex items-center gap-1.5 text-[11px]" title={c.processes.join(", ")}>
            <span className={`h-1.5 w-1.5 rounded-full ${c.state.includes("enabled") ? "bg-emerald-400" : "bg-slate-600"}`} />
            <span className="text-[#c9d3de]">{c.name}</span>
            <span className="truncate text-[#5f6b7a]">{c.processes.filter((p) => p !== "supervisord").slice(0, 2).join(", ")}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function RouterPanel({ routes, arp }: { routes: RouteRow[]; arp: HostView["arp"] }) {
  const byType = routes.reduce<Record<string, number>>((m, r) => ((m[r.type] = (m[r.type] ?? 0) + 1), m), {});
  return (
    <div className="rounded-xl border border-edge bg-panel-2 p-3">
      <div className="text-[13px] font-semibold text-[#e6edf3]">Route processor</div>
      <div className="mt-0.5 text-[11px] leading-snug text-[#8b98a5]">
        A software router: every packet goes up to the CPU, which looks up the destination in the routing table (longest prefix wins), resolves the next hop with ARP, decrements the TTL and sends it out.
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2">
        <Fact k="Routes" v={String(routes.length)} />
        <Fact k="By source" v={Object.entries(byType).map(([t, n]) => `${t} ${n}`).join(" · ") || "—"} />
        <Fact k="ARP entries" v={String(arp.length)} />
      </div>
      <Heading>Routing table (show ip route)</Heading>
      <Table head={["destination", "via", "dev", "source"]} rows={routes.slice(0, 12).map((r) => [r.dest, r.via, r.dev, `${r.type} [${r.distance}]`])} />
      <Heading>ARP table (show arp)</Heading>
      <Table head={["address", "mac", "dev", "state"]} rows={arp.slice(0, 10).map((a) => [a.ip, a.mac, a.dev, a.state])} />
    </div>
  );
}

const HOST_INTRO = "The NIC accepts frames for its own MAC (plus broadcast and joined multicast) and DMAs them to RAM; the OS network stack does IP, ARP and TCP/UDP and hands data to applications.";

export const INTERNET_INTRO =
  "This node stands in for the whole public internet. It answers for any address routed to it: ping replies come back from that address, and it serves DNS (udp/53), NTP (udp/123, like a public time server) and HTTP (tcp/80). In a real network this edge is the ISP's handoff — the ONT on the left.";

export function HostPanel({ host, title = "Operating system", intro = HOST_INTRO }: { host: HostView; title?: string; intro?: string }) {
  return (
    <div className="rounded-xl border border-edge bg-panel-2 p-3">
      <div className="text-[13px] font-semibold text-[#e6edf3]">{title}</div>
      <div className="mt-0.5 text-[11px] leading-snug text-[#8b98a5]">{intro}</div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <Fact k="Addresses (ip addr)" v={host.addresses.join(", ") || "—"} />
        <Fact k="Default gateway" v={host.gateway ?? "—"} />
      </div>
      <Heading>ARP cache (ip neigh)</Heading>
      {host.arp.length ? (
        <Table head={["address", "mac", "dev", "state"]} rows={host.arp.map((a) => [a.ip, a.mac, a.dev, a.state])} />
      ) : (
        <div className="text-[11px] text-[#6b7789]">Empty — it fills when the host talks to a neighbour.</div>
      )}
      <Heading>Routes (ip route)</Heading>
      <Table head={["destination", "via", "dev"]} rows={host.routes.map((r) => [r.dest, r.via, r.dev])} />
      <Heading>Sockets (ss -tan)</Heading>
      {host.sockets.length ? (
        <Table head={["proto", "state", "local", "peer", "process"]} rows={host.sockets.map((s) => [s.netid, s.state, s.local, s.peer, s.process])} />
      ) : (
        <div className="text-[11px] text-[#6b7789]">No listening sockets or connections.</div>
      )}
    </div>
  );
}

function Table({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <table className="w-full font-mono text-[11px] text-[#c9d3de]">
      <tbody>
        <tr className="text-[#5f6b7a]">
          {head.map((h) => (
            <td key={h} className="pr-2">
              {h}
            </td>
          ))}
        </tr>
        {rows.map((r, i) => (
          <tr key={i}>
            {r.map((c, j) => (
              <td key={j} className="truncate pr-2">
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
