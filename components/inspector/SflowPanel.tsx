"use client";
/**
 * sFlow monitor: agent config (CONFIG_DB) and sessions (APPL_DB) on a switch,
 * the export pipeline with failure diagnosis, and the samples a collector host
 * actually received — decoded from the received datagram octets. Expected
 * values (e.g. ~N samples at 1/rate) are labelled as expectations; observed
 * values come only from the simulator's agent and collector state.
 */
import { useEffect, useMemo, useState } from "react";
import { useLabStore } from "@/lib/store/lab-store";
import { Device, isSwitch } from "@/lib/models/device";
import {
  DEFAULT_POLLING_INTERVAL,
  frontPanelPorts,
  peekSflowRuntime,
  peekSflowState,
  selectAgentAddress,
  sflowIfIndex,
  sflowSessions,
} from "@/lib/sflow/agent";
import { peekCollector } from "@/lib/sflow/collector";
import { decodeDatagram, decodeEthernetHeader, CounterSample, FlowSample } from "@/lib/sflow/datagram";
import { tcpdumpTime } from "@/lib/commands/tcpdump";

const input = "rounded border border-edge bg-panel px-1.5 py-1 text-[11px] outline-none focus:border-accent-2";

function Section({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-edge bg-panel-2 p-2.5">
      <div className="mb-1.5 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wide text-[#8b98a5]">
        <span>{title}</span>
        {right}
      </div>
      {children}
    </div>
  );
}

function Row({ label, children, tone }: { label: string; children: React.ReactNode; tone?: "ok" | "bad" | "warn" }) {
  const color = tone === "ok" ? "text-green-400" : tone === "bad" ? "text-red-400" : tone === "warn" ? "text-amber-400" : "text-[#c9d3de]";
  return (
    <div className="flex items-center justify-between gap-2 py-0.5 text-[11px]">
      <span className="text-[#6b7789]">{label}</span>
      <span className={`text-right tabular-nums ${color}`}>{children}</span>
    </div>
  );
}

/** Form that applies sFlow config to the switch through KLISH (same path as typing it). */
function ConfigForm({ sw }: { sw: Device }) {
  const runCliScript = useLabStore((s) => s.runCliScript);
  const st = peekSflowState(sw);
  const ports = frontPanelPorts(sw);
  const [enabled, setEnabled] = useState(st?.enabled ?? true);
  const [colIp, setColIp] = useState(st?.collectors[0]?.ip ?? "");
  const [colPort, setColPort] = useState(String(st?.collectors[0]?.port ?? 6343));
  const [vrf, setVrf] = useState(st?.collectors[0]?.vrf ?? "default");
  const [agent, setAgent] = useState(st?.agentId ?? "");
  const [polling, setPolling] = useState(String(st?.pollingInterval ?? 5));
  const [rate, setRate] = useState("256");
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    setSelected(Object.fromEntries(ports.map((p) => [p.name, st?.interfaces[p.name]?.enabled !== false])));
  }, [sw.id]);

  const apply = () => {
    const lines = ["configure terminal", enabled ? "sflow enable" : "no sflow enable"];
    if (colIp) {
      const exists = st?.collectors.some((c) => c.ip === colIp && String(c.port) === colPort && c.vrf === vrf);
      if (!exists) lines.push(`sflow collector ${colIp} ${colPort}${vrf !== "default" ? ` vrf ${vrf}` : ""}`);
    }
    lines.push(agent ? `sflow agent-id ${agent.replace(/^([A-Za-z]+)(\d+)$/, "$1 $2")}` : "no sflow agent-id");
    lines.push(`sflow polling-interval ${polling}`);
    for (const p of ports) {
      const num = p.name.replace(/^Ethernet/, "");
      lines.push(`interface Ethernet ${num}`);
      if (selected[p.name]) {
        lines.push("sflow enable", rate ? `sflow sampling-rate ${rate}` : "no sflow sampling-rate");
      } else {
        lines.push("no sflow enable");
      }
      lines.push("exit");
    }
    lines.push("end");
    const errors = runCliScript(sw.id, lines);
    setResult(errors.length ? errors.map((e) => e.text).join("; ") : `applied ${lines.length} KLISH lines (see the ${sw.name} terminal)`);
  };

  const agentChoices = sw.interfaces.filter((i) => i.ipv4.length || !i.logical).map((i) => (i.management ? "Management0" : i.name));

  return (
    <Section title="Configure (KLISH)">
      <div className="grid grid-cols-[86px_1fr] items-center gap-1 text-[11px]">
        <span className="text-[#6b7789]">Global</span>
        <label className="flex items-center gap-1 text-[#c9d3de]">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> sflow enable
        </label>
        <span className="text-[#6b7789]">Collector</span>
        <div className="flex gap-1">
          <input className={`${input} min-w-0 flex-1`} value={colIp} onChange={(e) => setColIp(e.target.value)} placeholder="IP" />
          <input className={`${input} w-14`} value={colPort} onChange={(e) => setColPort(e.target.value)} />
          <select className={`${input} w-[72px]`} value={vrf} onChange={(e) => setVrf(e.target.value)}>
            <option value="default">default</option>
            <option value="mgmt">mgmt</option>
          </select>
        </div>
        <span className="text-[#6b7789]">Agent-id</span>
        <select className={input} value={agent} onChange={(e) => setAgent(e.target.value)}>
          <option value="">default (hsflowd picks)</option>
          {agentChoices.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <span className="text-[#6b7789]">Polling (s)</span>
        <input className={input} value={polling} onChange={(e) => setPolling(e.target.value)} placeholder="0 or 5-300" />
        <span className="text-[#6b7789]">Port rate 1/N</span>
        <input className={input} value={rate} onChange={(e) => setRate(e.target.value)} placeholder="empty = port speed" />
        <span className="text-[#6b7789]">Interfaces</span>
        <div className="flex flex-wrap gap-x-2">
          {ports.map((p) => (
            <label key={p.id} className="flex items-center gap-1 text-[#c9d3de]">
              <input type="checkbox" checked={!!selected[p.name]} onChange={(e) => setSelected({ ...selected, [p.name]: e.target.checked })} />
              {p.name}
            </label>
          ))}
        </div>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button onClick={apply} className="rounded border border-accent/50 bg-accent/15 px-2 py-1 text-[11px] text-accent-2">
          Apply to switch
        </button>
        {result && <span className="text-[10px] text-[#8b98a5]">{result}</span>}
      </div>
    </Section>
  );
}

interface DecodedFlow {
  atMs: number;
  agent: string;
  s: FlowSample;
}
interface DecodedCounter {
  atMs: number;
  agent: string;
  s: CounterSample;
}

export function SflowPanel() {
  const network = useLabStore((s) => s.network);
  const selectedDeviceId = useLabStore((s) => s.selectedDeviceId);
  const traffic = useLabStore((s) => s.traffic);
  const sflowErrors = useLabStore((s) => s.sflowErrors);
  const setCollector = useLabStore((s) => s.setCollector);
  const clearCollector = useLabStore((s) => s.clearCollector);

  const switches = Object.values(network.devices).filter((d) => isSwitch(d.type));
  const [swId, setSwId] = useState("");
  useEffect(() => {
    const sel = selectedDeviceId && network.devices[selectedDeviceId];
    if (sel && isSwitch(sel.type)) setSwId(sel.id);
    else if (!swId || !network.devices[swId]) setSwId(switches[0]?.id ?? "");
  }, [selectedDeviceId, network.devices, swId, switches]);
  const sw = swId ? network.devices[swId] : undefined;

  const st = sw ? peekSflowState(sw) : undefined;
  const sessions = sw ? sflowSessions(sw) : [];
  const rt = sw ? peekSflowRuntime(sw) : undefined;
  const agent = sw ? selectAgentAddress(sw) : {};
  const ifName = useMemo(() => {
    const m = new Map<number, string>();
    if (sw) for (const p of frontPanelPorts(sw)) m.set(sflowIfIndex(p.name) ?? -1, p.name);
    return m;
  }, [sw]);

  // Collector hosts = devices owning a configured collector IP, plus any host running a collector.
  const collectorHosts = Object.values(network.devices).filter(
    (d) => peekCollector(d) || st?.collectors.some((c) => d.interfaces.some((i) => i.ipv4.some((a) => a.address === c.ip))),
  );

  const decoded = useMemo(() => {
    const flows: DecodedFlow[] = [];
    const counters: DecodedCounter[] = [];
    for (const d of collectorHosts) {
      for (const r of peekCollector(d)?.recent ?? []) {
        try {
          const dg = decodeDatagram(r.bytes);
          for (const s of dg.samples) {
            if (s.kind === "flow") flows.push({ atMs: r.atMs, agent: dg.agentIp, s });
            else counters.push({ atMs: r.atMs, agent: dg.agentIp, s });
          }
        } catch {
          /* counted in decodeErrors */
        }
      }
    }
    return { flows: flows.reverse().slice(0, 30), counters: counters.reverse().slice(0, 30) };
  }, [network]);

  if (!sw) return <div className="p-3 text-[11px] text-[#6b7789]">Add a switch (or load the sFlow feature lab) to monitor sFlow.</div>;

  const received = collectorHosts.reduce((n, d) => n + (peekCollector(d)?.datagrams ?? 0), 0);
  const flowRx = collectorHosts.reduce((n, d) => n + (peekCollector(d)?.flowSamples ?? 0), 0);
  const counterRx = collectorHosts.reduce((n, d) => n + (peekCollector(d)?.counterSamples ?? 0), 0);
  const activeSessions = sessions.filter((s) => s.adminState === "up");
  const meanRate = activeSessions.length ? activeSessions.reduce((n, s) => n + s.sampleRate, 0) / activeSessions.length : 0;
  const expectedFlows = rt && meanRate ? rt.stats.sampledPortPackets / meanRate : 0;
  const polling = st?.pollingInterval ?? DEFAULT_POLLING_INTERVAL;

  // First failing stage, in pipeline order.
  const problems: string[] = [];
  if (!st?.enabled) problems.push("sFlow is globally disabled — `sflow enable`.");
  else {
    if (!activeSessions.length) problems.push("No interface has an active (admin up) session.");
    if (!st.collectors.length) problems.push("No collector configured — `sflow collector <ip> [<port>]`.");
    if (agent.reason) problems.push(agent.reason);
    for (const c of st.collectors) {
      const host = Object.values(network.devices).find((d) => d.interfaces.some((i) => i.ipv4.some((a) => a.address === c.ip)));
      const col = host && peekCollector(host);
      if (!host) problems.push(`No device in the lab owns collector address ${c.ip}.`);
      else if (!col?.listening) problems.push(`${host.name} owns ${c.ip} but no collector process is listening.`);
      else if (col.port !== c.port) problems.push(`${host.name} listens on UDP ${col.port}, the switch sends to ${c.port}.`);
    }
    for (const e of sflowErrors[sw.id] ?? []) problems.push(e);
    if (polling === 0) problems.push("Counter polling is disabled (polling-interval 0) — no COUNTER samples will be sent.");
  }

  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-[10px] text-amber-300">
        Simulated sFlow agent (modelled on SONiC sflowmgrd/hsflowd). Samples below are decoded from datagrams the collector host received in the
        simulation.
      </div>

      <div className="flex items-center gap-2 text-[11px]">
        <span className="text-[#6b7789]">Switch</span>
        <select className={input} value={swId} onChange={(e) => setSwId(e.target.value)}>
          {switches.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>

      <Section title="Agent (CONFIG_DB)">
        <Row label="Admin state" tone={st?.enabled ? "ok" : "bad"}>
          {st?.enabled ? "up" : "down"}
        </Row>
        <Row label="Agent address" tone={agent.ip ? undefined : "bad"}>
          {agent.ip ? `${agent.ip} (${agent.iface}${st?.agentId ? "" : ", auto"})` : (agent.reason ?? "—")}
        </Row>
        <Row label="Sub-agent id">100000</Row>
        <Row label="Polling interval">
          {st?.pollingInterval ?? `default (${DEFAULT_POLLING_INTERVAL})`}
          {polling > 0 && polling < 5 ? " → 5 (hsflowd minimum)" : ""}
        </Row>
        <Row label="Global sampling-rate">{st?.sampleRate !== undefined ? `${st.sampleRate} (stored, not applied to ports)` : "—"}</Row>
        {(st?.collectors ?? []).map((c) => (
          <Row key={c.name} label="Collector">
            {c.ip} udp/{c.port} vrf {c.vrf}
          </Row>
        ))}
        {!st?.collectors.length && <Row label="Collector">none</Row>}
      </Section>

      <Section title="Sessions (APPL_DB)">
        {sessions.length === 0 ? (
          <div className="text-[11px] text-[#6b7789]">No sessions (sFlow disabled or no port enabled).</div>
        ) : (
          <table className="w-full text-[11px]">
            <thead className="text-[#6b7789]">
              <tr>
                <th className="text-left font-normal">Port</th>
                <th className="text-left font-normal">ifIndex</th>
                <th className="text-left font-normal">Admin</th>
                <th className="text-left font-normal">Dir</th>
                <th className="text-right font-normal">Rate 1/N</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.port} className="text-[#c9d3de]">
                  <td>{s.port}</td>
                  <td>{sflowIfIndex(s.port)}</td>
                  <td className={s.adminState === "up" ? "text-green-400" : "text-[#6b7789]"}>{s.adminState}</td>
                  <td>{s.direction}</td>
                  <td className="text-right tabular-nums" title={s.rateSource === "port-speed" ? "default = port speed (Mbps)" : "configured"}>
                    {s.sampleRate}
                    {s.rateSource === "port-speed" ? "*" : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {sessions.some((s) => s.rateSource === "port-speed") && <div className="mt-1 text-[10px] text-[#5f6b7a]">* default rate = port speed in Mbps (sflowmgrd)</div>}
      </Section>

      <ConfigForm key={sw.id} sw={sw} />

      <Section title="Pipeline">
        <Row label="Traffic generator sent">{traffic ? traffic.sent : "—"}</Row>
        <Row label="Frames on sampled ports">{rt?.stats.sampledPortPackets ?? 0}</Row>
        <Row label="FLOW samples taken" tone={rt?.stats.flowSamples ? "ok" : undefined}>
          {rt?.stats.flowSamples ?? 0}
          {expectedFlows > 0 && <span className="text-[#6b7789]"> (expected ≈ {expectedFlows.toFixed(1)})</span>}
        </Row>
        <Row label="COUNTER samples polled">{rt?.stats.counterSamples ?? 0}</Row>
        <Row label="Datagrams sent by agent">{rt?.stats.datagramsSent ?? 0}</Row>
        <Row label="Samples discarded">{rt?.stats.samplesDiscarded ?? 0}</Row>
        <Row label="Datagrams received at collector" tone={received ? "ok" : rt?.stats.datagramsSent ? "bad" : undefined}>
          {received}
        </Row>
        <Row label="FLOW / COUNTER decoded">
          {flowRx} / {counterRx}
        </Row>
        {problems.length > 0 && (
          <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-[10px] text-amber-300">
            {problems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        )}
        {st?.enabled && !problems.length && expectedFlows < 1 && (rt?.stats.sampledPortPackets ?? 0) > 0 && (
          <div className="mt-1.5 text-[10px] text-[#8b98a5]">
            Sampling is random 1-in-{Math.round(meanRate)}: {rt?.stats.sampledPortPackets} frames → fewer than one sample expected. Send more traffic or lower the
            port sampling-rate (minimum 256).
          </div>
        )}
      </Section>

      {collectorHosts.map((d) => {
        const c = peekCollector(d);
        return (
          <Section
            key={d.id}
            title={`Collector · ${d.name}`}
            right={
              <span className="flex gap-1 normal-case">
                <button
                  className="rounded border border-edge px-1.5 text-[10px] text-[#c9d3de]"
                  onClick={() => setCollector(d.id, !c?.listening, c?.port ?? st?.collectors[0]?.port ?? 6343)}
                >
                  {c?.listening ? "stop" : "start"}
                </button>
                <button className="rounded border border-edge px-1.5 text-[10px] text-[#c9d3de]" onClick={() => clearCollector(d.id)}>
                  reset
                </button>
              </span>
            }
          >
            <Row label="Listening" tone={c?.listening ? "ok" : "bad"}>
              {c?.listening ? `udp/${c.port} on ${d.interfaces.map((i) => i.ipv4[0]?.address).filter(Boolean).join(", ")}` : "no"}
            </Row>
            <Row label="Datagrams">{c?.datagrams ?? 0}</Row>
            <Row label="FLOW samples">{c?.flowSamples ?? 0}</Row>
            <Row label="COUNTER samples">{c?.counterSamples ?? 0}</Row>
            {!!c?.decodeErrors && <Row label="Decode errors" tone="bad">{c.decodeErrors}</Row>}
          </Section>
        );
      })}

      <Section title={`FLOW samples received (${decoded.flows.length} latest)`}>
        {decoded.flows.length === 0 ? (
          <div className="text-[11px] text-[#6b7789]">None received yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-[10.5px]">
              <thead className="text-[#6b7789]">
                <tr>
                  <th className="pr-2 text-left font-normal">Time</th>
                  <th className="pr-2 text-left font-normal">In → Out</th>
                  <th className="pr-2 text-left font-normal">Flow</th>
                  <th className="pr-2 text-right font-normal">Rate</th>
                  <th className="text-right font-normal">Pool / seq</th>
                </tr>
              </thead>
              <tbody className="text-[#c9d3de]">
                {decoded.flows.map(({ atMs, s }, i) => {
                  const h = s.header ? decodeEthernetHeader(s.header.bytes) : undefined;
                  const ports = h?.srcPort !== undefined ? `:${h.srcPort} → ${h.dstIp}:${h.dstPort}` : ` → ${h?.dstIp ?? "?"}`;
                  return (
                    <tr key={i}>
                      <td className="pr-2 text-[#8b98a5]">{tcpdumpTime(atMs).slice(0, 12)}</td>
                      <td className="pr-2" title={`ifIndex ${s.input} → ${s.output}`}>
                        {ifName.get(s.input) ?? s.input} → {s.output === 0 ? "0 (unknown)" : (ifName.get(s.output) ?? s.output)}
                      </td>
                      <td className="whitespace-normal pr-2">
                        {h?.protocol ?? "?"} {h?.srcIp}
                        {ports}
                      </td>
                      <td className="pr-2 text-right tabular-nums">1/{s.samplingRate}</td>
                      <td className="text-right tabular-nums">
                        {s.samplePool} / {s.seq}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="mt-1 text-[10px] text-[#5f6b7a]">0 = unknown: psample reports only the port the sample was taken on (ingress → input, egress → output).</div>
          </div>
        )}
      </Section>

      <Section title={`COUNTER samples received (${decoded.counters.length} latest${polling ? ` · polled every ${Math.max(5, polling)} s` : ""})`}>
        {decoded.counters.length === 0 ? (
          <div className="text-[11px] text-[#6b7789]">None received yet{polling ? ` (polling every ${Math.max(5, polling)} s)` : " (polling disabled)"}.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-[10.5px]">
              <thead className="text-[#6b7789]">
                <tr>
                  <th className="pr-2 text-left font-normal">Time</th>
                  <th className="pr-2 text-left font-normal">Port</th>
                  <th className="pr-2 text-left font-normal">Status</th>
                  <th className="pr-2 text-right font-normal">In pkts / octets</th>
                  <th className="text-right font-normal">Out pkts / octets</th>
                </tr>
              </thead>
              <tbody className="text-[#c9d3de]">
                {decoded.counters.map(({ atMs, s }, i) => {
                  const g = s.generic;
                  return (
                    <tr key={i}>
                      <td className="pr-2 text-[#8b98a5]">{tcpdumpTime(atMs).slice(0, 12)}</td>
                      <td className="pr-2" title={`ifIndex ${s.dsIndex}, seq ${s.seq}`}>
                        {s.portName ?? s.dsIndex}
                      </td>
                      <td className="pr-2">{g ? (g.ifStatus & 2 ? "up" : g.ifStatus & 1 ? "admin up" : "down") : "—"}</td>
                      <td className="pr-2 text-right tabular-nums">{g ? `${g.inUcast + g.inMulticast + g.inBroadcast} / ${g.inOctets}` : "—"}</td>
                      <td className="text-right tabular-nums">{g ? `${g.outUcast + g.outMulticast + g.outBroadcast} / ${g.outOctets}` : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}
