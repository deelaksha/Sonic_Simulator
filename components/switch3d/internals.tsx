"use client";
/**
 * "Inside" view drawn on the chassis top face. Where a packet goes inside the box:
 *   switch  ports → switching ASIC (forwards in hardware) — PCIe → CPU (control plane only)
 *   router  ports → route processor: the CPU forwards in software and runs the protocols
 *   pc/srv  ports → NIC — PCIe → CPU running the OS network stack and applications
 * Dots run along a trace whenever that path's real counters changed in the last tick.
 */
import { ChassisKind, CpuView, PortView, fmtBps } from "@/lib/switch3d/model";

interface Chip {
  title: string;
  lines: string[];
  color: string;
}

const CHIPS: Record<Exclude<ChassisKind, "internet">, { fwd: Chip; cpu?: Chip; link?: string }> = {
  switch: {
    fwd: { title: "Switching ASIC (data plane)", lines: ["parse → L2 FDB / L3 LPM lookup", "ACL → QoS queues → egress", "transit traffic never leaves the ASIC"], color: "#38bdf8" },
    cpu: { title: "CPU (control plane)", lines: ["SONiC Linux + containers"], color: "#a78bfa" },
    link: "PCIe · hostif traps (CoPP)",
  },
  router: {
    fwd: { title: "Route processor (CPU)", lines: ["software forwarding: LPM lookup, ARP, TTL−1", "routing protocols run on the same CPU", "every packet is handled in software"], color: "#a78bfa" },
  },
  pc: {
    fwd: { title: "NIC (Ethernet controller)", lines: ["MAC filter · checksum", "DMA to RAM"], color: "#38bdf8" },
    cpu: { title: "CPU — OS network stack", lines: ["IP · ARP · TCP / UDP", "apps: ping, nc, iperf3, curl…"], color: "#a78bfa" },
    link: "PCIe · DMA",
  },
  server: {
    fwd: { title: "NIC (Ethernet controller)", lines: ["MAC filter · checksum", "DMA to RAM"], color: "#38bdf8" },
    cpu: { title: "CPU — OS network stack", lines: ["IP · ARP · TCP / UDP", "services: DHCP / DNS / NTP / web…"], color: "#a78bfa" },
    link: "PCIe · DMA",
  },
};

export function Internals(props: {
  kind: Exclude<ChassisKind, "internet">;
  W: number;
  D: number;
  ports: PortView[];
  active: Set<string>;
  cpuActive: boolean;
  cpu?: CpuView;
  mgmtActive: boolean;
  hasMgmt: boolean;
  sel?: string;
}) {
  const { kind, W, D, ports, active, sel } = props;
  const spec = CHIPS[kind];
  const host = kind === "pc" || kind === "server";
  const x0 = host ? W * 0.45 : 330;
  const x1 = W - 90;
  const px = (i: number) => (ports.length > 1 ? x0 + (i * (x1 - x0)) / (ports.length - 1) : (x0 + x1) / 2);
  const fwd = host ? { x: W * 0.5, y: D * 0.5, w: 200, h: 70 } : { x: W * 0.52, y: D * 0.42, w: kind === "router" ? 300 : 240, h: 110 };
  const cpuBox = { x: 100, y: 70, w: 230, h: 96 };
  const fx = fwd.x + fwd.w / 2;
  const trace = (i: number) => `M ${px(i)} ${D - 20} C ${px(i)} ${D - 90}, ${fx} ${fwd.y + fwd.h + 60}, ${fx} ${fwd.y + fwd.h}`;
  const pcie = `M ${fwd.x} ${fwd.y + 40} C ${fwd.x - 120} ${fwd.y + 40}, ${cpuBox.x + cpuBox.w + 80} ${cpuBox.y + 50}, ${cpuBox.x + cpuBox.w} ${cpuBox.y + 50}`;
  const mgmtX = 215;
  const mgmtPath = `M ${mgmtX} ${D - 20} L ${mgmtX} ${cpuBox.y + cpuBox.h}`;
  const fans = kind === "pc" ? 1 : 4;
  const cpuStats = props.cpu ? `trapped ${props.cpu.totalTrapped} · policed ${props.cpu.totalPoliced}` : undefined;
  return (
    <svg width={W} height={D} viewBox={`0 0 ${W} ${D}`} className="sw-pcb">
      <defs>
        <linearGradient id="pcb" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#0b3b2c" />
          <stop offset="1" stopColor="#06261c" />
        </linearGradient>
      </defs>
      <rect x="6" y="6" width={W - 12} height={D - 12} rx="6" fill="url(#pcb)" stroke="#1d5a45" />
      {Array.from({ length: fans }, (_, i) => (
        <g key={i} transform={`translate(${(host ? W * 0.62 : 380) + i * 92} 44)`}>
          <circle r="30" fill="#111418" stroke="#2c323b" />
          <g className="sw-fan">
            {[0, 72, 144, 216, 288].map((a) => (
              <path key={a} d="M0 0 C 8 -10, 22 -14, 26 -4 Z" fill="#3b4250" transform={`rotate(${a})`} />
            ))}
          </g>
          <text y="46" textAnchor="middle" className="sw-t">
            FAN {i + 1}
          </text>
        </g>
      ))}
      {Array.from({ length: kind === "pc" ? 1 : 2 }, (_, i) => (
        <g key={i}>
          <rect x={W - 150} y={20 + i * 70} width="120" height="58" rx="4" fill="#1a1d23" stroke="#3a414d" />
          <text x={W - 90} y={54 + i * 70} textAnchor="middle" className="sw-t">
            PSU {i + 1} · OK
          </text>
        </g>
      ))}
      {ports.map((p, i) => (
        <g key={p.id}>
          <path d={trace(i)} className={`sw-trace ${p.oper === "up" ? "up" : ""} ${sel === p.id ? "sel" : ""}`} />
          {active.has(p.id) && (
            <circle r="4" className="sw-dot">
              <animateMotion dur="0.6s" repeatCount="1" path={trace(i)} keyPoints={i % 2 ? "0;1" : "1;0"} keyTimes="0;1" />
            </circle>
          )}
          <rect x={px(i) - 13} y={D - 22} width="26" height="16" rx="2" fill={p.oper === "up" ? "#94a3b8" : "#4b5563"} />
          <text x={px(i)} y={D - 28} textAnchor="middle" className="sw-t">
            {kind === "switch" ? p.label : p.name}
          </text>
          <text x={px(i)} y={D - 40} textAnchor="middle" className="sw-t dim">
            {p.rate?.rxBps !== undefined ? fmtBps((p.rate.rxBps ?? 0) + (p.rate.txBps ?? 0)) : ""}
          </text>
        </g>
      ))}
      <rect x={fwd.x} y={fwd.y} width={fwd.w} height={fwd.h} rx="6" fill="#1b1f27" stroke={spec.fwd.color} strokeWidth="1.5" />
      <text x={fx} y={fwd.y + 20} textAnchor="middle" className="sw-t big">
        {spec.fwd.title}
      </text>
      {spec.fwd.lines.map((l, i) => (
        <text key={i} x={fx} y={fwd.y + 42 + i * 18} textAnchor="middle" className="sw-t">
          {l}
        </text>
      ))}
      {spec.cpu && (
        <>
          <path d={pcie} className={`sw-trace pcie ${props.cpuActive ? "hot" : ""}`} />
          {props.cpuActive && (
            <circle r="4.5" className="sw-dot cpu">
              <animateMotion dur="0.7s" repeatCount="1" path={pcie} />
            </circle>
          )}
          <text x={host ? cpuBox.x + cpuBox.w / 2 : (fwd.x + cpuBox.x + cpuBox.w) / 2} y={host ? cpuBox.y + cpuBox.h + 68 : fwd.y + 18} textAnchor="middle" className="sw-t">
            {spec.link}
          </text>
          <rect x={cpuBox.x} y={cpuBox.y} width={cpuBox.w} height={cpuBox.h} rx="6" fill="#1b1f27" stroke={spec.cpu.color} strokeWidth="1.5" />
          <text x={cpuBox.x + cpuBox.w / 2} y={cpuBox.y + 20} textAnchor="middle" className="sw-t big">
            {spec.cpu.title}
          </text>
          {[...spec.cpu.lines, ...(cpuStats ? [cpuStats] : [])].map((l, i) => (
            <text key={i} x={cpuBox.x + cpuBox.w / 2} y={cpuBox.y + 42 + i * 18} textAnchor="middle" className="sw-t">
              {l}
            </text>
          ))}
          {[0, 1].map((i) => (
            <rect key={i} x={cpuBox.x + 10 + i * 90} y={cpuBox.y + cpuBox.h + 16} width="80" height="14" rx="2" fill="#2a2f38" stroke="#475161" />
          ))}
          <text x={cpuBox.x + cpuBox.w / 2} y={cpuBox.y + cpuBox.h + 48} textAnchor="middle" className="sw-t dim">
            DRAM
          </text>
        </>
      )}
      {props.hasMgmt && spec.cpu && (
        <>
          <path d={mgmtPath} className={`sw-trace mgmt ${props.mgmtActive ? "hot" : ""}`} />
          {props.mgmtActive && (
            <circle r="4" className="sw-dot cpu">
              <animateMotion dur="0.6s" repeatCount="1" path={mgmtPath} />
            </circle>
          )}
          <rect x={mgmtX - 13} y={D - 22} width="26" height="16" rx="2" fill="#94a3b8" />
          <text x={mgmtX} y={D - 28} textAnchor="middle" className="sw-t">
            eth0 (mgmt → CPU)
          </text>
        </>
      )}
    </svg>
  );
}

/** Inside the ISP handoff: optics → SoC → LAN, and the fiber out to the (simulated) internet. */
export function InternetInternals({ W, D, ports, active }: { W: number; D: number; ports: PortView[]; active: Set<string> }) {
  const busy = ports.some((p) => active.has(p.id));
  const soc = { x: W * 0.45, y: D * 0.55, w: 170, h: 60 };
  const optics = { x: 70, y: D * 0.55, w: 120, h: 60 };
  const px = (i: number) => (ports.length > 1 ? W * 0.55 + (i * W * 0.3) / (ports.length - 1) : W * 0.7);
  const lan = (i: number) => `M ${px(i)} ${D - 20} C ${px(i)} ${D - 70}, ${soc.x + soc.w / 2} ${soc.y + soc.h + 40}, ${soc.x + soc.w / 2} ${soc.y + soc.h}`;
  const fiber = `M ${optics.x + optics.w / 2} ${optics.y} C ${optics.x + 40} ${D * 0.25}, ${W * 0.4} ${D * 0.3}, ${W * 0.46} 108`; // ends at the cloud's lower edge
  const cloud = `M ${W * 0.38} 80 a 34 34 0 0 1 40 -40 a 46 46 0 0 1 84 -8 a 40 40 0 0 1 70 18 a 30 30 0 0 1 4 58 h -186 a 28 28 0 0 1 -12 -28 z`;
  return (
    <svg width={W} height={D} viewBox={`0 0 ${W} ${D}`} className="sw-pcb">
      <rect x="6" y="6" width={W - 12} height={D - 12} rx="10" fill="#0d2a3a" stroke="#1e4a63" />
      <path d={cloud} fill="#1e3a5f" stroke="#60a5fa" strokeWidth="1.5" />
      <text x={W * 0.56} y={78} textAnchor="middle" className="sw-t big">
        The internet (simulated)
      </text>
      <text x={W * 0.56} y={150} textAnchor="middle" className="sw-t">
        answers ping for every address routed here
      </text>
      <text x={W * 0.56} y={166} textAnchor="middle" className="sw-t">
        DNS (udp/53) · NTP (udp/123) · HTTP (tcp/80)
      </text>
      <path d={fiber} fill="none" stroke="#facc15" strokeWidth="3" strokeOpacity={busy ? 1 : 0.6} />
      {busy && (
        <circle r="4.5" className="sw-dot">
          <animateMotion dur="0.8s" repeatCount="1" path={fiber} />
        </circle>
      )}
      <text x={optics.x + 30} y={D * 0.33} className="sw-t">
        fiber to the ISP
      </text>
      <rect x={optics.x} y={optics.y} width={optics.w} height={optics.h} rx="6" fill="#1b1f27" stroke="#facc15" />
      <text x={optics.x + optics.w / 2} y={optics.y + 24} textAnchor="middle" className="sw-t big">
        PON optics
      </text>
      <text x={optics.x + optics.w / 2} y={optics.y + 42} textAnchor="middle" className="sw-t">
        light ⇄ electrical
      </text>
      <path d={`M ${optics.x + optics.w} ${optics.y + 30} L ${soc.x} ${soc.y + 30}`} className={`sw-trace pcie ${busy ? "hot" : ""}`} />
      <rect x={soc.x} y={soc.y} width={soc.w} height={soc.h} rx="6" fill="#1b1f27" stroke="#38bdf8" />
      <text x={soc.x + soc.w / 2} y={soc.y + 24} textAnchor="middle" className="sw-t big">
        ONT SoC
      </text>
      <text x={soc.x + soc.w / 2} y={soc.y + 42} textAnchor="middle" className="sw-t">
        GPON MAC · bridge to LAN
      </text>
      {ports.map((p, i) => (
        <g key={p.id}>
          <path d={lan(i)} className={`sw-trace ${p.oper === "up" ? "up" : ""}`} />
          {active.has(p.id) && (
            <circle r="4" className="sw-dot">
              <animateMotion dur="0.6s" repeatCount="1" path={lan(i)} />
            </circle>
          )}
          <rect x={px(i) - 13} y={D - 22} width="26" height="16" rx="2" fill={p.oper === "up" ? "#94a3b8" : "#4b5563"} />
          <text x={px(i)} y={D - 28} textAnchor="middle" className="sw-t">
            {p.name}
          </text>
        </g>
      ))}
    </svg>
  );
}
