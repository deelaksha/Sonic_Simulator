"use client";
/**
 * Traffic generator. Packets are produced by the simulator's data plane
 * (lib/protocols/traffic.ts): each one is routed, ARP-resolved, switched and
 * counted exactly like `ping`, so port counters, tcpdump and sFlow see it.
 * Every number on this panel is read from the simulated network state.
 */
import { useEffect, useMemo, useState } from "react";
import { useLabStore } from "@/lib/store/lab-store";
import { Device, isHost, isSwitch, findInterface } from "@/lib/models/device";
import { NetInterface } from "@/lib/models/interface";
import { NetworkState } from "@/lib/models/topology";
import { isValidIpv4, isValidPrefix } from "@/lib/models/ip";
import { TrafficProtocol, TrafficSink, peekTrafficSink } from "@/lib/protocols/traffic";
import { LayerSpec } from "@/lib/packetgen/engine";
import { packetEngine } from "@/lib/packetgen/browser";
import { bytesToFrame } from "@/lib/packetgen/frame";
import { PacketBuilder, TEMPLATES, withAddressing } from "./PacketBuilder";

const input = "rounded border border-edge bg-panel px-1.5 py-1 text-[11px] outline-none focus:border-accent-2";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-edge bg-panel-2 p-2.5">
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-[#8b98a5]">{title}</div>
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 py-0.5 text-[11px]">
      <span className="text-[#6b7789]">{label}</span>
      <span className="text-right text-[#c9d3de]">{children}</span>
    </div>
  );
}

/** The switch port a host NIC is cabled to, if any. */
function switchPort(network: NetworkState, nic?: NetInterface): { sw: Device; port: NetInterface } | undefined {
  if (!nic?.connectedTo) return undefined;
  const sw = network.devices[nic.connectedTo.deviceId];
  const port = sw && findInterface(sw, nic.connectedTo.interfaceId);
  return sw && port && isSwitch(sw.type) ? { sw, port } : undefined;
}

function HostConfig({ host }: { host: Device }) {
  const network = useLabStore((s) => s.network);
  const setInterfaceIp = useLabStore((s) => s.setInterfaceIp);
  const setDefaultGateway = useLabStore((s) => s.setDefaultGateway);
  const setAccessVlan = useLabStore((s) => s.setAccessVlan);
  const nic = host.interfaces[0];
  const addr = nic?.ipv4[0];
  const att = switchPort(network, nic);
  const [ip, setIp] = useState(addr ? `${addr.address}/${addr.prefix}` : "");
  const [gw, setGw] = useState(host.config.defaultGateway ?? "");
  const [vlan, setVlan] = useState(att?.port.vlan.mode === "access" ? String(att.port.vlan.accessVlan) : "");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setIp(addr ? `${addr.address}/${addr.prefix}` : "");
    setGw(host.config.defaultGateway ?? "");
    setVlan(att?.port.vlan.mode === "access" ? String(att.port.vlan.accessVlan) : "");
    setError(null);
  }, [host.id, addr?.address, addr?.prefix, host.config.defaultGateway, att?.port.vlan.accessVlan, att?.port.vlan.mode]);

  const apply = () => {
    const [a, p] = ip.split("/");
    if (!isValidIpv4(a) || !isValidPrefix(Number(p))) return setError("IP must be a.b.c.d/len");
    if (gw && !isValidIpv4(gw)) return setError("invalid gateway");
    const v = Number(vlan);
    if (att && vlan && (!Number.isInteger(v) || v < 2 || v > 4094)) return setError("VLAN must be 2-4094");
    setError(null);
    setInterfaceIp(host.id, nic.id, a, Number(p));
    setDefaultGateway(host.id, gw || undefined);
    if (att && vlan && v !== att.port.vlan.accessVlan) setAccessVlan(att.sw.id, att.port.id, v);
  };

  if (!nic) return null;
  return (
    <Section title={`Host · ${host.name}`}>
      <Row label="MAC">{nic.mac}</Row>
      <Row label="Switch port">{att ? `${att.sw.name} ${att.port.name} (${att.port.operState})` : "not cabled to a switch"}</Row>
      <div className="mt-1 grid grid-cols-[70px_1fr] items-center gap-1 text-[11px]">
        <span className="text-[#6b7789]">IP/len</span>
        <input className={input} value={ip} onChange={(e) => setIp(e.target.value)} placeholder="192.168.100.11/24" />
        <span className="text-[#6b7789]">Gateway</span>
        <input className={input} value={gw} onChange={(e) => setGw(e.target.value)} placeholder="(none)" />
        {att && (
          <>
            <span className="text-[#6b7789]">Port VLAN</span>
            <input className={input} value={vlan} onChange={(e) => setVlan(e.target.value)} placeholder="access VLAN" />
          </>
        )}
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <button onClick={apply} className="rounded border border-accent/50 bg-accent/15 px-2 py-1 text-[11px] text-accent-2">
          Apply
        </button>
        {error && <span className="text-[10px] text-red-400">{error}</span>}
      </div>
    </Section>
  );
}

export function TrafficPanel() {
  const network = useLabStore((s) => s.network);
  const selectedDeviceId = useLabStore((s) => s.selectedDeviceId);
  const traffic = useLabStore((s) => s.traffic);
  const startTraffic = useLabStore((s) => s.startTraffic);
  const stopTraffic = useLabStore((s) => s.stopTraffic);

  const hosts = useMemo(() => Object.values(network.devices).filter((d) => isHost(d.type)), [network]);
  const [srcId, setSrcId] = useState<string>("");
  const [dstIp, setDstIp] = useState("");
  const [protocol, setProtocol] = useState<TrafficProtocol>("udp");
  const [srcPort, setSrcPort] = useState("40000");
  const [dstPort, setDstPort] = useState("5001");
  const [size, setSize] = useState("100");
  const [count, setCount] = useState("20");
  const [interval, setIntervalMs] = useState("100");
  const [continuous, setContinuous] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stack, setStack] = useState<LayerSpec[]>(TEMPLATES["DNS query"]);
  const [building, setBuilding] = useState(false);
  /** Which delivery counter the last engine-built packet lands in. */
  const [engineSink, setEngineSink] = useState<keyof TrafficSink | null>(null);

  // Default the source to the selected host (or the first host).
  useEffect(() => {
    if (srcId && network.devices[srcId]) return;
    const sel = selectedDeviceId && network.devices[selectedDeviceId];
    setSrcId(sel && isHost(sel.type) ? sel.id : (hosts[0]?.id ?? ""));
  }, [selectedDeviceId, hosts, network.devices, srcId]);

  const src = srcId ? network.devices[srcId] : undefined;
  const dst = hosts.find((h) => h.interfaces.some((i) => i.ipv4.some((a) => a.address === dstIp)));
  useEffect(() => {
    if (dstIp || !src) return;
    const other = hosts.find((h) => h.id !== src.id && h.interfaces[0]?.ipv4[0]);
    if (other) setDstIp(other.interfaces[0].ipv4[0].address);
  }, [src, hosts, dstIp]);

  const running = !!traffic?.running;
  const common = {
    srcDeviceId: srcId,
    dstIp: dstIp.trim(),
    srcPort: Number(srcPort),
    dstPort: Number(dstPort),
    size: Number(size),
    count: Number(count),
    intervalMs: Number(interval),
    continuous,
  };
  const start = async () => {
    if (protocol !== "engine") return setError(startTraffic({ ...common, protocol }));
    const nic = src?.interfaces[0];
    if (!nic) return setError("select a source host");
    setBuilding(true);
    setError(null);
    try {
      const built = await packetEngine().build(
        withAddressing(stack, { srcMac: nic.mac, dstMac: dst?.interfaces[0]?.mac, srcIp: nic.ipv4[0]?.address, dstIp: dstIp.trim() || undefined }),
      );
      const f = bytesToFrame(built.bytes, built.summary);
      setEngineSink(f.udp ? "udp" : f.tcp ? "tcp" : f.icmp ? "icmp" : null);
      setError(startTraffic({ ...common, protocol: "engine", packet: { bytes: Array.from(built.bytes), summary: built.summary } }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBuilding(false);
    }
  };

  // Path counters straight from the simulated interfaces.
  const srcNic = src?.interfaces[0];
  const ingress = switchPort(network, srcNic);
  const dstNic = dst?.interfaces[0];
  const egress = switchPort(network, dstNic);
  const sink = dst ? peekTrafficSink(dst) : undefined;
  const specProto = traffic?.spec.protocol ?? protocol;
  const proto: keyof TrafficSink | null = specProto === "engine" ? engineSink : specProto;

  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-[10px] text-amber-300">
        Simulated data plane — packets are generated and forwarded by the simulator engine (not a physical network).
      </div>

      {src && <HostConfig host={src} />}

      <Section title="Traffic">
        <div className="grid grid-cols-[70px_1fr] items-center gap-1 text-[11px]">
          <span className="text-[#6b7789]">Source</span>
          <select className={input} value={srcId} onChange={(e) => setSrcId(e.target.value)} disabled={running}>
            {hosts.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name} {h.interfaces[0]?.ipv4[0]?.address ?? "(no IP)"}
              </option>
            ))}
          </select>
          <span className="text-[#6b7789]">Destination</span>
          <div className="flex gap-1">
            <input className={`${input} min-w-0 flex-1`} value={dstIp} onChange={(e) => setDstIp(e.target.value)} disabled={running} />
            <select className={`${input} w-20`} value="" onChange={(e) => e.target.value && setDstIp(e.target.value)} disabled={running}>
              <option value="">host…</option>
              {hosts
                .filter((h) => h.id !== srcId && h.interfaces[0]?.ipv4[0])
                .map((h) => (
                  <option key={h.id} value={h.interfaces[0].ipv4[0].address}>
                    {h.name}
                  </option>
                ))}
            </select>
          </div>
          <span className="text-[#6b7789]">Protocol</span>
          <div className="flex gap-2">
            {(["icmp", "udp", "tcp", "engine"] as TrafficProtocol[]).map((p) => (
              <label key={p} className="flex items-center gap-1 text-[#c9d3de]" title={p === "engine" ? "Any protocol, built by the packet engine (Scapy)" : undefined}>
                <input type="radio" checked={protocol === p} onChange={() => setProtocol(p)} disabled={running} />
                {p === "engine" ? "Any (Scapy)" : p.toUpperCase()}
              </label>
            ))}
          </div>
          {protocol === "engine" && (
            <div className="col-span-2">
              <PacketBuilder
                stack={stack}
                onChange={setStack}
                disabled={running}
                addressing={{ srcMac: src?.interfaces[0]?.mac ?? "02:00:00:00:00:00", dstMac: dst?.interfaces[0]?.mac, srcIp: src?.interfaces[0]?.ipv4[0]?.address, dstIp: dstIp.trim() || undefined }}
              />
            </div>
          )}
          {(protocol === "udp" || protocol === "tcp") && (
            <>
              <span className="text-[#6b7789]">Src / dst port</span>
              <div className="flex gap-1">
                <input className={`${input} w-1/2`} value={srcPort} onChange={(e) => setSrcPort(e.target.value)} disabled={running} />
                <input className={`${input} w-1/2`} value={dstPort} onChange={(e) => setDstPort(e.target.value)} disabled={running} />
              </div>
            </>
          )}
          {protocol !== "engine" && (
            <>
              <span className="text-[#6b7789]">Payload bytes</span>
              <input className={input} value={size} onChange={(e) => setSize(e.target.value)} disabled={running} />
            </>
          )}
          <span className="text-[#6b7789]">Count</span>
          <div className="flex items-center gap-2">
            <input className={`${input} w-20`} value={count} onChange={(e) => setCount(e.target.value)} disabled={running || continuous} />
            <label className="flex items-center gap-1 text-[#c9d3de]">
              <input type="checkbox" checked={continuous} onChange={(e) => setContinuous(e.target.checked)} disabled={running} />
              continuous
            </label>
          </div>
          <span className="text-[#6b7789]">Interval ms</span>
          <input className={input} value={interval} onChange={(e) => setIntervalMs(e.target.value)} disabled={running} />
        </div>
        <div className="mt-2 flex items-center gap-2">
          {running ? (
            <button onClick={stopTraffic} className="rounded border border-red-500/50 bg-red-500/15 px-3 py-1 text-[11px] text-red-300">
              Stop
            </button>
          ) : (
            <button onClick={start} disabled={building} className="rounded border border-green-500/50 bg-green-500/15 px-3 py-1 text-[11px] text-green-300">
              {building ? "Building…" : "Start"}
            </button>
          )}
          {error && <span className="text-[10px] text-red-400">{error}</span>}
        </div>
        <p className="mt-1.5 text-[10px] leading-relaxed text-[#5f6b7a]">
          TCP sends SYNs; a host with no listener answers RST,ACK. &quot;Any (Scapy)&quot; packets are built once and sent as built — the
          engine crafts packets, it does not run protocol state machines. Intervals under 50 ms are simulated in batches.
        </p>
      </Section>

      {traffic && (
        <Section title={`Run · ${traffic.running ? "running" : "stopped"}`}>
          <Row label="Spec">
            {traffic.spec.protocol.toUpperCase()} → {traffic.spec.dstIp}
            {traffic.spec.protocol !== "icmp" ? `:${traffic.spec.dstPort}` : ""} · {traffic.spec.size} B
          </Row>
          <Row label="Sent by source">{traffic.sent}</Row>
          <Row label="Not sent">
            {traffic.failed}
            {traffic.lastFailure ? ` (${traffic.lastFailure})` : ""}
          </Row>
          {Object.keys(traffic.drops).length > 0 && (
            <div className="mt-1.5">
              <div className="text-[10px] text-[#6b7789]">Dropped on the path (engine events)</div>
              <ul className="mt-0.5 space-y-0.5 text-[10px] text-amber-300">
                {Object.entries(traffic.drops)
                  .sort((a, b) => b[1] - a[1])
                  .map(([msg, n]) => (
                    <li key={msg}>
                      {n}× {msg}
                    </li>
                  ))}
              </ul>
            </div>
          )}
        </Section>
      )}

      <Section title="Path (interface counters)">
        <Row label={`${src?.name ?? "source"} ${srcNic?.name ?? ""} tx`}>{srcNic?.statistics.txFrames ?? "—"}</Row>
        <Row label={ingress ? `${ingress.sw.name} ${ingress.port.name} rx` : "switch ingress"}>
          {ingress ? ingress.port.statistics.rxFrames : "not cabled"}
        </Row>
        <Row label={egress ? `${egress.sw.name} ${egress.port.name} tx` : "switch egress"}>
          {egress ? egress.port.statistics.txFrames : dst ? "not cabled" : "—"}
        </Row>
        <Row label={`${dst?.name ?? "destination"} ${dstNic?.name ?? ""} rx`}>{dstNic?.statistics.rxFrames ?? "—"}</Row>
        {proto && <Row label={`${dst?.name ?? "destination"} ${proto.toUpperCase()} delivered`}>{sink ? sink[proto].packets : 0}</Row>}
        {dstIp && !dst && <div className="mt-1 text-[10px] text-amber-400">No host in the lab owns {dstIp}.</div>}
        <p className="mt-1 text-[10px] text-[#5f6b7a]">Counters are cumulative (they include ARP and other traffic).</p>
      </Section>
    </div>
  );
}
