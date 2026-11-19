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
import { ChassisKind, chassisKind, peerOf, portViews, PortView, routeSummary } from "@/lib/switch3d/model";
import { PacketCaption, PacketOnPath, usePacketPlayer } from "./packetPlayer";
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
  /** Midpoint of the cable's curve (for the route step badge). */
  mid: { x: number; y: number };
}

/** Point at t=0.5 on a cubic Bézier. */
const bezMid = (p0: number[], p1: number[], p2: number[], p3: number[]) => ({ x: (p0[0] + 3 * p1[0] + 3 * p2[0] + p3[0]) / 8, y: (p0[1] + 3 * p1[1] + 3 * p2[1] + p3[1]) / 8 });

export function RealisticScene() {
  const net = useLabStore((s) => s.network);
  // Clicking selects the device (the Device panel on the right has "Open 3D hardware view").
  const select = useLabStore((s) => s.selectDevice);
  const { active, sent } = useActivity();

  // Packet animation (shared with the topology view): replay the last command hop by hop.
  const player = usePacketPlayer();
  const routeHops = player.index < 0 ? [] : player.hops.slice(0, Math.min(player.index + 1, player.hops.length));
  const nameOf = (id: string) => net.devices[id]?.name ?? "?";
  const route = routeSummary(routeHops, nameOf);
  const hop = player.hop;
  const devices = Object.values(net.devices).filter((d) => chassisKind(d.type));
  const kindOf = (d: Device) => chassisKind(d.type)!;
  const order: ChassisKind[] = ["internet", "router", "switch", "server"];
  // The learner can drag units to re-rack them / PCs along the desk (kept in the store).
  const sceneOrder = useLabStore((s) => s.sceneOrder);
  const setSceneOrder = useLabStore((s) => s.setSceneOrder);
  const rank = (d: Device) => {
    const i = sceneOrder.indexOf(d.id);
    return i < 0 ? 1e6 : i;
  };
  const rack = devices.filter((d) => kindOf(d) !== "pc").sort((a, b) => rank(a) - rank(b) || order.indexOf(kindOf(a)) - order.indexOf(kindOf(b)) || a.name.localeCompare(b.name));
  const desk = devices.filter((d) => kindOf(d) === "pc").sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  const dragId = useRef<string | null>(null);
  const dropOn = (targetId: string, group: Device[]) => {
    const from = dragId.current;
    dragId.current = null;
    if (!from || from === targetId || !group.some((d) => d.id === from)) return;
    const ids = group.map((d) => d.id).filter((id) => id !== from);
    ids.splice(ids.indexOf(targetId), 0, from);
    const others = [...rack, ...desk].map((d) => d.id).filter((id) => !ids.includes(id) && id !== from);
    setSceneOrder([...ids, ...others]);
  };
  const dragProps = (id: string, group: Device[]) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      dragId.current = id;
      e.dataTransfer.effectAllowed = "move";
    },
    onDragOver: (e: React.DragEvent) => e.preventDefault(),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      dropOn(id, group);
    },
  });

  // Pan (drag the background) and zoom (wheel / buttons) the whole scene.
  const viewport = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, z: 1 });
  const zoomRef = useRef(1);
  zoomRef.current = view.z;
  const panning = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const fit = () => {
    const vp = viewport.current;
    const content = wrap.current;
    if (!vp || !content) return;
    const z = Math.max(0.25, Math.min(1, (vp.clientWidth - 24) / content.scrollWidth, (vp.clientHeight - 24) / content.scrollHeight));
    setView({ z, x: (vp.clientWidth - content.scrollWidth * z) / 2, y: 12 });
  };
  const zoomAt = (factor: number, cx?: number, cy?: number) =>
    setView((v) => {
      const z = Math.max(0.25, Math.min(2.5, v.z * factor));
      const vp = viewport.current;
      const px = cx ?? (vp ? vp.clientWidth / 2 : 0);
      const py = cy ?? (vp ? vp.clientHeight / 2 : 0);
      return { z, x: px - ((px - v.x) * z) / v.z, y: py - ((py - v.y) * z) / v.z };
    });

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
        // in the scene's own (unzoomed) coordinates, so cables stay put while zooming
        const z = zoomRef.current;
        return { x: (r.left - box.left + r.width / 2) / z, y: (r.top - box.top + r.height / 2) / z, inRack: !!rackBox && r.left >= rackBox.left && r.right <= rackBox.right && r.top >= rackBox.top && r.bottom <= rackBox.bottom };
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
        let p1: number[];
        let p2: number[];
        if (a.inRack && b.inRack && rackBox) {
          // rack-to-rack patch: out to the side cable manager and back in
          const side = (rackBox.right - box.left) / zoomRef.current + 18 + (idx % 6) * 9;
          [p1, p2] = [[side, a.y], [side, b.y]];
        } else {
          // drop from the rack down to the desk with a natural sag
          const sag = Math.max(60, Math.abs(b.y - a.y) * 0.5) * (a.y < b.y ? 1 : -1);
          [p1, p2] = [[a.x, a.y + sag], [b.x, b.y - sag]];
        }
        const d = `M ${a.x} ${a.y} C ${p1[0]} ${p1[1]}, ${p2[0]} ${p2[1]}, ${b.x} ${b.y}`;
        const up = ia.operState === "up" && ib.operState === "up";
        out.push({
          id: c.id,
          d,
          color: cableTone(da.type, db.type),
          up,
          title: `${da.name} ${ia.name} ↔ ${db.name} ${ib.name} · ${up ? `up ${ia.speed >= 1000 ? `${ia.speed / 1000}G` : `${ia.speed}M`}` : "down"}`,
          a: ia.id,
          b: ib.id,
          mid: bezMid([a.x, a.y], p1, p2, [b.x, b.y]),
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
  }, [net.connections.length, devices.length, sceneOrder]);

  // Fit the scene when it opens and whenever devices are added or removed.
  useEffect(() => {
    const t = setTimeout(fit, 50);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devices.length]);

  if (!devices.length) {
    return <div className="flex h-full items-center justify-center text-sm text-[#6b7789]">Load a lab to see it as real hardware.</div>;
  }

  return (
    <div
      ref={viewport}
      className="relative h-full w-full cursor-grab overflow-hidden bg-[radial-gradient(circle_at_50%_0%,#1b2433_0%,#0b0e13_60%)] active:cursor-grabbing"
      onWheel={(e) => {
        const r = viewport.current!.getBoundingClientRect();
        zoomAt(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - r.left, e.clientY - r.top);
      }}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest("[data-dev],button,[data-overlay]")) return;
        panning.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const p = panning.current;
        if (p) setView((v) => ({ ...v, x: p.vx + e.clientX - p.x, y: p.vy + e.clientY - p.y }));
      }}
      onPointerUp={() => (panning.current = null)}
    >
      <style>{CSS}</style>
      {/* zoom controls */}
      <div data-overlay className="absolute bottom-3 right-3 z-30 flex items-center overflow-hidden rounded border border-edge bg-panel/90 text-[12px] shadow">
        <button onClick={() => zoomAt(1 / 1.2)} className="px-2 py-1 text-[#c9d3de] hover:text-accent-2" title="Zoom out">
          −
        </button>
        <span className="w-12 text-center font-mono text-[10px] text-[#8b98a5]">{Math.round(view.z * 100)}%</span>
        <button onClick={() => zoomAt(1.2)} className="px-2 py-1 text-[#c9d3de] hover:text-accent-2" title="Zoom in">
          +
        </button>
        <button onClick={fit} className="border-l border-edge px-2 py-1 text-[11px] text-[#c9d3de] hover:text-accent-2" title="Fit everything">
          Fit
        </button>
      </div>
      <div data-overlay className="absolute bottom-3 left-3 z-30 rounded border border-edge bg-panel/80 px-2 py-1 text-[10px] text-[#8b98a5]">
        drag background to pan · scroll to zoom · drag a unit / PC to rearrange · click to select
      </div>
      <div data-overlay className="absolute left-1/2 top-12 z-30 w-[min(820px,92%)] -translate-x-1/2">
          <PacketCaption p={player} idleHint="Run ping (or traceroute) in the terminal to watch the packets travel and the route light up. Click a device to select it." />
          {route.length > 0 && (
            <div className="mt-1.5 rounded-md border border-edge bg-panel/90 px-3 py-1.5 text-[11px] shadow">
              <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#5f6b7a]">Route (numbers on the cables = order of first use)</div>
              {route.map((r) => (
                <div key={r.label} className="flex gap-2">
                  <span className="w-24 shrink-0 font-semibold" style={{ color: r.color }}>
                    {r.label}
                  </span>
                  <span className="font-mono text-[#c9d3de]">{r.paths.join("  ·  ")}</span>
                </div>
              ))}
            </div>
          )}
      </div>
      <div className="absolute left-0 top-0 origin-top-left" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}>
      <div ref={wrap} className="relative flex min-w-max flex-col items-center gap-6 px-10 pb-10 pt-28">
        {/* rack */}
        <div ref={rackRef} className="relative flex flex-col items-center rounded-md border border-[#1f2633] bg-[#090b0f] px-7 pb-4 pt-3 shadow-2xl">
          <div className="absolute inset-y-2 left-2 w-3 rounded-sm bg-[repeating-linear-gradient(180deg,#2a313d_0_6px,#0a0c10_6px_10px)]" />
          <div className="absolute inset-y-2 right-2 w-3 rounded-sm bg-[repeating-linear-gradient(180deg,#2a313d_0_6px,#0a0c10_6px_10px)]" />
          <div className="mb-2 font-mono text-[9px] uppercase tracking-widest text-[#4b5563]">19&quot; rack</div>
          <div className="flex flex-col gap-2.5">
            {rack.map((d, i) => (
              <div key={d.id} {...dragProps(d.id, rack)} title="Drag to re-rack">
              <RackUnit device={d} unit={i + 1} active={active} onOpen={() => select(d.id)} focus={hop?.toDeviceId === d.id ? hop.color : undefined} />
              </div>
            ))}
          </div>
        </div>
        {/* desk */}
        {desk.length > 0 && (
          <div className="relative w-full min-w-[640px] rounded-lg border-t-4 border-[#5b4636] bg-gradient-to-b from-[#3b2f26] to-[#241c16] px-8 pb-6 pt-5 shadow-2xl">
            <div className="mb-2 font-mono text-[9px] uppercase tracking-widest text-[#a08b78]">desk</div>
            <div className="flex flex-wrap justify-center gap-10">
              {desk.map((d) => (
                <div key={d.id} {...dragProps(d.id, desk)}>
                <Workstation device={d} active={active} onOpen={() => select(d.id)} focus={hop?.toDeviceId === d.id ? hop.color : undefined} />
                </div>
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
          {cables.map((c) => {
            // Has the current command used this cable yet? which way(s), first step, colour
            const used = routeHops
              .map((h, i) => ({ h, i }))
              .filter(({ h }) => (h.fromIfaceId === c.a && h.toIfaceId === c.b) || (h.fromIfaceId === c.b && h.toIfaceId === c.a));
            const dim = routeHops.length > 0 && used.length === 0;
            const fwd = used.filter(({ h }) => h.fromIfaceId === c.a);
            const rev = used.filter(({ h }) => h.fromIfaceId === c.b);
            return (
            <g key={c.id} opacity={dim ? 0.25 : 1}>
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
              {/* route: arrows marching in the direction frames flowed (both ways = both arrows) */}
              {fwd.length > 0 && <path d={c.d} fill="none" stroke={fwd[fwd.length - 1].h.color} strokeWidth={2.5} className="flow-fwd" />}
              {rev.length > 0 && <path d={c.d} fill="none" stroke={rev[rev.length - 1].h.color} strokeWidth={2.5} className="flow-rev" />}
              {used.length > 0 && (
                <g transform={`translate(${c.mid.x} ${c.mid.y})`}>
                  <circle r="9" fill="#0b0e13" stroke={used[0].h.color} strokeWidth={1.5} />
                  <text textAnchor="middle" y="3.5" fontSize="9" fontWeight={700} fill="#e6edf3" fontFamily="ui-monospace, monospace">
                    {used[0].i + 1}
                  </text>
                </g>
              )}
            </g>
            );
          })}
          {hop &&
            (() => {
              const c = cables.find((x) => (x.a === hop.fromIfaceId && x.b === hop.toIfaceId) || (x.b === hop.fromIfaceId && x.a === hop.toIfaceId));
              if (!c) return null;
              return <PacketOnPath hop={hop} path={c.d} forward={c.a === hop.fromIfaceId} ms={player.hopMs} animKey={`${hop.id}-${player.run}`} />;
            })()}
        </svg>
      </div>
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
      <div data-dev={device.id} className="sw-box cursor-pointer transition hover:brightness-110" style={{ width: W * s, height: H * s, transformStyle: "flat", outline: focus ? `2px solid ${focus}` : undefined, outlineOffset: 3 }} onClick={onOpen} title={`${device.name} — ${up}/${ports.length} links up · click to select it`}>
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
    <div data-dev={device.id} className="flex cursor-pointer items-end gap-3 rounded-md" style={{ outline: focus ? `2px solid ${focus}` : undefined, outlineOffset: 4 }} onClick={onOpen} title={`${device.name} — click to select it`}>
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
