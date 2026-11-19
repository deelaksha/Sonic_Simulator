"use client";
/**
 * Hardware view of a device, drawn as a real box in CSS 3D seen from fixed camera
 * positions (no free rotation): the panel where its network ports are, an angled
 * view, and "inside" (lid off: where a packet goes inside the box).
 *   switch → 1U SONiC switch faceplate · router → 1U router faceplate
 *   pc     → desktop rear I/O panel   · server (and DHCP/DNS/NTP servers) → 1U server rear
 * Opens over the canvas + inspector, so the terminal below stays usable.
 * All data comes from the live simulated device (lib/switch3d/model.ts).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useLabStore } from "@/lib/store/lab-store";
import { Device } from "@/lib/models/device";
import { ChassisKind, activityOf, chassisKind, cpuView, hopUsesCpu, hostView, peerOf, portViews, routeRows } from "@/lib/switch3d/model";
import { PacketCaption, usePacketPlayer } from "./packetPlayer";
import { CSS } from "./styles";
import { Btn, Seg } from "./parts";
import { FaceProps, InternetFace, PcRear, RouterFace, ServerRear, SwitchFace } from "./faces";
import { DevicePacket, Internals, InternetInternals } from "./internals";
import { CpuPanel, HostPanel, INTERNET_INTRO, PortInspector, RouterPanel } from "./panels";

/** Box size per kind (px): width, panel height, depth. */
const SIZE: Record<ChassisKind, { W: number; H: number; D: number }> = {
  switch: { W: 980, H: 118, D: 440 },
  router: { W: 980, H: 118, D: 400 },
  server: { W: 980, H: 118, D: 520 },
  pc: { W: 760, H: 172, D: 420 },
  internet: { W: 720, H: 150, D: 400 },
};

type Shot = "face" | "angled" | "inside";
const SHOTS: Record<Shot, { rx: number; ry: number }> = {
  face: { rx: 0, ry: 0 },
  angled: { rx: 14, ry: -18 },
  inside: { rx: 58, ry: 0 },
};

const KIND_LABEL: Record<ChassisKind, string> = {
  switch: "SONiC switch",
  router: "router",
  pc: "desktop PC (rear panel — where the network card is)",
  server: "rack server (rear panel — where the network ports are)",
  internet: "the internet — drawn as the ISP handoff (fiber ONT) your network plugs into",
};

export function DeviceView() {
  const device = useLabStore((s) => (s.deviceViewId ? s.network.devices[s.deviceViewId] : undefined));
  const close = useLabStore((s) => s.closeDeviceView);
  useEffect(() => {
    // Esc first leaves full screen (handled by the page), then closes the view.
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !useLabStore.getState().mainMaximized && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);
  const kind = device && chassisKind(device.type);
  if (!device || !kind) return null;
  return <Stage key={device.id} device={device} kind={kind} onClose={close} />;
}

function Stage({ device, kind, onClose }: { device: Device; kind: ChassisKind; onClose: () => void }) {
  const net = useLabStore((s) => s.network);
  const ports = useMemo(() => portViews(device, net), [device, net]);
  const cpu = useMemo(() => (kind === "switch" ? cpuView(device) : undefined), [device, kind]);
  const mgmt = device.interfaces.find((i) => i.management);
  const [sel, setSel] = useState<string | undefined>(() => (ports.find((p) => p.peer) ?? ports[0])?.id);
  const selected = ports.find((p) => p.id === sel);
  const { W, H, D } = SIZE[kind];
  const host = kind === "pc" || kind === "server" || kind === "internet";

  const [shot, setShot] = useState<Shot>("angled");
  const maximized = useLabStore((s) => s.mainMaximized);
  const setMaximized = useLabStore((s) => s.setMainMaximized);
  const [silver, setSilver] = useState(false);
  const [dark, setDark] = useState(false);
  const [sound, setSound] = useState(true);
  const [beacon, setBeacon] = useState(false);
  const [oledPage, setOledPage] = useState(0);
  const rot = SHOTS[shot];

  // Activity: a port's LED blinks (and a dot runs along its trace) when its frame
  // counters moved in the last 150 ms. The CPU path: switch = more traps; others = any port.
  const last = useRef<Record<string, number>>({});
  const lastCpu = useRef(-1);
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
      if (kind === "switch") {
        const trapped = cpuView(d).totalTrapped;
        setCpuActive(lastCpu.current >= 0 && trapped !== lastCpu.current);
        lastCpu.current = trapped;
      } else setCpuActive(next.size > 0);
    }, 150);
    return () => clearInterval(t);
  }, [device.id, kind]);

  // Fit the fixed-size box into the space it has — both width and height — leaving
  // room for the inspectors, so it never spills over the terminal on small screens.
  const rootRef = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState({ w: 1200, h: 700 });
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setRoom({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const HEADER = 58;
  const MIN_PANELS = 150;
  const wanted = shot === "inside" ? D * 0.95 + 60 : H + 190; // projected box height at scale 1
  const scale = Math.max(0.2, Math.min(1, (room.w - 32) / W, (room.h - HEADER - MIN_PANELS) / wanted));

  const linksUp = ports.filter((p) => p.oper === "up").length;

  // Packet animation: the current hop of the last command, if it enters or leaves this device.
  const player = usePacketPlayer();
  const hop = player.hop;
  const devPacket: DevicePacket | undefined = !hop
    ? undefined
    : hop.toDeviceId === device.id
      ? { hop, ifaceId: hop.toIfaceId, dir: "in", cpu: hopUsesCpu(device, hop, "in"), ms: player.hopMs, animKey: `${hop.id}-${player.run}` }
      : hop.fromDeviceId === device.id
        ? { hop, ifaceId: hop.fromIfaceId, dir: "out", cpu: hopUsesCpu(device, hop, "out"), ms: player.hopMs, animKey: `${hop.id}-${player.run}` }
        : undefined;

  const face: FaceProps = {
    device,
    ports,
    active,
    sel,
    onSelect: setSel,
    beacon,
    mgmt: mgmt ? { id: mgmt.id, up: mgmt.operState === "up", peer: peerOf(net, device, mgmt)?.deviceName, active: active.has(mgmt.id) } : undefined,
    packets: devPacket ? { [devPacket.ifaceId]: { label: devPacket.hop.label, color: devPacket.hop.color, dir: devPacket.dir, ms: devPacket.ms, key: devPacket.animKey } } : undefined,
  };
  const mgmtIp = mgmt?.ipv4[0]?.address ?? "—";
  const oled: [string, string, string] =
    oledPage === 1 ? ["MGMT eth0", mgmtIp, `LINKS ${linksUp}/${ports.length}`] : oledPage === 2 ? ["CPU (hostif)", `${cpu?.totalTrapped ?? 0} pkts`, "trapped total"] : [device.name.toUpperCase(), "SONiC", `LINKS ${linksUp}/${ports.length}`];
  const stageH = Math.max(120, wanted * scale);

  return (
    <div ref={rootRef} className={`absolute inset-0 z-40 flex flex-col overflow-hidden ${dark ? "bg-[#030406]" : "bg-[#0b0d11]"}`} role="dialog" aria-label={`${device.name} hardware view`}>
      <style>{CSS}</style>
      <div className="flex flex-wrap items-center gap-2 border-b border-edge px-4 py-2">
        <div className="mr-auto">
          <div className="text-sm font-semibold text-[#e6edf3]">
            {device.name}{" "}
            <span className="ml-1 rounded bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[10px] text-emerald-400">
              {linksUp}/{ports.length} links up
            </span>
          </div>
          <div className="text-[11px] text-[#6b7789]">{KIND_LABEL[kind]} · live — click a port to inspect it</div>
        </div>
        <Seg
          value={shot}
          options={[
            ["face", kind === "pc" || kind === "server" ? "Rear panel" : "Front"],
            ["angled", "Angled"],
            ["inside", "Inside"],
          ]}
          onChange={(v) => setShot(v as Shot)}
        />
        {!host && <Btn onClick={() => setSilver(!silver)}>{silver ? "Silver" : "Gunmetal"}</Btn>}
        <Btn onClick={() => setDark(!dark)}>{dark ? "Dark rack" : "Studio light"}</Btn>
        {!host && (
          <Btn onClick={() => setBeacon(!beacon)} title="Blink the blue locator LED">
            {beacon ? "Locator on" : "Locator"}
          </Btn>
        )}
        <Btn onClick={() => setSound(!sound)} title="Cable click sounds">
          {sound ? "🔊" : "🔇"}
        </Btn>
        <Btn onClick={() => setMaximized(!maximized)} title={maximized ? "Restore (Esc)" : "Full screen"}>
          {maximized ? "⤡ Restore" : "⤢ Full screen"}
        </Btn>
        <Btn onClick={onClose} title="Close (Esc)">
          ✕
        </Btn>
      </div>

      {player.hops.length > 0 && (
        <div className="absolute left-1/2 top-[64px] z-10 w-[min(760px,92%)] -translate-x-1/2">
          <PacketCaption p={player} idleHint="" />
        </div>
      )}
      <div className="sw-stage relative flex shrink-0 items-center justify-center overflow-hidden" style={{ height: stageH }}>
        <div style={{ transform: `scale(${scale})`, perspective: 1600 }}>
          <div className={`sw-box ${silver ? "sw-silver" : ""} ${dark ? "sw-dark" : ""}`} style={{ width: W, height: H, transform: `rotateX(${-rot.rx}deg) rotateY(${rot.ry}deg)` }}>
            <div className="sw-face" style={{ width: W, height: H, transform: `translateZ(${D / 2}px)` }}>
              {kind === "switch" ? (
                <SwitchFace {...face} oled={oled} onOled={() => setOledPage((oledPage + 1) % 3)} />
              ) : kind === "router" ? (
                <RouterFace {...face} />
              ) : kind === "pc" ? (
                <PcRear {...face} />
              ) : kind === "internet" ? (
                <InternetFace {...face} />
              ) : (
                <ServerRear {...face} />
              )}
            </div>
            <div className="sw-face" style={{ width: W, height: D, top: (H - D) / 2, transform: `rotateX(90deg) translateZ(${H / 2}px)` }}>
              {shot === "inside" && kind === "internet" ? (
                <InternetInternals W={W} D={D} ports={ports} active={active} packet={devPacket} />
              ) : shot === "inside" && kind !== "internet" ? (
                <Internals kind={kind} W={W} D={D} ports={ports} active={active} cpuActive={cpuActive} cpu={cpu} mgmtActive={face.mgmt?.active ?? false} hasMgmt={!!mgmt} mgmtId={mgmt?.id} sel={sel} packet={devPacket} />
              ) : (
                <div className={kind === "internet" ? "sw-lid sw-ont" : host ? "sw-lid sw-steel" : "sw-lid"} />
              )}
            </div>
            <div className="sw-face sw-side" style={{ width: D, height: H, left: (W - D) / 2, transform: `rotateY(90deg) translateZ(${W / 2}px)` }} />
            <div className="sw-face sw-side" style={{ width: D, height: H, left: (W - D) / 2, transform: `rotateY(-90deg) translateZ(${W / 2}px)` }} />
          </div>
        </div>
      </div>

      <div className="grid flex-1 grid-cols-1 gap-3 overflow-y-auto p-3 lg:grid-cols-12">
        <div className="lg:col-span-7">{selected ? <PortInspector device={device} kind={kind} port={selected} sound={sound} /> : <div className="text-[12px] text-[#6b7789]">This device has no network ports.</div>}</div>
        <div className="lg:col-span-5">
          {kind === "switch" && cpu ? (
            <CpuPanel cpu={cpu} />
          ) : kind === "router" ? (
            <RouterPanel routes={routeRows(device)} arp={hostView(device).arp} />
          ) : kind === "internet" ? (
            <HostPanel host={hostView(device)} title="The internet (upstream)" intro={INTERNET_INTRO} />
          ) : (
            <HostPanel host={hostView(device)} />
          )}
        </div>
      </div>
    </div>
  );
}
