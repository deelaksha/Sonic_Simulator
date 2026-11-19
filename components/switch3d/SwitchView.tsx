"use client";
/**
 * 3D switch view: a 1U chassis rendered as a CSS 3D box (drag to rotate).
 *   front face  faceplate — real ports, link/activity LEDs, cables to real peers,
 *               OLED status, system LEDs, management + console ports
 *   top face    "lid off" internals — front ports traced to the switching ASIC,
 *               ASIC ↔ CPU over PCIe (hostif traps), mgmt port on the CPU's NIC;
 *               dots move along a trace whenever that path's real counters change
 * Below: inspector for the selected port and the CPU / control plane.
 * All data comes from the live simulated device (lib/switch3d/model.ts).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLabStore } from "@/lib/store/lab-store";
import { activityOf, cpuView, fmtBps, peerOf, portViews, PortView, recentFrames } from "@/lib/switch3d/model";
import { Device } from "@/lib/models/device";

const W = 980; // chassis width incl. rack ears (px)
const H = 118; // 1U faceplate height
const D = 440; // depth

type ViewPreset = "front" | "angled" | "lid";
const PRESETS: Record<ViewPreset, { rx: number; ry: number }> = {
  front: { rx: 0, ry: 0 },
  angled: { rx: 14, ry: -18 },
  lid: { rx: 58, ry: 0 },
};

const CABLE: Record<string, string> = { switch: "#22d3ee", router: "#eab308", internet: "#dc2626" };
const cableColor = (peerType?: string, kind?: string) => (peerType ? CABLE[peerType] ?? (kind === "sfp" ? "#2563eb" : "#2563eb") : "#64748b");

function shade(hex: string, pct: number): string {
  const n = parseInt(hex.slice(1), 16);
  const a = Math.round(2.55 * pct);
  const c = (v: number) => Math.min(255, Math.max(0, v + a));
  return `#${((1 << 24) + (c(n >> 16) << 16) + (c((n >> 8) & 255) << 8) + c(n & 255)).toString(16).slice(1)}`;
}

/** Short mechanical latch click (Web Audio); silently skipped if audio is blocked. */
let audio: AudioContext | null = null;
function click(plug: boolean) {
  try {
    audio ??= new AudioContext();
    const t = audio.currentTime;
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = "triangle";
    o.frequency.setValueAtTime(plug ? 1150 : 720, t);
    o.frequency.exponentialRampToValueAtTime(plug ? 260 : 190, t + 0.032);
    g.gain.setValueAtTime(0.12, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.038);
    o.connect(g).connect(audio.destination);
    o.start(t);
    o.stop(t + 0.04);
  } catch {
    /* no audio */
  }
}

export function SwitchView() {
  const id = useLabStore((s) => s.switchViewId);
  const device = useLabStore((s) => (s.switchViewId ? s.network.devices[s.switchViewId] : undefined));
  const close = useLabStore((s) => s.closeSwitchView);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);
  if (!id || !device) return null;
  return <SwitchStage device={device} onClose={close} />;
}

function SwitchStage({ device, onClose }: { device: Device; onClose: () => void }) {
  const net = useLabStore((s) => s.network);
  const captures = useLabStore((s) => s.captures);
  const ports = useMemo(() => portViews(device, net), [device, net]);
  const cpu = useMemo(() => cpuView(device), [device]);
  const mgmt = device.interfaces.find((i) => i.management);
  const [sel, setSel] = useState<string | undefined>(() => (ports.find((p) => p.peer) ?? ports[0])?.id);
  const selected = ports.find((p) => p.id === sel);

  const [rot, setRot] = useState(PRESETS.angled);
  const [lidOff, setLidOff] = useState(false);
  const [silver, setSilver] = useState(false);
  const [dark, setDark] = useState(false);
  const [sound, setSound] = useState(true);
  const [beacon, setBeacon] = useState(false);
  const [oledPage, setOledPage] = useState(0);
  const preset = (p: ViewPreset) => {
    setRot(PRESETS[p]);
    setLidOff(p === "lid");
  };

  // Activity: a port's LED blinks (and a dot runs along its trace) when its frame
  // counters moved since the last 150 ms tick; the PCIe trace when the CPU trapped more.
  const last = useRef<Record<string, number>>({});
  const lastCpu = useRef(cpu.totalTrapped);
  const [active, setActive] = useState<Set<string>>(new Set());
  const [cpuActive, setCpuActive] = useState(false);
  useEffect(() => {
    const t = setInterval(() => {
      const d = useLabStore.getState().network.devices[device.id];
      if (!d) return;
      const next = new Set<string>();
      for (const i of d.interfaces) {
        const n = activityOf(i.statistics);
        if (last.current[i.id] !== undefined && n !== last.current[i.id]) next.add(i.id);
        last.current[i.id] = n;
      }
      setActive(next);
      const trapped = cpuView(d).totalTrapped;
      setCpuActive(trapped !== lastCpu.current);
      lastCpu.current = trapped;
    }, 150);
    return () => clearInterval(t);
  }, [device.id]);

  // Drag to rotate.
  const drag = useRef<{ x: number; y: number; rx: number; ry: number } | null>(null);
  const onDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("[data-port]")) return;
    drag.current = { x: e.clientX, y: e.clientY, ...rot };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const g = drag.current;
    if (!g) return;
    const rx = Math.max(-12, Math.min(80, g.rx - (e.clientY - g.y) * 0.3));
    const ry = Math.max(-45, Math.min(45, g.ry + (e.clientX - g.x) * 0.3));
    setRot({ rx, ry });
    setLidOff(rx > 35);
  };
  const onUp = () => (drag.current = null);

  // Fit the fixed-size chassis to the stage width.
  const stageRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScale(Math.min(1, (el.clientWidth - 32) / W)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const linksUp = ports.filter((p) => p.oper === "up").length;
  const mgmtIp = mgmt?.ipv4[0]?.address ?? "—";

  return (
    <div className={`absolute inset-0 z-40 flex flex-col ${dark ? "bg-[#030406]" : "bg-[#0b0d11]"}`} role="dialog" aria-label={`${device.name} switch view`}>
      <style>{CSS}</style>
      {/* header */}
      <div className="flex flex-wrap items-center gap-2 border-b border-edge px-4 py-2">
        <div className="mr-auto">
          <div className="text-sm font-semibold text-[#e6edf3]">
            {device.name} <span className="ml-1 rounded bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[10px] text-emerald-400">{linksUp}/{ports.length} links up</span>
          </div>
          <div className="text-[11px] text-[#6b7789]">Live view of the simulated switch — drag to rotate, click a port to inspect it.</div>
        </div>
        <Seg value={lidOff ? "lid" : rot.rx === 0 && rot.ry === 0 ? "front" : "angled"} options={[["front", "Front"], ["angled", "Angled"], ["lid", "Lid off (internals)"]]} onChange={(v) => preset(v as ViewPreset)} />
        <Btn onClick={() => setSilver(!silver)}>{silver ? "Silver" : "Gunmetal"}</Btn>
        <Btn onClick={() => setDark(!dark)}>{dark ? "Dark rack" : "Studio light"}</Btn>
        <Btn onClick={() => setBeacon(!beacon)} title="Blink the blue locator LED, as `sudo locator-led` would on a real switch">
          {beacon ? "Locator on" : "Locator"}
        </Btn>
        <Btn onClick={() => setSound(!sound)} title="Cable click sounds">{sound ? "🔊" : "🔇"}</Btn>
        <Btn onClick={onClose} title="Close (Esc)">✕</Btn>
      </div>

      {/* 3D stage */}
      <div
        ref={stageRef}
        className="sw-stage relative flex shrink-0 cursor-grab items-center justify-center overflow-hidden active:cursor-grabbing"
        style={{ height: Math.max(260, (lidOff ? 470 : 300) * scale) }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
      >
        <div style={{ transform: `scale(${scale})`, perspective: 1600 }}>
          <div
            className={`sw-box ${silver ? "sw-silver" : ""} ${dark ? "sw-dark" : ""}`}
            style={{ width: W, height: H, transform: `rotateX(${-rot.rx}deg) rotateY(${rot.ry}deg)` }}
          >
            <div className="sw-face sw-front" style={{ width: W, height: H, transform: `translateZ(${D / 2}px)` }}>
              <Faceplate
                device={device}
                ports={ports}
                active={active}
                sel={sel}
                onSelect={setSel}
                beacon={beacon}
                oled={oledLines(oledPage, device.name, mgmtIp, linksUp, ports.length, cpu.totalTrapped)}
                onOled={() => setOledPage((oledPage + 1) % 3)}
                mgmtUp={mgmt?.operState === "up"}
                mgmtPeer={mgmt ? peerOf(net, device, mgmt)?.deviceName : undefined}
                mgmtActive={!!mgmt && active.has(mgmt.id)}
              />
            </div>
            <div className="sw-face sw-top" style={{ width: W, height: D, top: (H - D) / 2, transform: `rotateX(90deg) translateZ(${H / 2}px)` }}>
              {lidOff ? <Internals ports={ports} active={active} cpuActive={cpuActive} cpu={cpu} mgmtActive={!!mgmt && active.has(mgmt.id)} sel={sel} /> : <div className="sw-lid" />}
            </div>
            <div className="sw-face sw-side" style={{ width: D, height: H, left: (W - D) / 2, transform: `rotateY(90deg) translateZ(${W / 2}px)` }} />
            <div className="sw-face sw-side" style={{ width: D, height: H, left: (W - D) / 2, transform: `rotateY(-90deg) translateZ(${W / 2}px)` }} />
            <div className="sw-face sw-bottom" style={{ width: W, height: D, top: (H - D) / 2, transform: `rotateX(-90deg) translateZ(${H / 2}px)` }} />
          </div>
        </div>
      </div>

      {/* inspectors */}
      <div className="grid flex-1 grid-cols-1 gap-3 overflow-y-auto p-3 lg:grid-cols-12">
        <div className="lg:col-span-7">{selected ? <PortInspector device={device} port={selected} captures={captures} sound={sound} /> : null}</div>
        <div className="lg:col-span-5">
          <CpuPanel cpu={cpu} />
        </div>
      </div>
    </div>
  );
}

function oledLines(page: number, host: string, mgmtIp: string, up: number, total: number, trapped: number): [string, string, string] {
  if (page === 1) return ["MGMT eth0", mgmtIp, `LINKS ${up}/${total}`];
  if (page === 2) return ["CPU (hostif)", `${trapped} pkts`, "trapped total"];
  return [host.toUpperCase(), "SONiC", `LINKS ${up}/${total}`];
}

/* ---------------------------------------------------------------- faceplate */

function Faceplate(props: {
  device: Device;
  ports: PortView[];
  active: Set<string>;
  sel?: string;
  onSelect(id: string): void;
  beacon: boolean;
  oled: [string, string, string];
  onOled(): void;
  mgmtUp: boolean;
  mgmtPeer?: string;
  mgmtActive: boolean;
}) {
  const { ports } = props;
  // Two rows: odd labels on top, even below (as on real 1U switches); banks of 6 columns.
  const cols: PortView[][] = [];
  for (let i = 0; i < ports.length; i += 2) cols.push(ports.slice(i, i + 2));
  const banks: PortView[][][] = [];
  for (let i = 0; i < cols.length; i += 6) banks.push(cols.slice(i, i + 6));
  return (
    <div className="flex h-full items-stretch">
      <Ear />
      <div className="sw-chassis flex flex-1 items-center gap-3 px-3">
        <button className="sw-oled-bezel shrink-0" onClick={props.onOled} title="Click to cycle the status display">
          <div className="sw-oled">
            <div className="text-[8px] font-bold text-sky-400">{props.oled[0]}</div>
            <div className="my-auto text-[11px] font-bold text-white">{props.oled[1]}</div>
            <div className="text-[8px] text-emerald-400">{props.oled[2]}</div>
          </div>
        </button>
        <div className="flex h-[88px] shrink-0 flex-col justify-between border-r border-black/25 pr-3">
          <div>
            <div className="sw-silk text-[12px] font-bold tracking-wider">{props.device.name}</div>
            <div className="sw-silk-sub font-mono text-[8px] uppercase">SONiC · simulated 1U</div>
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1">
            <SysLed label="PSU" on="green" />
            <SysLed label="SYS" on="green" />
            <SysLed label="FAN" on="green" />
            <SysLed label="LOC" on={props.beacon ? "blue" : undefined} blink={props.beacon} />
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-center gap-1 border-r border-black/25 pr-3">
          <span className="sw-silk-sub font-mono text-[7.5px] uppercase">MGMT</span>
          <div className="sw-rj45 sw-mgmt" title={`eth0 (management, the CPU's own NIC) — ${props.mgmtUp ? "link up" : "no link"}${props.mgmtPeer ? ` · cabled to ${props.mgmtPeer}` : ""}`}>
            <span className={`sw-pled sw-pled-l ${props.mgmtUp && !props.mgmtActive ? "on-amber" : ""}`} />
            <div className="sw-rj45-cavity" />
            {props.mgmtPeer && (
              <div className="sw-plug">
                <div className="sw-plug-body">
                  <div className="sw-boot" style={{ background: "linear-gradient(145deg, #64748b, #334155)" }} />
                </div>
              </div>
            )}
          </div>
          <span className="sw-silk-sub font-mono text-[7.5px] uppercase">CONSOLE</span>
          <div className="sw-rj45 sw-console" title="RS-232 console (the terminal panel below is this console)">
            <div className="sw-rj45-cavity" />
          </div>
        </div>
        <div className="flex flex-1 items-center justify-center gap-3">
          {banks.map((bank, bi) => (
            <div key={bi} className="sw-bank flex gap-1.5 rounded p-1.5">
              {bank.map((col, ci) => (
                <div key={ci} className="flex flex-col items-center gap-1">
                  <span className="sw-silk-sub font-mono text-[7.5px]">{col[0].label}</span>
                  {col.map((p, ri) => (
                    <Port key={p.id} p={p} bottom={ri === 1} blinking={props.active.has(p.id)} selected={props.sel === p.id} onClick={() => props.onSelect(p.id)} />
                  ))}
                  {col[1] && <span className="sw-silk-sub font-mono text-[7.5px]">{col[1].label}</span>}
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="sw-vent h-[86px] w-7 shrink-0 rounded-sm" title="Airflow intake" />
      </div>
      <Ear />
    </div>
  );
}

function Ear() {
  return (
    <div className="sw-ear flex w-8 shrink-0 flex-col items-center justify-between py-3">
      <div className="sw-slot" />
      <div className="sw-screw" />
      <div className="sw-screw" />
      <div className="sw-slot" />
    </div>
  );
}

function SysLed({ label, on, blink }: { label: string; on?: "green" | "blue"; blink?: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`sw-sysled ${on ? `on-${on}` : ""} ${blink ? "sw-blink" : ""}`} />
      <span className="sw-silk-sub font-mono text-[8px] font-semibold">{label}</span>
    </div>
  );
}

function Port({ p, bottom, blinking, selected, onClick }: { p: PortView; bottom: boolean; blinking: boolean; selected: boolean; onClick(): void }) {
  const c = cableColor(p.peer?.deviceType, p.kind);
  const tip = `${p.name} (port ${p.label}, ${p.speedLabel}) — ${p.admin === "down" ? "admin down" : p.oper === "up" ? "link up" : "no link"}${p.peer ? ` · cabled to ${p.peer.deviceName} ${p.peer.ifName}` : " · empty"}`;
  // Activity: the link LED goes dark for one tick when frames moved (bursty blink).
  const led = p.led !== "off" && !blinking ? `on-${p.led}` : "";
  return (
    <button data-port className={`${p.kind === "sfp" ? "sw-sfp" : "sw-rj45"} ${bottom ? "sw-inv" : ""} ${selected ? "sw-sel" : ""}`} onClick={onClick} title={tip}>
      <span className={`sw-pled sw-pled-l ${led}`} />
      {p.admin === "down" && <span className="sw-pled sw-pled-r on-amber" title="administratively down" />}
      <div className={p.kind === "sfp" ? "sw-sfp-cavity" : "sw-rj45-cavity"}>
        {p.kind === "sfp" && !p.peer && <div className="sw-sfp-rail" />}
      </div>
      {p.peer &&
        (p.kind === "sfp" ? (
          <div className="sw-sfp-module">
            <div className="flex gap-[3px]">
              <span className="sw-lc" style={{ background: `linear-gradient(145deg, ${c}, ${shade(c, -30)})` }} />
              <span className="sw-lc" style={{ background: `linear-gradient(145deg, ${c}, ${shade(c, -30)})` }} />
            </div>
            <span className="sw-bail" />
            <span className={`sw-tail ${bottom ? "down" : "up"}`} style={{ background: `linear-gradient(90deg, ${shade(c, -25)}, ${c} 45%, ${shade(c, -35)})` }} />
          </div>
        ) : (
          <div className="sw-plug">
            <div className="sw-plug-body">
              <div className="sw-boot" style={{ background: `linear-gradient(145deg, ${c}, ${shade(c, -35)})` }} />
            </div>
            <span className={`sw-tail ${bottom ? "down" : "up"}`} style={{ background: `linear-gradient(90deg, ${shade(c, -25)}, ${c} 45%, ${shade(c, -35)})` }} />
          </div>
        ))}
    </button>
  );
}

/* ---------------------------------------------------------------- internals (lid off) */

function Internals({ ports, active, cpuActive, cpu, mgmtActive, sel }: { ports: PortView[]; active: Set<string>; cpuActive: boolean; cpu: ReturnType<typeof cpuView>; mgmtActive: boolean; sel?: string }) {
  // Coordinates on the W×D board: front edge (y = D) faces the viewer in "lid" view.
  const x0 = 330;
  const x1 = W - 70;
  const step = ports.length > 1 ? (x1 - x0) / (ports.length - 1) : 0;
  const px = (i: number) => (ports.length > 1 ? x0 + i * step : (x0 + x1) / 2);
  const asic = { x: 560, y: 200, w: 210, h: 110 };
  const cpuBox = { x: 120, y: 70, w: 170, h: 96 };
  const mgmtX = 205;
  const trace = (i: number) => `M ${px(i)} ${D - 20} C ${px(i)} ${D - 90}, ${asic.x + asic.w / 2} ${asic.y + asic.h + 60}, ${asic.x + asic.w / 2} ${asic.y + asic.h}`;
  const pcie = `M ${asic.x} ${asic.y + 40} C ${asic.x - 120} ${asic.y + 40}, ${cpuBox.x + cpuBox.w + 80} ${cpuBox.y + 50}, ${cpuBox.x + cpuBox.w} ${cpuBox.y + 50}`;
  const mgmtPath = `M ${mgmtX} ${D - 20} L ${mgmtX} ${cpuBox.y + cpuBox.h}`;
  return (
    <svg width={W} height={D} viewBox={`0 0 ${W} ${D}`} className="sw-pcb">
      <defs>
        <linearGradient id="pcb" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#0b3b2c" />
          <stop offset="1" stopColor="#06261c" />
        </linearGradient>
      </defs>
      <rect x="6" y="6" width={W - 12} height={D - 12} rx="6" fill="url(#pcb)" stroke="#1d5a45" />
      {/* fans and PSUs at the rear (y ≈ 0) */}
      {[0, 1, 2, 3].map((i) => (
        <g key={i} transform={`translate(${380 + i * 92} 40)`}>
          <circle r="30" fill="#111418" stroke="#2c323b" />
          <g className="sw-fan">
            {[0, 72, 144, 216, 288].map((a) => (
              <path key={a} d="M0 0 C 8 -10, 22 -14, 26 -4 Z" fill="#3b4250" transform={`rotate(${a})`} />
            ))}
          </g>
          <text y="46" textAnchor="middle" className="sw-t">FAN {i + 1}</text>
        </g>
      ))}
      {[0, 1].map((i) => (
        <g key={i}>
          <rect x={W - 150} y={20 + i * 70} width="120" height="58" rx="4" fill="#1a1d23" stroke="#3a414d" />
          <text x={W - 90} y={54 + i * 70} textAnchor="middle" className="sw-t">PSU {i + 1} · OK</text>
        </g>
      ))}
      {/* traces: front ports → ASIC */}
      {ports.map((p, i) => (
        <g key={p.id}>
          <path d={trace(i)} className={`sw-trace ${p.oper === "up" ? "up" : ""} ${sel === p.id ? "sel" : ""}`} />
          {active.has(p.id) && (
            <circle r="4" className="sw-dot">
              <animateMotion dur="0.6s" repeatCount="1" path={trace(i)} keyPoints={i % 2 ? "0;1" : "1;0"} keyTimes="0;1" />
            </circle>
          )}
          <rect x={px(i) - 13} y={D - 22} width="26" height="16" rx="2" fill={p.oper === "up" ? "#94a3b8" : "#4b5563"} />
          <text x={px(i)} y={D - 28} textAnchor="middle" className="sw-t">{p.label}</text>
          <text x={px(i)} y={D - 38} textAnchor="middle" className="sw-t dim">{p.rate?.rxBps !== undefined ? fmtBps((p.rate.rxBps ?? 0) + (p.rate.txBps ?? 0)) : ""}</text>
        </g>
      ))}
      {/* ASIC */}
      <rect x={asic.x} y={asic.y} width={asic.w} height={asic.h} rx="6" fill="#1b1f27" stroke="#38bdf8" strokeWidth="1.5" />
      <text x={asic.x + asic.w / 2} y={asic.y + 20} textAnchor="middle" className="sw-t big">Switching ASIC (data plane)</text>
      {["parse → L2 FDB / L3 LPM lookup", "ACL → QoS queues → egress", "transit traffic never leaves the ASIC"].map((l, i) => (
        <text key={i} x={asic.x + asic.w / 2} y={asic.y + 44 + i * 18} textAnchor="middle" className="sw-t">{l}</text>
      ))}
      {/* ASIC → CPU over PCIe */}
      <path d={pcie} className={`sw-trace pcie ${cpuActive ? "hot" : ""}`} />
      {cpuActive && (
        <circle r="4.5" className="sw-dot cpu">
          <animateMotion dur="0.7s" repeatCount="1" path={pcie} />
        </circle>
      )}
      <text x={(asic.x + cpuBox.x + cpuBox.w) / 2} y={asic.y + 22} textAnchor="middle" className="sw-t">PCIe · hostif traps (CoPP)</text>
      {/* CPU + DRAM */}
      <rect x={cpuBox.x} y={cpuBox.y} width={cpuBox.w} height={cpuBox.h} rx="6" fill="#1b1f27" stroke="#a78bfa" strokeWidth="1.5" />
      <text x={cpuBox.x + cpuBox.w / 2} y={cpuBox.y + 20} textAnchor="middle" className="sw-t big">CPU (control plane)</text>
      <text x={cpuBox.x + cpuBox.w / 2} y={cpuBox.y + 40} textAnchor="middle" className="sw-t">SONiC Linux + containers</text>
      <text x={cpuBox.x + cpuBox.w / 2} y={cpuBox.y + 60} textAnchor="middle" className="sw-t">trapped {cpu.totalTrapped} · policed {cpu.totalPoliced}</text>
      <text x={cpuBox.x + cpuBox.w / 2} y={cpuBox.y + 80} textAnchor="middle" className="sw-t dim">{cpu.containers.filter((c) => c.state.includes("enabled")).length} containers running</text>
      {[0, 1].map((i) => (
        <rect key={i} x={cpuBox.x + 10 + i * 80} y={cpuBox.y + cpuBox.h + 16} width="70" height="14" rx="2" fill="#2a2f38" stroke="#475161" />
      ))}
      <text x={cpuBox.x + cpuBox.w / 2} y={cpuBox.y + cpuBox.h + 48} textAnchor="middle" className="sw-t dim">DRAM</text>
      {/* management port is the CPU's own NIC (eth0), not an ASIC port */}
      <path d={mgmtPath} className={`sw-trace mgmt ${mgmtActive ? "hot" : ""}`} />
      {mgmtActive && (
        <circle r="4" className="sw-dot cpu">
          <animateMotion dur="0.6s" repeatCount="1" path={mgmtPath} />
        </circle>
      )}
      <rect x={mgmtX - 13} y={D - 22} width="26" height="16" rx="2" fill="#94a3b8" />
      <text x={mgmtX} y={D - 28} textAnchor="middle" className="sw-t">eth0 (mgmt → CPU)</text>
    </svg>
  );
}

/* ---------------------------------------------------------------- inspectors */

function PortInspector({ device, port: p, captures, sound }: { device: Device; port: PortView; captures: ReturnType<typeof useLabStore.getState>["captures"]; sound: boolean }) {
  const runCliScript = useLabStore((s) => s.runCliScript);
  const disconnect = useLabStore((s) => s.disconnect);
  const frames = recentFrames(captures, device.id, p.id);
  const shut = useCallback(
    (down: boolean) => {
      if (sound) click(!down);
      // Applied through KLISH, so the learner sees the real commands in the terminal.
      runCliScript(device.id, ["configure terminal", `interface Ethernet ${p.name.replace(/^Ethernet/, "")}`, down ? "shutdown" : "no shutdown", "end"]);
    },
    [device.id, p.name, runCliScript, sound],
  );
  const status = p.admin === "down" ? ["ADMIN DOWN", "bg-amber-500/15 text-amber-300 border-amber-500/30"] : p.oper === "up" ? [`LINK UP · ${p.speedLabel}`, "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"] : ["NO LINK", "bg-slate-800 text-slate-400 border-slate-700"];
  const drops = Object.entries(p.drops);
  return (
    <div className="rounded-xl border border-edge bg-panel-2 p-3">
      <div className="flex flex-wrap items-center gap-2 border-b border-edge pb-2">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-sky-500/30 bg-sky-500/15 font-mono text-sm font-bold text-sky-400">{String(p.label).padStart(2, "0")}</div>
        <div className="mr-auto">
          <div className="text-[13px] font-semibold text-[#e6edf3]">
            {p.name} <span className="font-normal text-[#6b7789]">· {p.kind === "sfp" ? `SFP cage (${p.speedLabel})` : `RJ45 (${p.speedLabel})`}</span>
          </div>
          <div className="text-[11px] text-[#8b98a5]">{p.peer ? `Cable to ${p.peer.deviceName} ${p.peer.ifName} (${p.peer.deviceType})` : "Nothing plugged in"}</div>
        </div>
        <span className={`rounded-full border px-2 py-0.5 font-mono text-[10.5px] font-semibold ${status[1]}`}>{status[0]}</span>
        <button onClick={() => shut(p.admin === "up")} className="rounded border border-edge px-2 py-1 text-[11px] text-[#c9d3de] hover:border-accent-2 hover:text-accent-2" title="Applied with KLISH (see the terminal)">
          {p.admin === "up" ? "shutdown" : "no shutdown"}
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
        <Fact k="VLAN / mode" v={p.vlan} />
        <Fact k="IP" v={p.ipv4.join(", ") || "—"} />
        <Fact k="PortChannel" v={p.lag ? `${p.lag.name} (${p.lag.static ? "static" : p.lag.selected ? "selected" : "not selected"})` : "—"} />
        <Fact k="MAC" v={p.mac} />
        <Fact k="RX rate" v={fmtBps(p.rate?.rxBps)} />
        <Fact k="TX rate" v={fmtBps(p.rate?.txBps)} />
        <Fact k="LLDP neighbor" v={p.lldp ? `${p.lldp.sysName ?? p.lldp.chassisId} · ${p.lldp.portId}${p.lldp.mgmtIp ? ` · ${p.lldp.mgmtIp}` : ""}` : "—"} />
        <Fact k="LED meaning" v={p.led === "off" ? "off: no link" : p.led === "green" ? "green: link ≥10G, blinks on traffic" : "amber: link <10G, blinks on traffic"} />
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[#5f6b7a]">Counters (show interfaces counters)</div>
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
          <div className="mb-1 mt-2 text-[10px] font-semibold uppercase tracking-wide text-[#5f6b7a]">Drops by reason (show dropcounters)</div>
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
        </div>
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[#5f6b7a]">Last frames on this wire</div>
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

function CpuPanel({ cpu }: { cpu: ReturnType<typeof cpuView> }) {
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
      <div className="mb-1 mt-3 text-[10px] font-semibold uppercase tracking-wide text-[#5f6b7a]">Trap groups → CPU queue (show copp counters)</div>
      {cpu.groups.length ? (
        <table className="w-full font-mono text-[11px] text-[#c9d3de]">
          <tbody>
            <tr className="text-[#5f6b7a]">
              <td>group</td>
              <td className="text-right">queue</td>
              <td className="text-right">pkts</td>
              <td className="text-right">dropped</td>
            </tr>
            {cpu.groups.map((g) => (
              <tr key={g.group}>
                <td>{g.group}</td>
                <td className="text-right">{g.queue}</td>
                <td className="text-right">{g.pkts}</td>
                <td className={`text-right ${g.dropPkts ? "text-red-300" : ""}`}>{g.dropPkts}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="text-[11px] text-[#6b7789]">Nothing trapped yet.</div>
      )}
      <div className="mb-1 mt-3 text-[10px] font-semibold uppercase tracking-wide text-[#5f6b7a]">Containers (show feature status · docker ps)</div>
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

function Fact({ k, v }: { k: string; v: string }) {
  return (
    <div className="rounded-lg border border-edge bg-panel px-2 py-1.5">
      <div className="text-[10px] text-[#6b7789]">{k}</div>
      <div className="truncate font-mono text-[11px] text-[#e6edf3]" title={v}>
        {v}
      </div>
    </div>
  );
}

function Btn(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} className="rounded border border-edge bg-panel px-2.5 py-1 text-[11px] text-[#c9d3de] hover:border-accent-2 hover:text-accent-2" />;
}

function Seg({ value, options, onChange }: { value: string; options: [string, string][]; onChange(v: string): void }) {
  return (
    <div className="flex overflow-hidden rounded border border-edge text-[11px]">
      {options.map(([v, l]) => (
        <button key={v} onClick={() => onChange(v)} className={`px-2.5 py-1 ${value === v ? "bg-accent-2/20 text-accent-2" : "text-[#8b98a5] hover:text-[#e6edf3]"}`}>
          {l}
        </button>
      ))}
    </div>
  );
}

/* Faceplate / chassis styling (adapted from a realistic 1U switch mock-up). */
const CSS = `
.sw-stage { background: radial-gradient(circle at 50% 30%, rgba(45,55,72,.35) 0%, rgba(10,12,16,.95) 75%); touch-action: none; }
.sw-box { position: relative; transform-style: preserve-3d; transition: transform .35s ease;
  --top:#34383f; --mid:#272a30; --bot:#1b1e23; --border:#4a505c; --silk:#d4d8e0; --silk2:#8b93a1; --ear1:#2b2e35; --ear2:#1c1f24; --cage1:#aeb5bf; --cage2:#6e7580; --cage3:#8c94a0; }
.sw-silver { --top:#e2e5ea; --mid:#cfd4dc; --bot:#b5bcc7; --border:#fff; --silk:#2c313a; --silk2:#5a6270; --ear1:#c8ced8; --ear2:#9ea6b3; --cage1:#949ca8; --cage2:#525862; --cage3:#767e8a; }
.sw-face { position: absolute; left: 0; top: 0; backface-visibility: hidden; }
.sw-chassis { background: repeating-linear-gradient(0deg, rgba(255,255,255,.015) 0 1px, rgba(0,0,0,.025) 1px 2px), linear-gradient(180deg, var(--top) 0%, var(--mid) 45%, var(--bot) 100%);
  border-top: 1px solid var(--border); border-bottom: 2px solid #090a0d; box-shadow: inset 0 1px 0 rgba(255,255,255,.18), inset 0 -1px 2px rgba(0,0,0,.6); }
.sw-dark .sw-chassis, .sw-dark .sw-ear, .sw-dark .sw-lid, .sw-dark .sw-side { filter: brightness(.55) contrast(1.1); }
.sw-lid, .sw-side, .sw-bottom { width: 100%; height: 100%; background: linear-gradient(180deg, var(--mid), var(--bot)); }
.sw-lid { background: repeating-linear-gradient(90deg, rgba(0,0,0,.18) 0 2px, transparent 2px 14px), linear-gradient(180deg, var(--top), var(--bot)); }
.sw-ear { background: linear-gradient(180deg, var(--ear1), var(--ear2)); box-shadow: inset 0 1px 0 rgba(255,255,255,.14), inset 0 -1px 2px rgba(0,0,0,.7); }
.sw-slot { width: 16px; height: 10px; border-radius: 99px; background: #060709; box-shadow: inset 0 2px 4px rgba(0,0,0,.95); }
.sw-screw { width: 11px; height: 11px; border-radius: 50%; position: relative; background: radial-gradient(circle at 35% 35%, #9aa2ad 0%, #4d535e 60%, #23272e 100%); box-shadow: 0 1px 2px rgba(0,0,0,.8); }
.sw-screw::before, .sw-screw::after { content: ''; position: absolute; background: #17191e; top: 50%; left: 50%; transform: translate(-50%,-50%) rotate(22deg); }
.sw-screw::before { width: 7px; height: 1.5px; } .sw-screw::after { width: 1.5px; height: 7px; }
.sw-silk { color: var(--silk); } .sw-silk-sub { color: var(--silk2); }
.sw-vent { background-image: radial-gradient(#090b0e 42%, transparent 48%); background-size: 5px 5px; box-shadow: inset 0 2px 5px rgba(0,0,0,.8); }
.sw-oled-bezel { width: 86px; height: 86px; border-radius: 6px; padding: 6px; background: #090b0e; border: 1px solid rgba(255,255,255,.08); box-shadow: inset 0 2px 6px rgba(0,0,0,.95); }
.sw-oled { width: 100%; height: 100%; border-radius: 3px; padding: 5px; display: flex; flex-direction: column; text-align: left; font-family: ui-monospace, monospace; background: linear-gradient(145deg, #06131f, #030911); box-shadow: inset 0 0 10px rgba(14,165,233,.2); overflow: hidden; }
.sw-sysled { width: 6px; height: 6px; border-radius: 50%; background: #1c2026; border: 1px solid rgba(0,0,0,.75); }
.sw-bank { background: rgba(0,0,0,.28); border: 1px solid rgba(0,0,0,.55); box-shadow: inset 0 2px 6px rgba(0,0,0,.7); }
.sw-rj45, .sw-sfp { position: relative; border-radius: 3px; padding: 2px; cursor: pointer; transition: transform .12s, box-shadow .15s;
  background: linear-gradient(160deg, var(--cage1), var(--cage2) 55%, var(--cage3)); box-shadow: 0 2px 3px rgba(0,0,0,.65), inset 0 1px 0 rgba(255,255,255,.45); }
.sw-rj45 { width: 34px; height: 30px; } .sw-sfp { width: 44px; height: 30px; }
.sw-rj45:hover, .sw-sfp:hover { transform: scale(1.08); z-index: 5; box-shadow: 0 0 0 1.5px rgba(56,189,248,.85), 0 4px 10px rgba(0,0,0,.8); }
.sw-sel { box-shadow: 0 0 0 2px #38bdf8, 0 0 12px rgba(56,189,248,.6) !important; z-index: 6; }
.sw-console { background: linear-gradient(160deg, #38bdf8, #0284c7 60%, #0369a1); cursor: default; }
.sw-mgmt { cursor: default; }
.sw-rj45-cavity, .sw-sfp-cavity { width: 100%; height: 100%; border-radius: 1.5px; background: linear-gradient(180deg, #07080a, #14171c); box-shadow: inset 0 3px 5px rgba(0,0,0,.95); display: flex; align-items: center; justify-content: center; }
.sw-sfp-rail { width: 28px; height: 5px; border-radius: 1px; opacity: .7; background: repeating-linear-gradient(90deg, #854d0e 0, #ca8a04 1.5px, #111318 1.5px, #111318 3px); }
.sw-pled { position: absolute; width: 6px; height: 4px; border-radius: 1px; background: #1a1e24; border: .5px solid rgba(0,0,0,.8); z-index: 4; top: 2.5px; }
.sw-pled-l { left: 2.5px; } .sw-pled-r { right: 2.5px; }
.sw-inv .sw-pled { top: auto; bottom: 2.5px; }
.on-green { background: #4ade80 !important; box-shadow: 0 0 4px #22c55e, 0 0 9px rgba(34,197,94,.85) !important; }
.on-amber { background: #fbbf24 !important; box-shadow: 0 0 4px #f59e0b, 0 0 9px rgba(245,158,11,.85) !important; }
.on-blue { background: #60a5fa !important; box-shadow: 0 0 5px #3b82f6, 0 0 11px rgba(59,130,246,.9) !important; }
.sw-dark .on-green, .sw-dark .on-amber, .sw-dark .on-blue { filter: brightness(1.5); }
.sw-blink { animation: swBlink .8s steps(2) infinite; } @keyframes swBlink { 50% { opacity: .15; } }
.sw-plug { position: absolute; inset: 2px; z-index: 3; display: flex; align-items: center; justify-content: center; pointer-events: none; animation: swSnap .16s cubic-bezier(.22,1,.36,1); }
.sw-plug-body { width: 24px; height: 20px; border-radius: 2px; display: flex; align-items: center; justify-content: center; background: linear-gradient(145deg, rgba(255,255,255,.42), rgba(180,195,210,.25) 50%, rgba(40,48,58,.6)); border: 1px solid rgba(255,255,255,.45); box-shadow: 0 3px 6px rgba(0,0,0,.85); }
.sw-boot { width: 16px; height: 13px; border-radius: 4px; box-shadow: inset 0 2px 3px rgba(255,255,255,.38), inset 0 -2px 4px rgba(0,0,0,.55); }
.sw-sfp-module { position: absolute; inset: 3px; z-index: 3; border-radius: 1.5px; display: flex; align-items: center; justify-content: space-between; padding: 3px 4px; pointer-events: none;
  background: linear-gradient(180deg, #cfd6e0, #8b93a0); box-shadow: 0 3px 6px rgba(0,0,0,.85); animation: swSnap .16s cubic-bezier(.22,1,.36,1); }
.sw-lc { width: 10px; height: 13px; border-radius: 1.5px; border: 1px solid rgba(255,255,255,.35); }
.sw-bail { width: 5px; height: 15px; border-radius: 1.5px; background: linear-gradient(180deg, #38bdf8, #0284c7); }
.sw-tail { position: absolute; left: 50%; width: 8px; height: 22px; transform: translateX(-50%); border-radius: 4px; box-shadow: 2px 4px 6px rgba(0,0,0,.75); }
.sw-tail.down { top: 18px; } .sw-tail.up { bottom: 18px; }
@keyframes swSnap { 0% { transform: scale(1.35); opacity: .5; } 100% { transform: scale(1); opacity: 1; } }
.sw-pcb .sw-t { font: 10px ui-monospace, monospace; fill: #9fb3c8; } .sw-pcb .sw-t.big { font-size: 12px; font-weight: 700; fill: #e6edf3; } .sw-pcb .sw-t.dim { fill: #5f7a8e; }
.sw-trace { fill: none; stroke: #2b6650; stroke-width: 2; } .sw-trace.up { stroke: #4ade80; stroke-opacity: .55; } .sw-trace.sel { stroke: #38bdf8; stroke-opacity: 1; stroke-width: 3; }
.sw-trace.pcie { stroke: #a78bfa; stroke-opacity: .5; stroke-width: 4; } .sw-trace.mgmt { stroke: #a78bfa; stroke-opacity: .4; stroke-dasharray: 6 4; } .sw-trace.hot { stroke-opacity: 1; }
.sw-dot { fill: #fde047; filter: drop-shadow(0 0 4px #facc15); } .sw-dot.cpu { fill: #c4b5fd; filter: drop-shadow(0 0 4px #a78bfa); }
.sw-fan { animation: swSpin .6s linear infinite; } @keyframes swSpin { to { transform: rotate(360deg); } }
`;
