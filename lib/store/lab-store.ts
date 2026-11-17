/**
 * The one network store (spec §61 single source of truth). The topology canvas,
 * inspector, terminal, timeline, and packet viewer all read and mutate this.
 *
 * Deep, in-place engine mutations (MAC/ARP learning, stats) are committed by
 * replacing the `network` reference with a fresh structuredClone so React
 * re-renders reliably.
 */
"use client";
import { create } from "zustand";
import { NetworkState, Connection, linkInterfaces, unlinkConnection, connectionFor } from "../models/topology";
import { Device, DeviceType } from "../models/device";
import { createDevice, rebuildConnectedRoutes, rebuildConnectedRoutes6 } from "../models/factory";
import { SONIC_FEATURES } from "../sonic/feature-registry";
import { addVlan, addMember } from "../models/vlan-ops";
import { Simulation, SimEvent, CaptureRecord } from "../engine";
import { execute, CommandContext, LineKind, OutputLine, LiveCaptureSpec } from "../commands";
import { compileFilter, FramePredicate } from "../commands/bpf";
import { formatCaptureRecord } from "../commands/tcpdump";
import { TrafficSpec, sendTrafficPacket, validateTrafficSpec, SendFailure } from "../protocols/traffic";
import { sflowAgentTick } from "../sflow/agent";
import { startCollector, stopCollector, resetCollector } from "../sflow/collector";
import { isSwitch } from "../models/device";
import { cliModeFor, runSonicCli, enterSonicCli, CliStack, cliPrompt } from "../commands/sonic-cli";

const CAPTURE_LIMIT = 800;

export interface TerminalLine {
  id: string;
  kind: "input" | "output";
  text: string;
  lineKind?: LineKind;
}

export interface ConnectResult {
  ok: boolean;
  error?: string;
}

interface Playback {
  index: number;
  playing: boolean;
}

interface LabState {
  network: NetworkState;
  labName: string;
  selectedDeviceId?: string;
  selectedEventId?: string;
  events: SimEvent[];
  captures: CaptureRecord[];
  terminals: Record<string, TerminalLine[]>;
  /** Per-device shell command history (persists when switching devices). */
  terminalHistory: Record<string, string[]>;
  /** Per-device sonic-cli mode stack ([] = bash). Switches default to sonic-cli. */
  cliMode: Record<string, CliStack>;
  playback: Playback;
  /** Running tcpdump sessions, one per device terminal. */
  liveCaptures: Record<string, LiveCaptureSession>;
  /** The traffic generator run (null when idle). */
  traffic: TrafficRun | null;
  /** Last sFlow agent export problems per switch (diagnostics for the monitor). */
  sflowErrors: Record<string, string[]>;
  terminalFocusNonce: number;
  deviceSeq: number;
  lineSeq: number;

  // selection
  selectDevice(id?: string): void;
  selectEvent(id?: string): void;

  // topology
  addDevice(type: DeviceType, position?: { x: number; y: number }, ports?: number): string;
  removeDevice(id: string): void;
  renameDevice(id: string, name: string): void;
  moveDevice(id: string, x: number, y: number): void;
  connect(aDeviceId: string, aIfaceId: string, bDeviceId: string, bIfaceId: string): ConnectResult;
  disconnect(connectionId: string): void;

  // interface / device config
  setInterfaceIp(deviceId: string, ifaceId: string, address: string, prefix: number): void;
  clearInterfaceIp(deviceId: string, ifaceId: string, address: string): void;
  setAdminState(deviceId: string, ifaceId: string, up: boolean): void;
  setDefaultGateway(deviceId: string, gateway: string | undefined): void;

  // terminal — the shell (Terminal.tsx) is the only caller.
  /** Run a command through the engine (updates network/events/captures) and
   *  return its output lines. Does NOT touch the terminal scrollback, so the
   *  shell can render/stream the output itself. */
  execCommand(deviceId: string, input: string): { output: OutputLine[]; clear: boolean };
  /** Append lines to a device's scrollback (persists across device switches). */
  appendTerminal(
    deviceId: string,
    entries: { text: string; kind: "input" | "output"; lineKind?: LineKind }[],
  ): void;
  /** Clear only the visible scrollback for a device (keeps history + network). */
  clearScreen(deviceId: string): void;
  /** Record a command in the device's history. */
  pushHistory(deviceId: string, command: string): void;
  openTerminal(): void;
  /** Ctrl+C on a running tcpdump: print the capture summary and end it. */
  stopLiveCapture(deviceId: string): void;
  /** Run KLISH lines on a switch from a fresh `exec` stack (GUI-driven config);
   *  the transcript is echoed into that switch's terminal. Returns error lines. */
  runCliScript(deviceId: string, lines: string[]): OutputLine[];

  // traffic generator + sFlow agent (wall-clock driven)
  /** Start generating traffic; returns an error message or null. */
  startTraffic(spec: TrafficSpec): string | null;
  stopTraffic(): void;
  /** One hsflowd tick on every switch (counter polling + datagram export). */
  sflowTick(): void;
  setCollector(deviceId: string, listening: boolean, port: number): void;
  clearCollector(deviceId: string): void;
  /** Host config helper: put a switch port in an access VLAN (creating it). */
  setAccessVlan(deviceId: string, ifaceId: string, vlan: number): void;

  // timeline playback
  setPlaybackIndex(i: number): void;
  play(): void;
  pause(): void;
  stepNext(): void;
  stepPrev(): void;
  clearTimeline(): void;

  // lab lifecycle (spec §45)
  newLab(): void;
  loadSample(): void;
  /** SONiC VLAN feature lab: PC1/PC2 in VLAN10, PC3 in VLAN20 on one switch. */
  loadVlanLab(): void;
  /** Load a ready-to-use topology for a SONiC feature (bgp/ospf/ipvx/...). */
  loadFeatureLab(featureId: string): void;
  exportLab(): string;
  importLab(json: string): boolean;
}

export interface LiveCaptureSession {
  spec: LiveCaptureSpec;
  matched: number;
}

export interface TrafficRun {
  spec: TrafficSpec;
  running: boolean;
  sent: number;
  failed: number;
  lastFailure?: SendFailure;
  /** Drop / unreachable events the engine raised for this run, with counts. */
  drops: Record<string, number>;
  startedAtMs: number;
  /** Destination host counters at start, to report deltas. */
  dstBaseline?: { deviceId: string; packets: number };
}

/** Compiled tcpdump filters (functions stay out of the serializable state). */
const capturePredicates = new Map<string, FramePredicate>();
let trafficTimer: ReturnType<typeof setTimeout> | null = null;
/** Cap on packets simulated per generator tick (keeps the UI responsive). */
const TRAFFIC_BATCH_MAX = 200;

const TYPE_SHORT: Record<DeviceType, string> = {
  pc: "PC",
  server: "SRV",
  switch: "SW",
  router: "R",
  firewall: "FW",
  internet: "NET",
  "dns-server": "DNS",
  "dhcp-server": "DHCP",
  "ntp-server": "NTP",
};

function nextName(network: NetworkState, type: DeviceType): string {
  const short = TYPE_SHORT[type];
  const count = Object.values(network.devices).filter((d) => d.type === type).length;
  return `${short}${count + 1}`;
}

export const useLabStore = create<LabState>((set, get) => {
  const summary = (n: number) => [
    { text: "", kind: "output" as const },
    { text: `${n} packet${n === 1 ? "" : "s"} captured`, kind: "output" as const, lineKind: "muted" as LineKind },
    { text: `${n} packet${n === 1 ? "" : "s"} received by filter`, kind: "output" as const, lineKind: "muted" as LineKind },
    { text: "0 packets dropped by kernel", kind: "output" as const, lineKind: "muted" as LineKind },
  ];

  /** Stream newly recorded frames into every running tcpdump session. */
  const feedCaptures = (fresh: CaptureRecord[]) => {
    const sessions = get().liveCaptures;
    const ids = Object.keys(sessions);
    if (!ids.length || !fresh.length) return;
    const next = { ...sessions };
    for (const id of ids) {
      const sess = { ...next[id] };
      const pred = capturePredicates.get(id);
      const dev = get().network.devices[id];
      if (!pred || !dev) continue;
      const out: { text: string; kind: "output" }[] = [];
      let done = false;
      for (const rec of fresh) {
        if (rec.deviceId !== id) continue;
        if (sess.spec.interfaceIds && !sess.spec.interfaceIds.includes(rec.interfaceId)) continue;
        if (!pred(rec.frame)) continue;
        for (const text of formatCaptureRecord(rec, dev, sess.spec)) out.push({ text, kind: "output" });
        sess.matched += 1;
        if (sess.spec.count && sess.matched >= sess.spec.count) {
          done = true;
          break;
        }
      }
      if (out.length) get().appendTerminal(id, out);
      if (done) {
        get().appendTerminal(id, summary(sess.matched));
        capturePredicates.delete(id);
        delete next[id];
      } else {
        next[id] = sess;
      }
    }
    set({ liveCaptures: next });
  };

  /** Run a wall-clock-stamped simulation on a draft and commit it. */
  const commitSim = <T,>(fn: (sim: Simulation, net: NetworkState) => T, timeline: boolean): T => {
    const state = get();
    const draft = structuredClone(state.network);
    const sim = new Simulation(draft, { wallBase: Date.now() });
    const value = fn(sim, draft);
    set({
      network: draft,
      captures: [...state.captures, ...sim.captures].slice(-CAPTURE_LIMIT),
      ...(timeline && sim.events.length
        ? { events: sim.events, playback: { index: 0, playing: false }, selectedEventId: undefined }
        : {}),
    });
    feedCaptures(sim.captures);
    return value;
  };

  const stopTrafficTimer = () => {
    if (trafficTimer) clearTimeout(trafficTimer);
    trafficTimer = null;
  };

  const trafficTick = () => {
    trafficTimer = null;
    const run = get().traffic;
    if (!run?.running) return;
    const { spec } = run;
    const remaining = spec.continuous ? Infinity : spec.count - run.sent - run.failed;
    if (remaining <= 0) {
      set({ traffic: { ...run, running: false } });
      return;
    }
    // Intervals under 50 ms are simulated as batches every 50 ms of wall time.
    const perTick = spec.intervalMs >= 50 ? 1 : spec.intervalMs === 0 ? TRAFFIC_BATCH_MAX : Math.round(50 / spec.intervalMs);
    const batch = Math.min(TRAFFIC_BATCH_MAX, remaining, Math.max(1, perTick));
    let sent = 0;
    let failed = 0;
    let lastFailure = run.lastFailure;
    const drops = { ...run.drops };
    commitSim((sim, net) => {
      const src = net.devices[spec.srcDeviceId];
      for (let k = 0; k < batch; k++) {
        const r = src ? sendTrafficPacket(sim, src, spec, run.sent + run.failed + k + 1) : { ok: false, reason: "no-device" as const };
        if (r.ok) sent += 1;
        else {
          failed += 1;
          lastFailure = r.reason;
        }
      }
      for (const e of sim.events) {
        if (e.type !== "FRAME_DROPPED" && e.type !== "ICMP_UNREACHABLE") continue;
        if (drops[e.message] !== undefined || Object.keys(drops).length < 8) drops[e.message] = (drops[e.message] ?? 0) + 1;
      }
    }, batch <= 5);
    const updated: TrafficRun = { ...run, sent: run.sent + sent, failed: run.failed + failed, lastFailure, drops };
    const finished = !spec.continuous && updated.sent + updated.failed >= spec.count;
    set({ traffic: { ...updated, running: !finished } });
    if (!finished) trafficTimer = setTimeout(trafficTick, Math.max(50, spec.intervalMs));
  };

  return {
  network: { devices: {}, connections: [] },
  labName: "Untitled Lab",
  events: [],
  captures: [],
  terminals: {},
  terminalHistory: {},
  cliMode: {},
  playback: { index: 0, playing: false },
  liveCaptures: {},
  traffic: null,
  sflowErrors: {},
  terminalFocusNonce: 0,
  deviceSeq: 1,
  lineSeq: 1,

  selectDevice(id) {
    set({ selectedDeviceId: id });
  },
  selectEvent(id) {
    set({ selectedEventId: id });
  },

  addDevice(type, position, ports) {
    const { network, deviceSeq } = get();
    const id = `dev${deviceSeq}`;
    const pos = position ?? { x: 120 + (deviceSeq % 5) * 160, y: 120 + Math.floor(deviceSeq / 5) * 140 };
    const device = createDevice({ id, type, name: nextName(network, type), x: pos.x, y: pos.y, ports });
    // Give each switch a distinct out-of-band management IP: the smallest unused
    // host in 192.168.100.0/24 among the mgmt IPs already assigned to switches.
    const mgmt = device.interfaces.find((i) => i.management);
    if (mgmt) {
      const used = new Set<string>();
      for (const d of Object.values(network.devices)) {
        for (const i of d.interfaces) {
          if (i.management) i.ipv4.forEach((a) => used.add(a.address));
        }
      }
      let host = 1;
      while (used.has(`192.168.100.${host}`)) host++;
      mgmt.ipv4 = [{ address: `192.168.100.${host}`, prefix: 24 }];
    }
    const next = structuredClone(network);
    next.devices[id] = device;
    set({ network: next, deviceSeq: deviceSeq + 1, selectedDeviceId: id });
    return id;
  },

  removeDevice(id) {
    const { network, terminals } = get();
    const next = structuredClone(network);
    // remove attached cables first
    next.connections = next.connections.filter((c) => {
      const touches = c.a.deviceId === id || c.b.deviceId === id;
      if (touches) {
        // clear the far-end cache
        const far = c.a.deviceId === id ? c.b : c.a;
        const dev = next.devices[far.deviceId];
        const iface = dev?.interfaces.find((i) => i.id === far.interfaceId);
        if (iface) {
          iface.connectedTo = undefined;
          iface.operState = "down";
        }
      }
      return !touches;
    });
    delete next.devices[id];
    const nextTerminals = { ...terminals };
    delete nextTerminals[id];
    const nextHistory = { ...get().terminalHistory };
    delete nextHistory[id];
    set({
      network: next,
      terminals: nextTerminals,
      terminalHistory: nextHistory,
      selectedDeviceId: get().selectedDeviceId === id ? undefined : get().selectedDeviceId,
    });
  },

  renameDevice(id, name) {
    const next = structuredClone(get().network);
    const dev = next.devices[id];
    if (dev) {
      dev.name = name;
      dev.config.hostname = name;
    }
    set({ network: next });
  },

  moveDevice(id, x, y) {
    const next = structuredClone(get().network);
    const dev = next.devices[id];
    if (dev) dev.ui = { x, y };
    set({ network: next });
  },

  connect(aDeviceId, aIfaceId, bDeviceId, bIfaceId) {
    const { network } = get();
    if (aDeviceId === bDeviceId && aIfaceId === bIfaceId) {
      return { ok: false, error: "Cannot connect an interface to itself" };
    }
    if (connectionFor(network, aDeviceId, aIfaceId)) {
      return { ok: false, error: "Source interface is already connected" };
    }
    if (connectionFor(network, bDeviceId, bIfaceId)) {
      return { ok: false, error: "Target interface is already connected" };
    }
    const next = structuredClone(network);
    linkInterfaces(next, { deviceId: aDeviceId, interfaceId: aIfaceId }, { deviceId: bDeviceId, interfaceId: bIfaceId });
    // connected routes may change once a link comes up
    for (const dev of [next.devices[aDeviceId], next.devices[bDeviceId]]) if (dev) rebuildConnectedRoutes(dev);
    set({ network: next });
    return { ok: true };
  },

  disconnect(connectionId) {
    const next = structuredClone(get().network);
    unlinkConnection(next, connectionId);
    for (const dev of Object.values(next.devices)) rebuildConnectedRoutes(dev);
    set({ network: next });
  },

  setInterfaceIp(deviceId, ifaceId, address, prefix) {
    const next = structuredClone(get().network);
    const iface = next.devices[deviceId]?.interfaces.find((i) => i.id === ifaceId);
    if (iface) {
      iface.ipv4 = [{ address, prefix }]; // MVP: single primary address per interface
      rebuildConnectedRoutes(next.devices[deviceId]);
    }
    set({ network: next });
  },

  clearInterfaceIp(deviceId, ifaceId, address) {
    const next = structuredClone(get().network);
    const iface = next.devices[deviceId]?.interfaces.find((i) => i.id === ifaceId);
    if (iface) {
      iface.ipv4 = iface.ipv4.filter((a) => a.address !== address);
      rebuildConnectedRoutes(next.devices[deviceId]);
    }
    set({ network: next });
  },

  setAdminState(deviceId, ifaceId, up) {
    const next = structuredClone(get().network);
    const dev = next.devices[deviceId];
    const iface = dev?.interfaces.find((i) => i.id === ifaceId);
    if (iface) {
      iface.adminState = up ? "up" : "down";
      iface.operState = up && iface.connectedTo ? "up" : "down";
      if (dev) rebuildConnectedRoutes(dev);
    }
    set({ network: next });
  },

  setDefaultGateway(deviceId, gateway) {
    const next = structuredClone(get().network);
    const dev = next.devices[deviceId];
    if (dev) {
      dev.config.defaultGateway = gateway || undefined;
      rebuildConnectedRoutes(dev);
    }
    set({ network: next });
  },

  execCommand(deviceId, input) {
    const state = get();
    const draft = structuredClone(state.network);
    const device = draft.devices[deviceId];
    if (!device) return { output: [], clear: false };

    const captures = [...state.captures];
    const fresh: CaptureRecord[] = [];
    const ctx: CommandContext = {
      device,
      network: draft,
      captures,
      runSim(fn) {
        const sim = new Simulation(draft, { wallBase: Date.now() });
        const value = fn(sim);
        captures.push(...sim.captures);
        fresh.push(...sim.captures);
        return { value, events: sim.events };
      },
    };

    // Route through sonic-cli when the device is in a modal CLI mode; otherwise
    // the plain bash/Click shell. `sonic-cli` at the bash prompt enters the CLI.
    // tcpdump is a Linux process: it always runs through the shell path so it
    // can stay attached to the terminal.
    const capture = /^(sudo\s+)?tcpdump\b/.test(input.trim());
    const stack = capture ? [] : cliModeFor(device, state.cliMode[deviceId]);
    let output: OutputLine[];
    let clear = false;
    let events;
    let nextStack: CliStack | undefined = state.cliMode[deviceId];
    let live: LiveCaptureSpec | undefined;

    if (stack.length === 0) {
      if (input.trim() === "sonic-cli") {
        const r = enterSonicCli();
        output = r.output;
        nextStack = r.stack;
      } else {
        const result = execute(input, ctx);
        output = result.output;
        clear = !!result.clear;
        events = result.events;
        live = result.liveCapture;
      }
    } else {
      const r = runSonicCli(input, stack, ctx);
      output = r.output;
      clear = !!r.clear;
      events = r.events;
      nextStack = r.toBash ? [] : r.stack;
    }

    // Side effects only — the shell renders the output itself (possibly streamed).
    set({
      network: draft,
      captures: captures.slice(-CAPTURE_LIMIT),
      events: events ?? state.events,
      selectedEventId: events ? undefined : state.selectedEventId,
      playback: events ? { index: 0, playing: false } : state.playback,
      cliMode: nextStack === undefined ? state.cliMode : { ...state.cliMode, [deviceId]: nextStack },
    });
    feedCaptures(fresh);
    if (live) {
      capturePredicates.set(deviceId, compileFilter(live.filter));
      set({ liveCaptures: { ...get().liveCaptures, [deviceId]: { spec: live, matched: 0 } } });
    }

    return { output, clear };
  },

  runCliScript(deviceId, lines) {
    const draft = structuredClone(get().network);
    const device = draft.devices[deviceId];
    if (!device) return [];
    const ctx: CommandContext = {
      device,
      network: draft,
      captures: [],
      runSim(fn) {
        const sim = new Simulation(draft, { wallBase: Date.now() });
        return { value: fn(sim), events: sim.events };
      },
    };
    const user = device.config.hostname.toLowerCase().replace(/\s+/g, "-");
    const transcript: { text: string; kind: "input" | "output"; lineKind?: LineKind }[] = [
      { text: "# applied from the sFlow tab", kind: "output", lineKind: "muted" },
    ];
    const errors: OutputLine[] = [];
    let stack: CliStack = ["exec"];
    for (const l of lines) {
      transcript.push({ text: `${cliPrompt(stack, user)} ${l}`, kind: "input" });
      const r = runSonicCli(l, stack, ctx);
      for (const o of r.output) {
        transcript.push({ text: o.text, kind: "output", lineKind: o.kind });
        if (o.kind === "error") errors.push(o);
      }
      stack = r.toBash ? ["exec"] : r.stack;
    }
    set({ network: draft });
    get().appendTerminal(deviceId, transcript);
    return errors;
  },

  stopLiveCapture(deviceId) {
    const sess = get().liveCaptures[deviceId];
    if (!sess) return;
    capturePredicates.delete(deviceId);
    const next = { ...get().liveCaptures };
    delete next[deviceId];
    set({ liveCaptures: next });
    get().appendTerminal(deviceId, summary(sess.matched));
  },

  startTraffic(spec) {
    const error = validateTrafficSpec(spec);
    if (error) return error;
    const src = get().network.devices[spec.srcDeviceId];
    if (!src) return "select a source host";
    if (isSwitch(src.type)) return "the source must be a host, not a switch";
    stopTrafficTimer();
    set({ traffic: { spec, running: true, sent: 0, failed: 0, drops: {}, startedAtMs: Date.now() } });
    trafficTick();
    return null;
  },

  stopTraffic() {
    stopTrafficTimer();
    const run = get().traffic;
    if (run) set({ traffic: { ...run, running: false } });
  },

  sflowTick() {
    const switches = Object.values(get().network.devices).filter(
      (d) => isSwitch(d.type) && ((d.config.features?.sflow as { enabled?: boolean } | undefined)?.enabled || d.config.features?.["sflow-agent"]),
    );
    if (!switches.length) return;
    // Dry-run on a throwaway copy first so idle seconds don't re-render the app.
    const probe = structuredClone(get().network);
    const probeSim = new Simulation(probe, { wallBase: Date.now() });
    const now = Date.now();
    let changed = false;
    for (const d of switches) {
      const before = JSON.stringify(d.config.features?.["sflow-agent"] ?? null);
      const r = sflowAgentTick(probeSim, probe.devices[d.id], now);
      if (r.datagrams || r.errors.length || JSON.stringify(probe.devices[d.id].config.features?.["sflow-agent"] ?? null) !== before) changed = true;
    }
    if (!changed) return;
    const errors: Record<string, string[]> = {};
    commitSim((sim, net) => {
      for (const d of switches) errors[d.id] = sflowAgentTick(sim, net.devices[d.id], now).errors;
    }, false);
    set({ sflowErrors: { ...get().sflowErrors, ...errors } });
  },

  setCollector(deviceId, listening, port) {
    const next = structuredClone(get().network);
    const dev = next.devices[deviceId];
    if (!dev) return;
    if (listening) startCollector(dev, port);
    else stopCollector(dev);
    set({ network: next });
  },

  clearCollector(deviceId) {
    const next = structuredClone(get().network);
    const dev = next.devices[deviceId];
    if (!dev) return;
    resetCollector(dev);
    set({ network: next });
  },

  setAccessVlan(deviceId, ifaceId, vlan) {
    const next = structuredClone(get().network);
    const dev = next.devices[deviceId];
    const iface = dev?.interfaces.find((i) => i.id === ifaceId);
    if (!dev || !iface) return;
    addVlan(dev, vlan);
    addMember(dev, vlan, iface.name, false);
    set({ network: next });
  },

  appendTerminal(deviceId, entries) {
    if (entries.length === 0) return;
    const state = get();
    let seq = state.lineSeq;
    const prior = state.terminals[deviceId] ?? [];
    const lines: TerminalLine[] = entries.map((e) => ({
      id: `l${seq++}`,
      kind: e.kind,
      text: e.text,
      lineKind: e.lineKind,
    }));
    set({
      terminals: { ...state.terminals, [deviceId]: [...prior, ...lines] },
      lineSeq: seq,
    });
  },

  clearScreen(deviceId) {
    const state = get();
    set({ terminals: { ...state.terminals, [deviceId]: [] } });
  },

  pushHistory(deviceId, command) {
    const state = get();
    const prior = state.terminalHistory[deviceId] ?? [];
    if (prior[prior.length - 1] === command) return; // skip consecutive dupes
    set({ terminalHistory: { ...state.terminalHistory, [deviceId]: [...prior, command] } });
  },

  openTerminal() {
    set({ terminalFocusNonce: get().terminalFocusNonce + 1 });
  },

  setPlaybackIndex(i) {
    const max = get().events.length;
    set({ playback: { ...get().playback, index: Math.max(0, Math.min(i, max)) } });
  },
  play() {
    if (get().events.length === 0) return;
    const atEnd = get().playback.index >= get().events.length;
    set({ playback: { index: atEnd ? 0 : get().playback.index, playing: true } });
  },
  pause() {
    set({ playback: { ...get().playback, playing: false } });
  },
  stepNext() {
    const { playback, events } = get();
    set({ playback: { index: Math.min(playback.index + 1, events.length), playing: false } });
  },
  stepPrev() {
    const { playback } = get();
    set({ playback: { index: Math.max(playback.index - 1, 0), playing: false } });
  },
  clearTimeline() {
    set({ events: [], playback: { index: 0, playing: false }, selectedEventId: undefined });
  },

  newLab() {
    stopTrafficTimer();
    capturePredicates.clear();
    set({
      liveCaptures: {},
      traffic: null,
      sflowErrors: {},
      network: { devices: {}, connections: [] },
      labName: "Untitled Lab",
      events: [],
      captures: [],
      terminals: {},
      terminalHistory: {},
      cliMode: {},
      selectedDeviceId: undefined,
      selectedEventId: undefined,
      playback: { index: 0, playing: false },
      deviceSeq: 1,
    });
  },

  loadSample() {
    get().newLab();
    const pc1 = get().addDevice("pc", { x: 120, y: 120 });
    const sw1 = get().addDevice("switch", { x: 400, y: 260 }, 4);
    const pc2 = get().addDevice("pc", { x: 680, y: 120 });
    get().setInterfaceIp(pc1, `${pc1}-if0`, "192.168.100.100", 24);
    get().setInterfaceIp(pc2, `${pc2}-if0`, "192.168.100.101", 24);
    get().connect(pc1, `${pc1}-if0`, sw1, `${sw1}-if0`);
    get().connect(pc2, `${pc2}-if0`, sw1, `${sw1}-if1`);
    set({ labName: "PC1 — SW1 — PC2", selectedDeviceId: pc1 });
  },

  loadVlanLab() {
    get().newLab();
    const pc1 = get().addDevice("pc", { x: 100, y: 80 });
    const pc2 = get().addDevice("pc", { x: 100, y: 240 });
    const pc3 = get().addDevice("pc", { x: 100, y: 400 });
    const sw1 = get().addDevice("switch", { x: 440, y: 240 }, 4);
    // Same IP subnet on purpose — VLANs, not IP, provide the isolation lesson.
    get().setInterfaceIp(pc1, `${pc1}-if0`, "10.0.0.1", 24);
    get().setInterfaceIp(pc2, `${pc2}-if0`, "10.0.0.2", 24);
    get().setInterfaceIp(pc3, `${pc3}-if0`, "10.0.0.3", 24);
    get().connect(pc1, `${pc1}-if0`, sw1, `${sw1}-if0`);
    get().connect(pc2, `${pc2}-if0`, sw1, `${sw1}-if1`);
    get().connect(pc3, `${pc3}-if0`, sw1, `${sw1}-if2`);

    // Configure VLANs on the switch (PC1/PC2 → VLAN10, PC3 → VLAN20).
    const next = structuredClone(get().network);
    const sw = next.devices[sw1];
    addVlan(sw, 10);
    addVlan(sw, 20);
    addMember(sw, 10, "Ethernet0", false);
    addMember(sw, 10, "Ethernet1", false);
    addMember(sw, 20, "Ethernet2", false);
    set({
      network: next,
      labName: "VLAN Lab — PC1/PC2 VLAN10, PC3 VLAN20",
      selectedDeviceId: sw1,
    });
  },

  loadFeatureLab(featureId) {
    // Print a short "what to try" guide into the selected device's terminal.
    const hint = (deviceId: string, lines: string[]) =>
      get().appendTerminal(
        deviceId,
        lines.map((text, i) => ({
          text,
          kind: "output" as const,
          lineKind: (i === 0 ? "heading" : "muted") as LineKind,
        })),
      );

    // Two routers back-to-back with a PC on each side — the base for L3 labs.
    const twoRouterCore = () => {
      get().newLab();
      const pc1 = get().addDevice("pc", { x: 60, y: 140 });
      const r1 = get().addDevice("router", { x: 320, y: 140 }, 2);
      const r2 = get().addDevice("router", { x: 580, y: 140 }, 2);
      const pc2 = get().addDevice("pc", { x: 840, y: 140 });
      get().setInterfaceIp(pc1, `${pc1}-if0`, "10.1.1.10", 24);
      get().setDefaultGateway(pc1, "10.1.1.1");
      get().setInterfaceIp(r1, `${r1}-if0`, "10.1.1.1", 24);
      get().setInterfaceIp(r1, `${r1}-if1`, "10.0.0.1", 30);
      get().setInterfaceIp(r2, `${r2}-if0`, "10.0.0.2", 30);
      get().setInterfaceIp(r2, `${r2}-if1`, "10.2.2.1", 24);
      get().setInterfaceIp(pc2, `${pc2}-if0`, "10.2.2.10", 24);
      get().setDefaultGateway(pc2, "10.2.2.1");
      get().connect(pc1, `${pc1}-if0`, r1, `${r1}-if0`);
      get().connect(r1, `${r1}-if1`, r2, `${r2}-if0`);
      get().connect(r2, `${r2}-if1`, pc2, `${pc2}-if0`);
      return { pc1, r1, r2, pc2 };
    };

    switch (featureId) {
      case "vlan":
        get().loadVlanLab();
        return;

      case "sflow": {
        // Mirrors the live SONiC-VS bench: H1/H2 on 25G Ethernet0/1 in VLAN 100,
        // collector on the out-of-band management network (eth0).
        get().newLab();
        const h1 = get().addDevice("pc", { x: 60, y: 60 });
        const h2 = get().addDevice("pc", { x: 60, y: 360 });
        const sw = get().addDevice("switch", { x: 380, y: 210 }, 4);
        const col = get().addDevice("server", { x: 640, y: 40 });
        const net = structuredClone(get().network);
        for (const p of net.devices[sw].interfaces) if (!p.management && !p.logical) p.speed = 25000;
        net.devices[col].name = "COLLECTOR";
        net.devices[col].config.hostname = "collector";
        set({ network: net });
        get().setInterfaceIp(h1, `${h1}-if0`, "192.168.100.11", 24);
        get().setInterfaceIp(h2, `${h2}-if0`, "192.168.100.12", 24);
        get().setInterfaceIp(sw, `${sw}-mgmt`, "192.168.200.204", 24);
        get().setInterfaceIp(col, `${col}-if0`, "192.168.200.16", 24);
        get().connect(h1, `${h1}-if0`, sw, `${sw}-if0`);
        get().connect(h2, `${h2}-if0`, sw, `${sw}-if1`);
        get().connect(col, `${col}-if0`, sw, `${sw}-mgmt`);
        get().setAccessVlan(sw, `${sw}-if0`, 100);
        get().setAccessVlan(sw, `${sw}-if1`, 100);
        get().setCollector(col, true, 6343);
        set({ labName: "sFlow: H1/H2 — SW (VLAN 100) — collector on eth0", selectedDeviceId: sw });
        hint(sw, [
          "sFlow lab — configure the agent, generate traffic, watch the collector",
          "1. configure terminal → sflow enable → sflow collector 192.168.200.16 6343",
          "   sflow polling-interval 5 → interface Ethernet 0 → sflow sampling-rate 256",
          "   (or use the sFlow tab → 'Apply to switch')",
          "2. exit to bash and run: sudo tcpdump -i any -nn port 6343   (Ctrl+C stops)",
          "3. Traffic tab: H1 → 192.168.100.12, UDP, e.g. 2000 packets",
          "4. sFlow tab: datagrams / FLOW / COUNTER samples decoded at COLLECTOR",
        ]);
        return;
      }

      case "bgp": {
        const { r1, r2 } = twoRouterCore();
        const next = structuredClone(get().network);
        next.devices[r1].config.features = {
          bgp: { localAs: 65001, routerId: "1.1.1.1", neighbors: [{ peer: "10.0.0.2", remoteAs: 65002 }], networks: ["10.1.1.0/24"] },
        };
        next.devices[r2].config.features = {
          bgp: { localAs: 65002, routerId: "2.2.2.2", neighbors: [{ peer: "10.0.0.1", remoteAs: 65001 }], networks: ["10.2.2.0/24"] },
        };
        set({ network: next, labName: "BGP Lab — AS65001 ↔ AS65002", selectedDeviceId: r1 });
        hint(r1, ["BGP lab: R1 (AS65001) ↔ R2 (AS65002).", "Try:  bgp converge", "      show ip bgp summary", "Then ping 10.2.2.10 from PC1."]);
        return;
      }

      case "ospf": {
        const { r1, r2 } = twoRouterCore();
        const next = structuredClone(get().network);
        const nets = (a: string) => [
          { network: a, area: "0.0.0.0" },
          { network: "10.0.0.0/30", area: "0.0.0.0" },
        ];
        next.devices[r1].config.features = { ospf: { routerId: "1.1.1.1", networks: nets("10.1.1.0/24") } };
        next.devices[r2].config.features = { ospf: { routerId: "2.2.2.2", networks: nets("10.2.2.0/24") } };
        set({ network: next, labName: "OSPF Lab — area 0.0.0.0", selectedDeviceId: r1 });
        hint(r1, ["OSPF lab: R1 ↔ R2 in area 0.0.0.0.", "Try:  ospf converge", "      show ip ospf neighbor", "Then ping 10.2.2.10 from PC1."]);
        return;
      }

      case "staticroute": {
        const { r1 } = twoRouterCore();
        set({ labName: "Static Route Lab — two routers, no routing protocol", selectedDeviceId: r1 });
        hint(r1, ["Static-route lab: R1 ↔ R2 (no routing protocol yet).", "Add on R1:  config route add prefix 10.2.2.0/24 nexthop 10.0.0.2", "Add on R2:  config route add prefix 10.1.1.0/24 nexthop 10.0.0.1", "Then ping 10.2.2.10 from PC1."]);
        return;
      }

      case "ipvx": {
        get().newLab();
        const pc1 = get().addDevice("pc", { x: 120, y: 140 });
        const sw1 = get().addDevice("switch", { x: 440, y: 260 }, 4);
        const pc2 = get().addDevice("pc", { x: 760, y: 140 });
        get().connect(pc1, `${pc1}-if0`, sw1, `${sw1}-if0`);
        get().connect(pc2, `${pc2}-if0`, sw1, `${sw1}-if1`);
        const next = structuredClone(get().network);
        next.devices[pc1].interfaces[0].ipv6 = [{ address: "2001:db8::1", prefix: 64 }];
        next.devices[pc2].interfaces[0].ipv6 = [{ address: "2001:db8::2", prefix: 64 }];
        rebuildConnectedRoutes6(next.devices[pc1]);
        rebuildConnectedRoutes6(next.devices[pc2]);
        set({ network: next, labName: "IPv6 Lab — 2001:db8::/64", selectedDeviceId: pc1 });
        hint(pc1, ["IPv6 lab: PC1 2001:db8::1, PC2 2001:db8::2.", "Try:  ping6 2001:db8::2", "      ip -6 neigh"]);
        return;
      }

      case "ntp": {
        get().newLab();
        const pc1 = get().addDevice("pc", { x: 160, y: 160 });
        const ntp = get().addDevice("ntp-server", { x: 540, y: 160 });
        get().setInterfaceIp(pc1, `${pc1}-if0`, "192.168.100.100", 24);
        get().setInterfaceIp(ntp, `${ntp}-if0`, "192.168.100.10", 24);
        get().connect(pc1, `${pc1}-if0`, ntp, `${ntp}-if0`);
        set({ labName: "NTP Lab — client ↔ ntp-server", selectedDeviceId: pc1 });
        hint(pc1, ["NTP lab: client ↔ ntp-server (192.168.100.10).", "Try:  ntpdate 192.168.100.10"]);
        return;
      }

      case "ntp-upstream": {
        // NTP to a PUBLIC upstream reached over the network (routing), not cabled
        // to the switch — client → router → internet (answers any public IP).
        get().newLab();
        const pc1 = get().addDevice("pc", { x: 60, y: 160 });
        const r1 = get().addDevice("router", { x: 340, y: 160 }, 2);
        const inet = get().addDevice("internet", { x: 640, y: 160 });
        get().setInterfaceIp(pc1, `${pc1}-if0`, "192.168.1.10", 24);
        get().setDefaultGateway(pc1, "192.168.1.1");
        get().setInterfaceIp(r1, `${r1}-if0`, "192.168.1.1", 24);
        get().setInterfaceIp(r1, `${r1}-if1`, "203.0.113.1", 30);
        get().setInterfaceIp(inet, `${inet}-if0`, "203.0.113.2", 30);
        get().connect(pc1, `${pc1}-if0`, r1, `${r1}-if0`);
        get().connect(r1, `${r1}-if1`, inet, `${inet}-if0`);
        const next = structuredClone(get().network);
        next.devices[r1].routingTable.push({ destination: "0.0.0.0", prefix: 0, nextHop: "203.0.113.2", interfaceId: `${r1}-if1`, type: "static", metric: 1 });
        next.devices[inet].routingTable.push({ destination: "0.0.0.0", prefix: 0, nextHop: "203.0.113.1", interfaceId: `${inet}-if0`, type: "static", metric: 1 });
        set({ network: next, labName: "NTP Upstream Lab — client → router → internet (public NTP)", selectedDeviceId: pc1 });
        hint(pc1, ["NTP over the network: the upstream is a PUBLIC IP reached via routing (not cabled to the switch).", "Try:  ntpdate 216.239.35.0    (answered by the internet upstream)", "      ping 8.8.8.8"]);
        return;
      }

      case "dns": {
        // Direct DNS: client resolves names via a dns-server on the subnet (A records).
        get().newLab();
        const pc1 = get().addDevice("pc", { x: 160, y: 160 });
        const dns = get().addDevice("dns-server", { x: 540, y: 160 });
        get().setInterfaceIp(pc1, `${pc1}-if0`, "10.0.0.2", 24);
        get().setInterfaceIp(dns, `${dns}-if0`, "10.0.0.53", 24);
        get().connect(pc1, `${pc1}-if0`, dns, `${dns}-if0`);
        const next = structuredClone(get().network);
        next.devices[pc1].config.features = { dns: { nameservers: ["10.0.0.53"] } };
        next.devices[dns].config.features = { dnsRecords: { "server1.lab": "10.0.0.9", "www.lab": "10.0.0.80" } };
        set({ network: next, labName: "DNS Lab — client ↔ dns-server (A records)", selectedDeviceId: pc1 });
        hint(pc1, ["DNS lab: client resolves via dns-server 10.0.0.53.", "Try:  nslookup server1.lab   (→ 10.0.0.9)", "      nslookup www.lab       (→ 10.0.0.80)"]);
        return;
      }

      case "dns-upstream": {
        // Public DNS reached over the network (nameserver 8.8.8.8 via the internet).
        get().newLab();
        const pc1 = get().addDevice("pc", { x: 60, y: 160 });
        const r1 = get().addDevice("router", { x: 340, y: 160 }, 2);
        const inet = get().addDevice("internet", { x: 640, y: 160 });
        get().setInterfaceIp(pc1, `${pc1}-if0`, "192.168.1.10", 24);
        get().setDefaultGateway(pc1, "192.168.1.1");
        get().setInterfaceIp(r1, `${r1}-if0`, "192.168.1.1", 24);
        get().setInterfaceIp(r1, `${r1}-if1`, "203.0.113.1", 30);
        get().setInterfaceIp(inet, `${inet}-if0`, "203.0.113.2", 30);
        get().connect(pc1, `${pc1}-if0`, r1, `${r1}-if0`);
        get().connect(r1, `${r1}-if1`, inet, `${inet}-if0`);
        const next = structuredClone(get().network);
        next.devices[pc1].config.features = { dns: { nameservers: ["8.8.8.8"] } };
        next.devices[r1].routingTable.push({ destination: "0.0.0.0", prefix: 0, nextHop: "203.0.113.2", interfaceId: `${r1}-if1`, type: "static", metric: 1 });
        next.devices[inet].routingTable.push({ destination: "0.0.0.0", prefix: 0, nextHop: "203.0.113.1", interfaceId: `${inet}-if0`, type: "static", metric: 1 });
        set({ network: next, labName: "DNS Upstream Lab — client → router → internet (public DNS 8.8.8.8)", selectedDeviceId: pc1 });
        hint(pc1, ["Public DNS over the network (nameserver 8.8.8.8, reached via routing).", "Try:  nslookup google.com", "      ping google.com   (resolves via DNS, then pings via the internet)"]);
        return;
      }

      case "vrrp": {
        // Gateway redundancy: PC — SW1 — R1/R2 (VRRP VIP 10.0.0.1) — SW2 — SRV.
        // R1 priority 110 = Master, R2 100 = Backup; both VIPs fail over together.
        get().newLab();
        const pc1 = get().addDevice("pc", { x: 40, y: 180 });
        const sw1 = get().addDevice("switch", { x: 240, y: 180 }, 4);
        const r1 = get().addDevice("router", { x: 440, y: 90 }, 2);
        const r2 = get().addDevice("router", { x: 440, y: 270 }, 2);
        const sw2 = get().addDevice("switch", { x: 640, y: 180 }, 4);
        const srv = get().addDevice("server", { x: 840, y: 180 });
        get().setInterfaceIp(pc1, `${pc1}-if0`, "10.0.0.10", 24);
        get().setDefaultGateway(pc1, "10.0.0.1"); // the VRRP VIP
        get().setInterfaceIp(r1, `${r1}-if0`, "10.0.0.2", 24);
        get().setInterfaceIp(r1, `${r1}-if1`, "10.9.9.2", 24);
        get().setInterfaceIp(r2, `${r2}-if0`, "10.0.0.3", 24);
        get().setInterfaceIp(r2, `${r2}-if1`, "10.9.9.3", 24);
        get().setInterfaceIp(srv, `${srv}-if0`, "10.9.9.9", 24);
        get().setDefaultGateway(srv, "10.9.9.1"); // the WAN-side VIP
        get().connect(pc1, `${pc1}-if0`, sw1, `${sw1}-if0`);
        get().connect(r1, `${r1}-if0`, sw1, `${sw1}-if1`);
        get().connect(r2, `${r2}-if0`, sw1, `${sw1}-if2`);
        get().connect(r1, `${r1}-if1`, sw2, `${sw2}-if0`);
        get().connect(r2, `${r2}-if1`, sw2, `${sw2}-if1`);
        get().connect(srv, `${srv}-if0`, sw2, `${sw2}-if2`);
        const next = structuredClone(get().network);
        const R1 = next.devices[r1], R2 = next.devices[r2];
        R1.config.features = { vrrp: { instances: [
          { iface: R1.interfaces[0].name, vrid: 1, vip: "10.0.0.1", priority: 110 },
          { iface: R1.interfaces[1].name, vrid: 2, vip: "10.9.9.1", priority: 110 },
        ] } };
        R2.config.features = { vrrp: { instances: [
          { iface: R2.interfaces[0].name, vrid: 1, vip: "10.0.0.1", priority: 100 },
          { iface: R2.interfaces[1].name, vrid: 2, vip: "10.9.9.1", priority: 100 },
        ] } };
        set({ network: next, labName: "VRRP Lab — R1 (Master) / R2 (Backup), VIP 10.0.0.1", selectedDeviceId: pc1 });
        hint(pc1, [
          "VRRP gateway redundancy: R1=Master (pri 110), R2=Backup (pri 100), VIP 10.0.0.1.",
          "1) On R1 run `vrrp` — the timeline shows R1 advertising the VIP (gratuitous ARP).",
          "2) From PC: `ping 10.0.0.1` (gateway) and `ping 10.9.9.9` (server via the gateway).",
          "3) FAIL OVER on R1:  `ip link set eth0 down`  then  `ip link set eth1 down`.",
          "4) On R2 run `vrrp` — the timeline shows VRRP_FAILOVER: R1 → R2 takes over.",
          "   Ping from PC still works (seamless, same VIP) — now forwarded via R2.",
        ]);
        return;
      }

      case "dhcp": {
        get().newLab();
        const pc1 = get().addDevice("pc", { x: 160, y: 160 });
        const dh = get().addDevice("dhcp-server", { x: 540, y: 160 });
        // Client starts with NO IP (it learns one); the server owns the subnet.
        get().setInterfaceIp(dh, `${dh}-if0`, "192.168.100.1", 24);
        get().connect(pc1, `${pc1}-if0`, dh, `${dh}-if0`);
        set({ labName: "DHCP Lab — client ↔ dhcp-server", selectedDeviceId: pc1 });
        hint(pc1, ["DHCP lab: client ↔ dhcp-server (pool 192.168.100.0/24).", "Try:  dhclient        (request a lease)", "      ip addr        (see the leased address)"]);
        return;
      }

      case "dhcprelay": {
        // Cross-subnet DHCP: client (10.1.1.0/24) — relay router — dhcp-server (10.2.2.0/24).
        get().newLab();
        const pc1 = get().addDevice("pc", { x: 60, y: 160 });
        const r1 = get().addDevice("router", { x: 340, y: 160 }, 2);
        const dh = get().addDevice("dhcp-server", { x: 640, y: 160 });
        get().setDefaultGateway(pc1, "10.1.1.1"); // client learns its IP via DHCP
        get().setInterfaceIp(r1, `${r1}-if0`, "10.1.1.1", 24); // client-facing (relay/giaddr)
        get().setInterfaceIp(r1, `${r1}-if1`, "10.2.2.1", 24); // server-facing
        get().setInterfaceIp(dh, `${dh}-if0`, "10.2.2.10", 24);
        get().setDefaultGateway(dh, "10.2.2.1"); // server routes back to the client subnet via R1
        get().connect(pc1, `${pc1}-if0`, r1, `${r1}-if0`);
        get().connect(r1, `${r1}-if1`, dh, `${dh}-if0`);
        const next = structuredClone(get().network);
        // Relay: R1's client interface forwards DHCP to the server.
        next.devices[r1].config.features = { dhcpRelay: { [next.devices[r1].interfaces[0].name]: ["10.2.2.10"] } };
        // Server: a pool for the CLIENT subnet (selected by giaddr), gateway = relay.
        next.devices[dh].config.features = {
          dhcpServer: { gateway: "10.2.2.10", dns: "10.2.2.10", prefix: 24, leases: {}, pools: [{ subnet: "10.1.1.0", prefix: 24, gateway: "10.1.1.1", dns: "10.1.1.1", leases: {} }] },
        };
        set({ network: next, labName: "DHCP Relay Lab — client ↔ relay ↔ server (cross-subnet)", selectedDeviceId: pc1 });
        hint(pc1, ["DHCP relay lab: client — R1 (relay) — dhcp-server on another subnet.", "R1 relays via `ip dhcp-relay 10.2.2.10` on its client interface.", "Try:  dhclient    (client gets 10.1.1.100 from across the relay)"]);
        return;
      }
    }

    // Config-plane features: drop into a sandbox where the feature's SONiC
    // commands work. L3 features get a routing sandbox; everything else a switch.
    const feat = SONIC_FEATURES.find((f) => f.id === featureId);
    const label = feat?.label ?? featureId;
    if (feat?.group === "L3") {
      const { r1 } = twoRouterCore();
      set({ labName: `${label} Lab — routing sandbox`, selectedDeviceId: r1 });
      hint(r1, [`SONiC ${label} sandbox on R1 (10.1.1.1 ↔ R2 10.0.0.2).`, "Run `show` or `config` alone to list this device's SONiC sub-commands."]);
    } else {
      get().loadSample();
      const swId = Object.values(get().network.devices).find((d) => d.type === "switch")?.id;
      if (swId) {
        set({ labName: `${label} Lab — SONiC switch sandbox`, selectedDeviceId: swId });
        hint(swId, [`SONiC ${label} sandbox on the switch (sonic-cli).`, "Try:  configure terminal   then the feature's commands", "      show <feature>       to verify"]);
      }
    }
  },

  exportLab() {
    const { network, labName } = get();
    return JSON.stringify(
      {
        version: 1,
        name: labName,
        devices: Object.values(network.devices),
        connections: network.connections,
      },
      null,
      2,
    );
  },

  importLab(json) {
    try {
      const data = JSON.parse(json) as {
        name?: string;
        devices: Device[];
        connections: Connection[];
      };
      const devices: Record<string, Device> = {};
      for (const d of data.devices) devices[d.id] = d;
      // avoid id collisions with future additions
      const maxSeq = data.devices.reduce((m, d) => {
        const n = parseInt(d.id.replace(/\D/g, ""), 10);
        return Number.isFinite(n) ? Math.max(m, n) : m;
      }, 0);
      stopTrafficTimer();
      capturePredicates.clear();
      set({
        liveCaptures: {},
        traffic: null,
        sflowErrors: {},
        network: { devices, connections: data.connections ?? [] },
        labName: data.name ?? "Imported Lab",
        events: [],
        captures: [],
        terminals: {},
        terminalHistory: {},
        selectedDeviceId: undefined,
        selectedEventId: undefined,
        playback: { index: 0, playing: false },
        deviceSeq: maxSeq + 1,
      });
      return true;
    } catch {
      return false;
    }
  },
};
});
