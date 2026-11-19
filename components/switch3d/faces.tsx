"use client";
/**
 * The panel a learner sees for each kind of device — where its network ports are:
 *   switch  1U faceplate: OLED, system LEDs, MGMT + console, front-panel ports in two rows
 *   router  1U faceplate: system LEDs, console / AUX / USB, routed ports in a row
 *   pc      desktop rear I/O panel: PSU, USB, video, audio and the network card (NIC)
 *   server  1U rack server rear: dual PSUs, VGA, serial, USB, BMC port, the NIC ports
 * Only interfaces that exist in the simulated device are clickable ports.
 */
import { Device } from "@/lib/models/device";
import { PortView } from "@/lib/switch3d/model";
import { Ear, Port, PortPacket, StaticJack, SysLed } from "./parts";

export interface FaceProps {
  device: Device;
  ports: PortView[];
  active: Set<string>;
  sel?: string;
  onSelect(id: string): void;
  beacon: boolean;
  mgmt?: { id: string; up: boolean; peer?: string; active: boolean };
  /** Frames entering / leaving ports right now (port id → packet). */
  packets?: Record<string, PortPacket>;
}

const Label = ({ children }: { children: React.ReactNode }) => <span className="sw-silk-sub font-mono text-[7.5px] uppercase">{children}</span>;

function portEl(p: FaceProps, port: PortView, bottom = false) {
  return <Port key={port.id} p={port} bottom={bottom} blinking={p.active.has(port.id)} selected={p.sel === port.id} onClick={() => p.onSelect(port.id)} packet={p.packets?.[port.id]} />;
}

/* ---------------------------------------------------------------- switch */

export function SwitchFace(props: FaceProps & { oled: [string, string, string]; onOled(): void }) {
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
            <div className="sw-silk-sub font-mono text-[8px] uppercase">SONiC switch · 1U</div>
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1">
            <SysLed label="PSU" on="green" />
            <SysLed label="SYS" on="green" />
            <SysLed label="FAN" on="green" />
            <SysLed label="LOC" on={props.beacon ? "blue" : undefined} blink={props.beacon} />
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-center gap-1 border-r border-black/25 pr-3">
          <Label>MGMT</Label>
          <MgmtJack mgmt={props.mgmt} />
          <Label>CONSOLE</Label>
          <StaticJack console title="RS-232 console (the terminal panel below is this console)" />
        </div>
        <div className="flex flex-1 items-center justify-center gap-3">
          {banks.map((bank, bi) => (
            <div key={bi} className="sw-bank flex gap-1.5 rounded p-1.5">
              {bank.map((col, ci) => (
                <div key={ci} className="flex flex-col items-center gap-1">
                  <Label>{col[0].label}</Label>
                  {col.map((p, ri) => portEl(props, p, ri === 1))}
                  {col[1] && <Label>{col[1].label}</Label>}
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

function MgmtJack({ mgmt }: { mgmt?: FaceProps["mgmt"] }) {
  return (
    <div data-iface={mgmt?.id} className="sw-rj45 sw-mgmt" title={`eth0 (management, the CPU's own NIC) — ${mgmt?.up ? "link up" : "no link"}${mgmt?.peer ? ` · cabled to ${mgmt.peer}` : ""}`}>
      <span className={`sw-pled sw-pled-l ${mgmt?.up && !mgmt.active ? "on-amber" : ""}`} />
      <div className="sw-rj45-cavity" />
      {mgmt?.peer && (
        <div className="sw-plug">
          <div className="sw-plug-body">
            <div className="sw-boot" style={{ background: "linear-gradient(145deg, #64748b, #334155)" }} />
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- router */

export function RouterFace(props: FaceProps) {
  return (
    <div className="sw-router flex h-full items-stretch">
      <Ear />
      <div className="sw-chassis flex flex-1 items-center gap-4 px-4">
        <div className="flex h-[88px] shrink-0 flex-col justify-between border-r border-black/25 pr-4">
          <div>
            <div className="sw-silk text-[13px] font-bold tracking-wider">{props.device.name}</div>
            <div className="sw-silk-sub font-mono text-[8px] uppercase">{props.device.type === "firewall" ? "firewall" : "router"} · 1U</div>
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1">
            <SysLed label="PWR" on="green" />
            <SysLed label="SYS" on="green" />
            <SysLed label="ALM" />
            <SysLed label="LOC" on={props.beacon ? "blue" : undefined} blink={props.beacon} />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3 border-r border-black/25 pr-4">
          <div className="flex flex-col items-center gap-1">
            <Label>CON</Label>
            <StaticJack console title="Console port (the terminal panel below is this console)" />
          </div>
          <div className="flex flex-col items-center gap-1">
            <Label>AUX</Label>
            <StaticJack title="Auxiliary (modem) port — not modelled" />
          </div>
          <div className="flex flex-col items-center gap-1.5">
            <Label>USB</Label>
            <span className="sw-usb" />
          </div>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <div className="sw-bank flex gap-3 rounded px-3 py-2">
            {props.ports.map((p) => (
              <div key={p.id} className="flex flex-col items-center gap-1">
                {portEl(props, p)}
                <Label>{p.name}</Label>
              </div>
            ))}
          </div>
        </div>
        <div className="sw-vent h-[86px] w-10 shrink-0 rounded-sm" title="Airflow" />
      </div>
      <Ear />
    </div>
  );
}

/* ---------------------------------------------------------------- pc (rear I/O) */

export function PcRear(props: FaceProps) {
  return (
    <div className="sw-steel flex h-full items-center gap-4 rounded-sm px-4">
      {/* power supply */}
      <div className="sw-psu flex h-[140px] w-[150px] shrink-0 items-center justify-around px-2">
        <div className="sw-grill h-[100px] w-[100px]" title="PSU fan" />
        <div className="flex flex-col items-center gap-2">
          <div className="sw-iec" title="AC inlet (IEC C14)" />
          <div className="sw-rocker" title="Power switch" />
        </div>
      </div>
      {/* motherboard I/O shield */}
      <div className="sw-shield flex flex-1 flex-col justify-center gap-3 self-stretch px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="sw-usb" style={{ ["--usb" as string]: "#1d4ed8" }} title="USB 3" />
          <span className="sw-usb" style={{ ["--usb" as string]: "#1d4ed8" }} title="USB 3" />
          <span className="sw-usb" style={{ ["--usb" as string]: "#111" }} title="USB 2" />
          <span className="sw-usb" style={{ ["--usb" as string]: "#111" }} title="USB 2" />
          <span className="sw-hdmi" title="HDMI" />
          <span className="sw-dp" title="DisplayPort" />
        </div>
        <div className="flex items-end gap-4">
          <div className="flex items-end gap-3">
            {props.ports.map((p) => (
              <div key={p.id} className="flex flex-col items-center gap-1">
                {portEl(props, p)}
                <span className="font-mono text-[8px] text-[#1f2329]">{p.name}</span>
              </div>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2" title="Audio: line in / line out / mic">
            <span className="sw-jack" style={{ background: "#7dd3fc" }} />
            <span className="sw-jack" style={{ background: "#a3e635" }} />
            <span className="sw-jack" style={{ background: "#f9a8d4" }} />
          </div>
        </div>
      </div>
      {/* expansion slot covers */}
      <div className="flex w-[120px] shrink-0 flex-col gap-2" title="PCIe expansion slots (empty)">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="sw-slotcover" />
        ))}
        <span className="text-center font-mono text-[8px] text-[#c9d3de]">{props.device.name}</span>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- server (1U rear) */

export function ServerRear(props: FaceProps) {
  return (
    <div className="sw-steel flex h-full items-center gap-3 px-3">
      {[1, 2].map((n) => (
        <div key={n} className="sw-psu flex h-[96px] w-[120px] shrink-0 items-center gap-2 px-2" title={`PSU ${n} (redundant, hot-swap)`}>
          <div className="sw-handle h-[70px]" />
          <div className="sw-grill h-[60px] w-[60px]" />
          <div className="flex flex-col items-center gap-2">
            <span className="sw-sysled on-green" />
            <div className="sw-iec" />
          </div>
        </div>
      ))}
      <div className="flex shrink-0 flex-col items-center gap-2 px-2">
        <span className="sw-vga" title="VGA" />
        <span className="sw-db9" title="Serial (console)" />
      </div>
      <div className="flex shrink-0 flex-col gap-2">
        <span className="sw-usb" title="USB" />
        <span className="sw-usb" title="USB" />
      </div>
      <div className="flex shrink-0 flex-col items-center gap-1">
        <span className="font-mono text-[7.5px] text-[#d4d8e0]">BMC</span>
        <StaticJack title="Baseboard management controller port — not modelled" />
      </div>
      <div className="sw-bank flex flex-1 items-center justify-center gap-3 rounded px-3 py-2">
        {props.ports.map((p) => (
          <div key={p.id} className="flex flex-col items-center gap-1">
            {portEl(props, p)}
            <span className="font-mono text-[7.5px] text-[#d4d8e0]">{p.name}</span>
          </div>
        ))}
      </div>
      <div className="flex w-[150px] shrink-0 flex-col gap-2" title="PCIe riser (empty)">
        <div className="sw-slotcover" />
        <div className="sw-slotcover" />
        <span className="text-center font-mono text-[8px] text-[#d4d8e0]">{props.device.name}</span>
      </div>
      <div className="sw-vent h-[86px] w-6 shrink-0 rounded-sm" />
    </div>
  );
}

/* ---------------------------------------------------------------- internet (ISP handoff) */

/**
 * The "internet" node has no box of its own: what a network really plugs into is
 * the ISP's handoff — here a fiber ONT. Its LAN ports are the node's interfaces;
 * the green SC/APC port carries the fiber towards the provider.
 */
export function InternetFace(props: FaceProps) {
  const up = props.ports.some((p) => p.oper === "up");
  return (
    <div className="sw-ont flex h-full items-center gap-5 px-5">
      <div className="flex shrink-0 flex-col items-center gap-1" title="PON fiber port (SC/APC) — the line to the ISP">
        <div className="relative">
          <div className="sw-sc" />
          <div className="sw-fiber" />
        </div>
        <span className="mt-10 font-mono text-[8px] font-semibold text-[#4b5563]">PON</span>
      </div>
      <div className="flex shrink-0 flex-col gap-1.5 border-r border-black/10 pr-5">
        {(
          [
            ["PWR", "green"],
            ["PON", "green"],
            ["LOS", undefined],
            ["INTERNET", up ? "green" : undefined],
          ] as const
        ).map(([l, on]) => (
          <div key={l} className="flex items-center gap-1.5">
            <span className={`sw-sysled ${on ? `on-${on}` : ""}`} />
            <span className="font-mono text-[8px] font-semibold text-[#4b5563]">{l}</span>
          </div>
        ))}
      </div>
      <div className="flex flex-1 items-center justify-center gap-4">
        {props.ports.map((p, i) => (
          <div key={p.id} className="flex flex-col items-center gap-1">
            {portEl(props, p)}
            <span className="font-mono text-[8px] font-semibold text-[#4b5563]">
              LAN {i + 1} · {p.name}
            </span>
          </div>
        ))}
      </div>
      <div className="flex shrink-0 flex-col items-end">
        <span className="text-[12px] font-bold tracking-wide text-[#374151]">{props.device.name}</span>
        <span className="font-mono text-[8px] uppercase text-[#6b7280]">ISP handoff · fiber ONT</span>
      </div>
    </div>
  );
}
