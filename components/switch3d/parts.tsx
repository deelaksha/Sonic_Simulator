"use client";
/** Shared hardware pieces for the 3D device view: ports, rack ears, LEDs, small UI widgets. */
import { PortView } from "@/lib/switch3d/model";

const CABLE: Record<string, string> = { switch: "#22d3ee", router: "#eab308", firewall: "#eab308", internet: "#dc2626" };
export const cableColor = (peerType?: string) => (peerType ? CABLE[peerType] ?? "#2563eb" : "#64748b");

export function shade(hex: string, pct: number): string {
  const n = parseInt(hex.slice(1), 16);
  const a = Math.round(2.55 * pct);
  const c = (v: number) => Math.min(255, Math.max(0, v + a));
  return `#${((1 << 24) + (c(n >> 16) << 16) + (c((n >> 8) & 255) << 8) + c(n & 255)).toString(16).slice(1)}`;
}

/** Short mechanical latch click (Web Audio); silently skipped if audio is blocked. */
let audio: AudioContext | null = null;
export function click(plug: boolean) {
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

export function Ear() {
  return (
    <div className="sw-ear flex w-8 shrink-0 flex-col items-center justify-between py-3">
      <div className="sw-slot" />
      <div className="sw-screw" />
      <div className="sw-screw" />
      <div className="sw-slot" />
    </div>
  );
}

export function SysLed({ label, on, blink }: { label: string; on?: "green" | "blue" | "amber"; blink?: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`sw-sysled ${on ? `on-${on}` : ""} ${blink ? "sw-blink" : ""}`} />
      <span className="sw-silk-sub font-mono text-[8px] font-semibold">{label}</span>
    </div>
  );
}

/** A frame entering or leaving a port right now (packet animation). */
export interface PortPacket {
  label: string;
  color: string;
  dir: "in" | "out";
  ms: number;
  key: string;
}

/** One network port with its link/activity LED and, when cabled, the plug or transceiver. */
export function Port({ p, bottom, blinking, selected, onClick, packet }: { p: PortView; bottom?: boolean; blinking: boolean; selected: boolean; onClick(): void; packet?: PortPacket }) {
  const c = cableColor(p.peer?.deviceType);
  const tip = `${p.name} (${p.speedLabel}) — ${p.admin === "down" ? "admin down" : p.oper === "up" ? "link up" : "no link"}${p.peer ? ` · cabled to ${p.peer.deviceName} ${p.peer.ifName}` : " · empty"}`;
  // Activity: the link LED goes dark for one tick when frames moved (bursty blink).
  const led = p.led !== "off" && !blinking ? `on-${p.led}` : "";
  const tail = { background: `linear-gradient(90deg, ${shade(c, -25)}, ${c} 45%, ${shade(c, -35)})` };
  return (
    <button data-port data-iface={p.id} className={`${p.kind === "sfp" ? "sw-sfp" : "sw-rj45"} ${bottom ? "sw-inv" : ""} ${selected ? "sw-sel" : ""}`} onClick={onClick} title={tip}>
      <span className={`sw-pled sw-pled-l ${led}`} />
      {p.admin === "down" && <span className="sw-pled sw-pled-r on-amber" title="administratively down" />}
      {packet && (
        <span
          key={packet.key}
          className={`sw-pkt ${packet.dir} ${bottom ? "low" : "high"}`}
          style={{ background: packet.color, ["--ms" as string]: `${packet.ms}ms` }}
        >
          {packet.label}
        </span>
      )}
      <div className={p.kind === "sfp" ? "sw-sfp-cavity" : "sw-rj45-cavity"}>{p.kind === "sfp" && !p.peer && <div className="sw-sfp-rail" />}</div>
      {p.peer &&
        (p.kind === "sfp" ? (
          <div className="sw-sfp-module">
            <div className="flex gap-[3px]">
              <span className="sw-lc" style={{ background: `linear-gradient(145deg, ${c}, ${shade(c, -30)})` }} />
              <span className="sw-lc" style={{ background: `linear-gradient(145deg, ${c}, ${shade(c, -30)})` }} />
            </div>
            <span className="sw-bail" />
            <span className={`sw-tail ${bottom ? "down" : "up"}`} style={tail} />
          </div>
        ) : (
          <div className="sw-plug">
            <div className="sw-plug-body">
              <div className="sw-boot" style={{ background: `linear-gradient(145deg, ${c}, ${shade(c, -35)})` }} />
            </div>
            <span className={`sw-tail ${bottom ? "down" : "up"}`} style={tail} />
          </div>
        ))}
    </button>
  );
}

/** A plain jack that isn't a modelled interface (console, BMC…): optionally cabled, never clickable. */
export function StaticJack({ title, console: isConsole, cabled }: { title: string; console?: boolean; cabled?: boolean }) {
  return (
    <div className={`sw-rj45 ${isConsole ? "sw-console" : "sw-mgmt"}`} title={title}>
      <div className="sw-rj45-cavity" />
      {cabled && (
        <div className="sw-plug">
          <div className="sw-plug-body">
            <div className="sw-boot" style={{ background: "linear-gradient(145deg, #64748b, #334155)" }} />
          </div>
        </div>
      )}
    </div>
  );
}

export function Fact({ k, v }: { k: string; v: string }) {
  return (
    <div className="rounded-lg border border-edge bg-panel px-2 py-1.5">
      <div className="text-[10px] text-[#6b7789]">{k}</div>
      <div className="truncate font-mono text-[11px] text-[#e6edf3]" title={v}>
        {v}
      </div>
    </div>
  );
}

export function Btn(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} className="rounded border border-edge bg-panel px-2.5 py-1 text-[11px] text-[#c9d3de] hover:border-accent-2 hover:text-accent-2" />;
}

export function Seg({ value, options, onChange }: { value: string; options: [string, string][]; onChange(v: string): void }) {
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

export const Heading = ({ children }: { children: React.ReactNode }) => (
  <div className="mb-1 mt-3 text-[10px] font-semibold uppercase tracking-wide text-[#5f6b7a]">{children}</div>
);
