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
import { execute, CommandContext, LineKind, OutputLine } from "../commands";
import { cliModeFor, runSonicCli, enterSonicCli, CliStack } from "../commands/sonic-cli";

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

export const useLabStore = create<LabState>((set, get) => ({
  network: { devices: {}, connections: [] },
  labName: "Untitled Lab",
  events: [],
  captures: [],
  terminals: {},
  terminalHistory: {},
  cliMode: {},
  playback: { index: 0, playing: false },
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
    const ctx: CommandContext = {
      device,
      network: draft,
      captures,
      runSim(fn) {
        const sim = new Simulation(draft);
        const value = fn(sim);
        captures.push(...sim.captures);
        return { value, events: sim.events };
      },
    };

    // Route through sonic-cli when the device is in a modal CLI mode; otherwise
    // the plain bash/Click shell. `sonic-cli` at the bash prompt enters the CLI.
    const stack = cliModeFor(device, state.cliMode[deviceId]);
    let output: OutputLine[];
    let clear = false;
    let events;
    let nextStack: CliStack | undefined = state.cliMode[deviceId];

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

    return { output, clear };
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
    set({
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
      set({
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
}));
