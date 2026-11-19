"use client";
/**
 * "View realistic": the whole lab as real hardware — network gear in a rack (the
 * ISP ONT on a shelf on top, switches, routers, rack servers), PCs on a desk with
 * monitor and tower, and patch cables drawn port-to-port for every connection.
 * Same live data as the hardware view: link LEDs, activity blinks, and a glowing
 * dot runs along a cable in the direction frames are being sent. Click a device
 * (or a port) to open its hardware view.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLabStore } from "@/lib/store/lab-store";
import { Device } from "@/lib/models/device";
import { ChassisKind, chassisKind, packetHops, peerOf, portViews, PortView } from "@/lib/switch3d/model";
import { CSS } from "./styles";
import { FaceProps, InternetFace, RouterFace, ServerRear, SwitchFace } from "./faces";
import { Port, cableColor } from "./parts";

const RACK_SCALE = 0.62;
const UNIT: Partial<Record<ChassisKind, { W: number; H: number }>> = {
  switch: { W: 980, H: 118 },
  router: { W: 980, H: 118 },
  server: { W: 980, H: 118 },
  internet: { W: 720, H: 150 },
};

/** Per-interface frame counters → which ports moved (and which sent) in the last tick. */
function useActivity() {
  const last = useRef<Record<string, [number, number]>>({});
  const [act, setAct] = useState<{ active: Set<string>; sent: Set<string> }>({ active: new Set(), sent: new Set() });
  useEffect(() => {
    const t = setInterval(() => {
      const active = new Set<string>();
      const sent = new Set<string>();
      for (const d of Object.values(useLabStore.getState().network.devices)) {
        for (const i of d.interfaces) {
          const now: [number, number] = [i.statistics.rxFrames, i.statistics.txFrames];
          const prev = last.current[i.id];
          if (prev && (prev[0] !== now[0] || prev[1] !== now[1])) active.add(i.id);
          if (prev && prev[1] !== now[1]) sent.add(i.id);
          last.current[i.id] = now;
        }
      }
      setAct({ active, sent });
    }, 200);
    return () => clearInterval(t);
  }, []);
  return act;
}

/** Patch-cable colour by what it connects: host drops blue, routed links yellow, ISP red, switch-to-switch cyan. */
function cableTone(a: string, b: string): string {
  const t = [a, b];
  if (t.some((x) => chassisKind(x as Device["type"]) === "pc" || chassisKind(x as Device["type"]) === "server")) return cableColor("pc");
  if (t.includes("internet")) return cableColor("internet");
  if (t.some((x) => chassisKind(x as Device["type"]) === "router")) return cableColor("router");
  return cableColor("switch");
}

interface CableGeom {
  id: string;
  d: string;
  color: string;
  up: boolean;
  title: string;
  a: string; // iface ids at each end
  b: string;
}

export function RealisticScene() {
  const net = useLabStore((s) => s.network);
  const open = useLabStore((s) => s.openDeviceView);
  const { active, sent } = useActivity();

  // Packet animation: when a command (ping, traceroute…) runs, replay its frames hop by
  // hop along the real cables, in the order the simulator sent them.
  const events = useLabStore((s) => s.events);
  const firstEvents = useRef(events);
  const hops = useMemo(() => packetHops(events), [events]);
  const [hopIdx, setHopIdx] = useState(-1);
  const [speed, setSpeed] = useState(1);
  const [run, setRun] = useState(0); // bump to replay
  // Auto-play new commands; what ran before the scene opened plays on "Replay".
  useEffect(() => setHopIdx(hops.length && (run > 0 || events !== firstEvents.current) ? 0 : -1), [hops, run, events]);
  const HOP_MS = 650 / speed;
  useEffect(() => {
    if (hopIdx < 0 || hopIdx >= hops.length) return;
    const t = setTimeout(() => setHopIdx((i) => i + 1), HOP_MS);
    return () => clearTimeout(t);
  }, [hopIdx, hops.length, HOP_MS]);
  const hop = hopIdx >= 0 ? hops[hopIdx] : undefined;
  const devices = Object.values(net.devices).filter((d) => chassisKind(d.type));
  const kindOf = (d: Device) => chassisKind(d.type)!;
  const order: ChassisKind[] = ["internet", "router", "switch", "server"];
  const rack = devices.filter((d) => kindOf(d) !== "pc").sort((a, b) => order.indexOf(kindOf(a)) - order.indexOf(kindOf(b)) || a.name.localeCompare(b.name));
  const desk = devices.filter((d) => kindOf(d) === "pc").sort((a, b) => a.name.localeCompare(b.name));

  // Cable geometry from where the port elements actually are on screen.
  const wrap = useRef<HTMLDivElement>(null);
  const rackRef = useRef<HTMLDivElement>(null);
  const [cables, setCables] = useState<CableGeom[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const measure = () => {
      const root = wrap.current;
      if (!root) return;
      const box = root.getBoundingClientRect();
      const rackBox = rackRef.current?.getBoundingClientRect();
      const center = (devId: string, ifId: string) => {
        const el = root.querySelector(`[data-dev="${devId}"] [data-iface="${ifId}"]`);
        if (!el) return undefined;
        const r = el.getBoundingClientRect();
        return { x: r.left - box.left + r.width / 2, y: r.top - box.top + r.height / 2, inRack: !!rackBox && r.left >= rackBox.left && r.right <= rackBox.right && r.top >= rackBox.top && r.bottom <= rackBox.bottom };
      };
      const out: CableGeom[] = [];
      const st = useLabStore.getState().network;
      st.connections.forEach((c, idx) => {
        const a = center(c.a.deviceId, c.a.interfaceId);
        const b = center(c.b.deviceId, c.b.interfaceId);
        if (!a || !b) return;
        const da = st.devices[c.a.deviceId];
        const db = st.devices[c.b.deviceId];
        const ia = da?.interfaces.find((i) => i.id === c.a.interfaceId);
        const ib = db?.interfaces.find((i) => i.id === c.b.interfaceId);
        if (!da || !db || !ia || !ib) return;
        let d: string;
        if (a.inRack && b.inRack && rackBox) {
          // rack-to-rack patch: out to the side cable manager and back in
          const side = rackBox.right - box.left + 18 + (idx % 6) * 9;
          d = `M ${a.x} ${a.y} C ${side} ${a.y}, ${side} ${b.y}, ${b.x} ${b.y}`;
        } else {
          // drop from the rack down to the desk with a natural sag
          const sag = Math.max(60, Math.abs(b.y - a.y) * 0.5) * (a.y < b.y ? 1 : -1);
          d = `M ${a.x} ${a.y} C ${a.x} ${a.y + sag}, ${b.x} ${b.y - sag}, ${b.x} ${b.y}`;
        }
        const up = ia.operState === "up" && ib.operState === "up";
        out.push({
          id: c.id,
          d,
          color: cableTone(da.type, db.type),
          up,
          title: `${da.name} ${ia.name} ↔ ${db.name} ${ib.name} · ${up ? `up ${ia.speed >= 1000 ? `${ia.speed / 1000}G` : `${ia.speed}M`}` : "down"}`,
          a: ia.id,
          b: ib.id,
        });
      });
      setCables(out);
      setSize({ w: root.scrollWidth, h: root.scrollHeight });
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (wrap.current) ro.observe(wrap.current);
    const t = setInterval(measure, 700);
    return () => {
      ro.disconnect();
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [net.connections.length, devices.length]);

  if (!devices.length) {
    return <div className="flex h-full items-center justify-center text-sm text-[#6b7789]">Load a lab to see it as real hardware.</div>;
  }

  return (
    <div className="h-full w-full overflow-auto bg-[radial-gradient(circle_at_50%_0%,#1b2433_0%,#0b0e13_60%)]">
      <style>{CSS}</style>
      <div ref={wrap} className="relative mx-auto flex min-w-max flex-col items-center gap-6 px-10 pb-10 pt-14">
        <div className="sticky top-2 z-20 flex min-h-[30px] items-center gap-2 rounded-md border border-edge bg-panel/90 px-3 py-1 text-[11px] shadow">
          {hop ? (
            <>
              <span className="rounded px-1.5 py-0.5 font-semibold text-black" style={{ background: hop.color }}>
                {hop.label}
              </span>
              <span className="font-mono text-[#c9d3de]">
                hop {hopIdx + 1}/{hops.length} · {hop.text}
              </span>
            </>
          ) : (
            <span className="text-[#6b7789]">
              {hops.length ? `Last command: ${hops.length} hops — press Replay to watch them.` : "Run ping (or traceroute) in the terminal to watch the packets travel. Click a device for its hardware view."}
            </span>
          )}
          <span className="ml-2 flex overflow-hidden rounded border border-edge">
            {[0.5, 1, 2].map((v) => (
              <button key={v} onClick={() => setSpeed(v)} className={`px-1.5 ${speed === v ? "bg-accent-2/20 text-accent-2" : "text-[#8b98a5]"}`}>
                {v}×
              </button>
            ))}
          </span>
          {hops.length > 0 && (
            <button onClick={() => setRun((n) => n + 1)} className="rounded border border-edge px-1.5 text-[#8b98a5] hover:text-accent-2">
              ↻ Replay
            </button>
          )}
        </div>
        {/* rack */}
        <div ref={rackRef} className="relative flex flex-col items-center rounded-md border border-[#1f2633] bg-[#090b0f] px-7 pb-4 pt-3 shadow-2xl">
          <div className="absolute inset-y-2 left-2 w-3 rounded-sm bg-[repeating-linear-gradient(180deg,#2a313d_0_6px,#0a0c10_6px_10px)]" />
          <div className="absolute inset-y-2 right-2 w-3 rounded-sm bg-[repeating-linear-gradient(180deg,#2a313d_0_6px,#0a0c10_6px_10px)]" />
          <div className="mb-2 font-mono text-[9px] uppercase tracking-widest text-[#4b5563]">19&quot; rack</div>
          <div className="flex flex-col gap-2.5">
            {rack.map((d, i) => (
              <RackUnit key={d.id} device={d} unit={i + 1} active={active} onOpen={() => open(d.id)} focus={hop?.toDeviceId === d.id ? hop.color : undefined} />
            ))}
          </div>
        </div>
        {/* desk */}
        {desk.length > 0 && (
          <div className="relative w-full min-w-[640px] rounded-lg border-t-4 border-[#5b4636] bg-gradient-to-b from-[#3b2f26] to-[#241c16] px-8 pb-6 pt-5 shadow-2xl">
            <div className="mb-2 font-mono text-[9px] uppercase tracking-widest text-[#a08b78]">desk</div>
            <div className="flex flex-wrap justify-center gap-10">
              {desk.map((d) => (
                <Workstation key={d.id} device={d} active={active} onOpen={() => open(d.id)} focus={hop?.toDeviceId === d.id ? hop.color : undefined} />
              ))}
            </div>
          </div>
        )}
        {/* patch cables */}
        <svg className="pointer-events-none absolute left-0 top-0" width={size.w} height={size.h}>
          <defs>
            <filter id="glow">
              <feGaussianBlur stdDeviation="2.5" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          {cables.map((c) => (
            <g key={c.id}>
              <path d={c.d} fill="none" stroke="#000" strokeOpacity={0.45} strokeWidth={6} />
              <path d={c.d} fill="none" stroke={c.color} strokeWidth={3.5} strokeOpacity={c.up ? 0.95 : 0.35} strokeDasharray={c.up ? undefined : "6 5"} strokeLinecap="round" style={{ pointerEvents: "stroke" }}>
                <title>{c.title}</title>
              </path>
              {!hop && c.up && sent.has(c.a) && (
                <circle r="4.5" fill="#fde047" filter="url(#glow)">
                  <animateMotion dur="0.7s" repeatCount="1" path={c.d} />
                </circle>
              )}
              {!hop && c.up && sent.has(c.b) && (
                <circle r="4.5" fill="#fde047" filter="url(#glow)">
                  <animateMotion dur="0.7s" repeatCount="1" path={c.d} keyPoints="1;0" keyTimes="0;1" calcMode="linear" />
                </circle>
              )}
            </g>
          ))}
          {hop &&
            (() => {
              const c = cables.find((x) => (x.a === hop.fromIfaceId && x.b === hop.toIfaceId) || (x.b === hop.fromIfaceId && x.a === hop.toIfaceId));
              if (!c) return null;
              const forward = c.a === hop.fromIfaceId;
              return (
                <g key={`${hop.id}-${run}`} filter="url(#glow)">
                  <animateMotion dur={`${HOP_MS}ms`} fill="freeze" path={c.d} keyPoints={forward ? "0;1" : "1;0"} keyTimes="0;1" calcMode="linear" />
                  <rect x={-34} y={-10} width={68} height={20} rx={5} fill={hop.color} stroke="#fff" strokeOpacity={0.7} />
                  <text textAnchor="middle" y={4} fontSize="9.5" fontFamily="ui-monospace, monospace" fontWeight={700} fill="#06090d">
                    {hop.label}
                  </text>
                </g>
              );
            })()}
        </svg>
      </div>
    </div>
  );
}

/** A rack-mounted device: its real panel, scaled to fit the rack, with a U label. */
function RackUnit({ device, unit, active, onOpen, focus }: { device: Device; unit: number; active: Set<string>; onOpen(): void; focus?: string }) {
  const net = useLabStore((s) => s.network);
  const kind = chassisKind(device.type)!;
  const ports = useMemo(() => portViews(device, net), [device, net]);
  const { W, H } = UNIT[kind]!;
  const s = kind === "internet" ? RACK_SCALE * 0.9 : RACK_SCALE;
  const mgmt = device.interfaces.find((i) => i.management);
  const face: FaceProps = {
    device,
    ports,
    active,
    onSelect: onOpen,
    beacon: false,
    mgmt: mgmt ? { id: mgmt.id, up: mgmt.operState === "up", peer: peerOf(net, device, mgmt)?.deviceName, active: active.has(mgmt.id) } : undefined,
  };
  const up = ports.filter((p) => p.oper === "up").length;
  return (
    <div className="flex items-center gap-2">
      <div className="w-14 text-right font-mono text-[9px] leading-tight text-[#6b7789]">
        {kind === "internet" ? "shelf" : `U${unit}`}
        <div className="text-[10px] font-semibold text-[#c9d3de]">{device.name}</div>
      </div>
      <div data-dev={device.id} className="sw-box cursor-pointer transition hover:brightness-110" style={{ width: W * s, height: H * s, transformStyle: "flat", outline: focus ? `2px solid ${focus}` : undefined, outlineOffset: 3 }} onClick={onOpen} title={`${device.name} — ${up}/${ports.length} links up · click for the hardware view`}>
        <div style={{ width: W, height: H, transform: `scale(${s})`, transformOrigin: "top left" }}>
          {kind === "switch" ? (
            <SwitchFace {...face} oled={[device.name.toUpperCase(), "SONiC", `LINKS ${up}/${ports.length}`]} onOled={onOpen} />
          ) : kind === "router" ? (
            <RouterFace {...face} />
          ) : kind === "server" ? (
            <ServerRear {...face} />
          ) : (
            <InternetFace {...face} />
          )}
        </div>
      </div>
    </div>
  );
}

/** A PC on the desk: monitor showing its address, tower with power/drive LEDs and the NIC. */
function Workstation({ device, active, onOpen, focus }: { device: Device; active: Set<string>; onOpen(): void; focus?: string }) {
  const net = useLabStore((s) => s.network);
  const ports = useMemo(() => portViews(device, net), [device, net]);
  const busy = ports.some((p: PortView) => active.has(p.id));
  const ip = device.interfaces.flatMap((i) => i.ipv4.map((a) => `${a.address}/${a.prefix}`))[0] ?? "no IP";
  return (
    <div data-dev={device.id} className="flex cursor-pointer items-end gap-3 rounded-md" style={{ outline: focus ? `2px solid ${focus}` : undefined, outlineOffset: 4 }} onClick={onOpen} title={`${device.name} — click for the hardware view`}>
      {/* monitor */}
      <div className="flex flex-col items-center">
        <div className="rounded-md border-[6px] border-[#16181d] bg-[#0b0f16] shadow-xl" style={{ width: 170, height: 104 }}>
          <div className="h-full w-full bg-gradient-to-br from-[#0f2236] to-[#081019] p-2 font-mono text-[9px] leading-snug text-[#7dd3fc]">
            <div className="text-[10px] font-bold text-white">{device.name}</div>
            <div>{ip}</div>
            <div className="text-[#6ee7b7]">gw {device.config.defaultGateway ?? "—"}</div>
            <div className="text-[#64748b]">{busy ? "▮ traffic…" : "$ _"}</div>
          </div>
        </div>
        <div className="h-4 w-4 bg-[#16181d]" />
        <div className="h-1.5 w-20 rounded-full bg-[#16181d]" />
      </div>
      {/* tower */}
      <div className="relative flex flex-col items-center justify-between rounded-md border border-[#3a404b] bg-gradient-to-b from-[#2b3038] to-[#1a1d22] py-2 shadow-xl" style={{ width: 62, height: 128 }}>
        <div className="flex flex-col items-center gap-1">
          <span className="sw-sysled on-green" title="power" />
          <span className={`sw-sysled ${busy ? "on-amber" : ""}`} title="disk / activity" />
        </div>
        <div className="h-8 w-9 rounded-sm bg-[repeating-linear-gradient(180deg,#3a404b_0_2px,#1a1d22_2px_5px)]" />
        <div className="flex flex-col items-center gap-0.5">
          {ports.map((p) => (
            <div key={p.id} className="flex flex-col items-center" style={{ transform: "scale(0.85)" }}>
              <Port p={p} blinking={active.has(p.id)} selected={false} onClick={onOpen} />
              <span className="font-mono text-[7px] text-[#9aa4b2]">{p.name}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
