/**
 * Simulation orchestrator (spec §60, §61). Owns the clock, the event log, the
 * capture buffers, and the frame-delivery loop. Implements SimContext so the
 * protocol modules drive it. `runPing` is the first end-to-end command flow:
 * every line of ping output is derived from the real packet journey below.
 */
import { NetworkState, getPeer } from "../models/topology";
import { findInterface, isSwitch, isRouter } from "../models/device";
import { Device } from "../models/device";
import { Frame, cloneFrame } from "../models/packet";
import { primaryIpv4, primaryIpv6, NetInterface } from "../models/interface";
import { longestPrefixMatch, longestPrefixMatch6 } from "../models/route";
import { ip6Output, echo6, ICMP6_ECHO_TOTAL, ICMP6_ECHO_DATA_BYTES } from "../protocols/ipv6";
import { convergeOspfDomain, OspfSummary } from "../protocols/ospf";
import { convergeBgpDomain, BgpSummary } from "../protocols/bgp";
import { masteredVips, electMaster, vrrpRole, VrrpConfig } from "../protocols/vrrp";
import { buildArpRequest } from "../protocols/arp";
import { SimContext, CaptureDir } from "./context";
import { SimEvent, EmitInput } from "./events";
import { nextEventId } from "./ids";
import { switchForward } from "../protocols/switch";
import { hostReceive } from "../protocols/host";
import { routerReceive } from "../protocols/router";
import { echoPayload, ICMP_ECHO_TOTAL, ICMP_ECHO_DATA_BYTES } from "../protocols/icmp";
import { ipOutput, routeTableSnapshot } from "../protocols/ipv4";
import { buildFrame } from "../protocols/ethernet";
import { BROADCAST_MAC } from "../models/mac";
import { rebuildConnectedRoutes } from "../models/factory";
import {
  NTP_PORT,
  DHCP_SERVER_PORT,
  DHCP_CLIENT_PORT,
  NTP_UPPER_BYTES,
  DHCP_UPPER_BYTES,
  DNS_PORT,
  DNS_UPPER_BYTES,
} from "../protocols/udpapp";
import { DhcpPayload } from "../models/packet";

const LINK_LATENCY_MS = 1;
const MAX_STEPS = 5000;

export type PingFailure =
  | "no-route"
  | "iface-down"
  | "no-src-ip"
  | "arp-failed"
  | "ndp-failed"
  | "no-egress"
  | "timeout";

export interface PingReply {
  seq: number;
  success: boolean;
  fromIp?: string;
  ttl?: number;
  rttMs?: number;
  bytes?: number;
  reason?: PingFailure;
}

export interface PingSummary {
  dstIp: string;
  transmitted: number;
  received: number;
  replies: PingReply[];
}

export interface TraceHop {
  ttl: number;
  reached: boolean;
  fromIp?: string;
  rttMs?: number;
}

export interface NtpSyncResult {
  server: string;
  synced: boolean;
  stratum?: number;
  offsetMs?: number;
  delayMs?: number;
  reason?: string;
}

export interface DhcpResult {
  success: boolean;
  assignedIp?: string;
  prefix?: number;
  gateway?: string;
  dns?: string;
  reason?: string;
}

export interface DnsResult {
  name: string;
  ok: boolean;
  address?: string;
  server?: string;
  reason?: string;
}

export interface VrrpStatus {
  vip: string;
  vrid: number;
  master?: string; // device name of the elected master
  roles: { device: string; role: "Master" | "Backup" | "Init"; priority: number }[];
}

export interface CaptureRecord {
  deviceId: string;
  interfaceId: string;
  dir: CaptureDir;
  timeMs: number;
  frame: Frame;
}

export class Simulation implements SimContext {
  readonly state: NetworkState;
  events: SimEvent[] = [];
  captures: CaptureRecord[] = [];

  private clock: number;
  private seq = 0;
  private steps = 0;
  private echoReplies: { deviceId: string; frame: Frame }[] = [];
  private udpReplies: { deviceId: string; frame: Frame }[] = [];
  private icmpId: number;

  constructor(state: NetworkState, opts?: { startClock?: number; icmpId?: number }) {
    this.state = state;
    this.clock = opts?.startClock ?? 0;
    this.icmpId = opts?.icmpId ?? 1000;
  }

  // --- SimContext ---
  now(): number {
    return this.clock;
  }

  advance(ms: number): void {
    this.clock += ms;
  }

  step(): boolean {
    this.steps += 1;
    return this.steps <= MAX_STEPS;
  }

  emit(e: EmitInput): void {
    this.seq += 1;
    this.events.push({
      ...e,
      id: nextEventId(),
      seq: this.seq,
      timeMs: this.clock,
      frame: e.frame ? cloneFrame(e.frame) : undefined,
    });
  }

  capture(deviceId: string, interfaceId: string, dir: CaptureDir, frame: Frame): void {
    this.captures.push({ deviceId, interfaceId, dir, timeMs: this.clock, frame: cloneFrame(frame) });
  }

  recordEchoReply(deviceId: string, frame: Frame): void {
    this.echoReplies.push({ deviceId, frame: cloneFrame(frame) });
  }

  recordUdp(deviceId: string, frame: Frame): void {
    this.udpReplies.push({ deviceId, frame: cloneFrame(frame) });
  }

  // --- NTP sync (spec §23): UDP/123 request → server response → offset/stratum ---
  runNtpSync(clientId: string, serverIp: string): NtpSyncResult {
    const client = this.state.devices[clientId];
    if (!client) return { server: serverIp, synced: false, reason: "no-device" };
    const match = longestPrefixMatch(client.routingTable, serverIp);
    if (!match) return { server: serverIp, synced: false, reason: "no-route" };
    const egress = findInterface(client, match.route.interfaceId);
    if (!egress || egress.adminState !== "up") return { server: serverIp, synced: false, reason: "iface-down" };
    const srcAddr = primaryIpv4(egress);
    if (!srcAddr) return { server: serverIp, synced: false, reason: "no-src-ip" };

    this.udpReplies = [];
    const t1 = this.clock; // originate
    this.emit({
      type: "NTP_REQUEST",
      deviceId: client.id,
      deviceName: client.name,
      interfaceId: egress.id,
      interfaceName: egress.name,
      message: `${client.name}: NTP request → ${serverIp} (UDP/123)`,
      osiLayers: [7],
    });
    const res = ipOutput(this, client, {
      srcIp: srcAddr.address,
      dstIp: serverIp,
      ttl: 64,
      protocol: "UDP",
      identification: 0,
      udp: { srcPort: NTP_PORT, dstPort: NTP_PORT, length: NTP_UPPER_BYTES },
      ntp: { mode: "client", version: 4, stratum: 0, transmitTs: t1 },
      upperBytes: NTP_UPPER_BYTES,
      summary: "NTP client request",
    });
    if (!res.ok) return { server: serverIp, synced: false, reason: res.reason };

    const reply = this.udpReplies.find((r) => r.deviceId === clientId && r.frame.ntp?.mode === "server");
    if (!reply?.frame.ntp) return { server: serverIp, synced: false, reason: "timeout" };

    const t4 = this.clock; // client receive
    const ntp = reply.frame.ntp;
    const t2 = ntp.receiveTs ?? t1;
    const t3 = ntp.transmitTs;
    const offset = Math.round((t2 - t1 + (t3 - t4)) / 2);
    const delay = Math.max(0, t4 - t1 - (t3 - t2));
    return { server: serverIp, synced: true, stratum: ntp.stratum, offsetMs: offset, delayMs: delay };
  }

  // --- DNS resolution: query a configured nameserver (routed) for an A record ---
  runDnsResolve(clientId: string, name: string, serverIp?: string): DnsResult {
    const client = this.state.devices[clientId];
    if (!client) return { name, ok: false, reason: "no-device" };
    const ns = serverIp ?? (client.config.features?.dns as { nameservers?: string[] } | undefined)?.nameservers?.[0];
    if (!ns) return { name, ok: false, reason: "no-nameserver" };
    const match = longestPrefixMatch(client.routingTable, ns);
    if (!match) return { name, ok: false, reason: "no-route", server: ns };
    const egress = findInterface(client, match.route.interfaceId);
    if (!egress || egress.adminState !== "up") return { name, ok: false, reason: "iface-down", server: ns };
    const src = primaryIpv4(egress);
    if (!src) return { name, ok: false, reason: "no-src-ip", server: ns };

    this.udpReplies = [];
    this.emit({
      type: "DNS_QUERY", deviceId: client.id, deviceName: client.name, interfaceId: egress.id, interfaceName: egress.name,
      message: `${client.name}: DNS query ${name} → ${ns} (UDP/53)`, osiLayers: [7],
    });
    const res = ipOutput(this, client, {
      srcIp: src.address, dstIp: ns, ttl: 64, protocol: "UDP", identification: 0,
      udp: { srcPort: DNS_PORT, dstPort: DNS_PORT, length: DNS_UPPER_BYTES },
      dns: { kind: "query", name }, upperBytes: DNS_UPPER_BYTES, summary: `DNS query ${name}`,
    });
    if (!res.ok) return { name, ok: false, reason: res.reason, server: ns };
    const reply = this.udpReplies.find((r) => r.deviceId === clientId && r.frame.dns?.kind === "response");
    if (!reply?.frame.dns?.address) return { name, ok: false, reason: "timeout", server: ns };
    return { name, ok: true, address: reply.frame.dns.address, server: ns };
  }

  // --- VRRP: each current Master sends a gratuitous ARP for its VIP so switches
  //     learn (or, on failover, RE-learn) virtual-MAC → current-master port. ---
  private announceVrrp(): void {
    const prev = (this.state.vrrpMaster ??= {});
    for (const device of Object.values(this.state.devices)) {
      for (const v of masteredVips(this.state, device)) {
        const iface = device.interfaces.find((i) => i.name === v.iface);
        if (!iface || iface.operState !== "up") continue;
        // Explicit failover: the master for this VIP changed since we last checked.
        const old = prev[v.vip];
        if (old && old !== device.id) {
          const oldName = this.state.devices[old]?.name ?? old;
          this.emit({
            type: "VRRP_FAILOVER", deviceId: device.id, deviceName: device.name, interfaceId: iface.id, interfaceName: iface.name,
            message: `VRRP ${v.vip} (vrid ${v.vrid}) FAILOVER: ${oldName} down → ${device.name} takes over as Master`, osiLayers: [2],
          });
        }
        prev[v.vip] = device.id;
        this.emit({
          type: "VRRP_MASTER", deviceId: device.id, deviceName: device.name, interfaceId: iface.id, interfaceName: iface.name,
          message: `${device.name}: VRRP Master for ${v.vip} (vrid ${v.vrid}) — gratuitous ARP ${v.vmac}`, osiLayers: [2],
        });
        this.transmit(device.id, iface.id, buildArpRequest(v.vmac, v.vip, v.vip));
      }
    }
  }

  /** Converge VRRP: announce current masters (gratuitous ARP) + report roles. */
  runVrrp(): VrrpStatus[] {
    this.announceVrrp();
    const insts = (d: Device) => (d.config.features?.vrrp as VrrpConfig | undefined)?.instances ?? [];
    const groups = new Map<string, number>();
    for (const d of Object.values(this.state.devices)) for (const i of insts(d)) if (i.vip) groups.set(i.vip, i.vrid);
    return [...groups.entries()].map(([vip, vrid]) => ({
      vip, vrid,
      master: electMaster(this.state, vip)?.device.name,
      roles: Object.values(this.state.devices)
        .map((d) => ({ d, inst: insts(d).find((i) => i.vip === vip) }))
        .filter((x) => x.inst)
        .map((x) => ({ device: x.d.name, role: vrrpRole(this.state, x.d, vip), priority: x.inst!.priority ?? 100 })),
    }));
  }

  // --- DHCP DORA (spec §22): Discover → Offer → Request → Ack, client applies IP ---
  runDhcp(clientId: string, interfaceId: string): DhcpResult {
    const client = this.state.devices[clientId];
    if (!client) return { success: false, reason: "no-device" };
    const iface = findInterface(client, interfaceId);
    if (!iface) return { success: false, reason: "no-iface" };
    if (iface.adminState !== "up" || iface.operState !== "up") return { success: false, reason: "iface-down" };

    // DISCOVER (L2 broadcast — the client has no IP yet)
    this.udpReplies = [];
    this.emit({
      type: "DHCP_DISCOVER",
      deviceId: client.id,
      deviceName: client.name,
      interfaceId: iface.id,
      interfaceName: iface.name,
      message: `${client.name}: DHCP DISCOVER (broadcast)`,
      osiLayers: [7],
    });
    this.transmit(clientId, interfaceId, this.dhcpClientFrame(iface, "discover", {}));
    const offer = this.udpReplies.find((r) => r.deviceId === clientId && r.frame.dhcp?.messageType === "offer");
    if (!offer?.frame.dhcp) return { success: false, reason: "no-offer" };
    const off = offer.frame.dhcp;

    // REQUEST (broadcast, echoing the offered address)
    this.udpReplies = [];
    this.emit({
      type: "DHCP_REQUEST",
      deviceId: client.id,
      deviceName: client.name,
      interfaceId: iface.id,
      interfaceName: iface.name,
      message: `${client.name}: DHCP REQUEST ${off.yourIp} (broadcast)`,
      osiLayers: [7],
    });
    this.transmit(
      clientId,
      interfaceId,
      this.dhcpClientFrame(iface, "request", { requestedIp: off.yourIp, serverIp: off.serverIp }),
    );
    const ack = this.udpReplies.find((r) => r.deviceId === clientId && r.frame.dhcp?.messageType === "ack");
    if (!ack?.frame.dhcp) return { success: false, reason: "no-ack" };
    const a = ack.frame.dhcp;

    if (a.yourIp && a.prefix) {
      iface.ipv4 = [{ address: a.yourIp, prefix: a.prefix }];
      if (a.gateway) client.config.defaultGateway = a.gateway;
      rebuildConnectedRoutes(client);
    }
    return { success: true, assignedIp: a.yourIp, prefix: a.prefix, gateway: a.gateway, dns: a.dns };
  }

  private dhcpClientFrame(iface: NetInterface, messageType: DhcpPayload["messageType"], extra: Partial<DhcpPayload>): Frame {
    const dhcp: DhcpPayload = { messageType, clientMac: iface.mac, ...extra };
    return buildFrame(
      {
        srcMac: iface.mac,
        dstMac: BROADCAST_MAC,
        etherType: "IPv4",
        payloadBytes: 20 + DHCP_UPPER_BYTES,
        summary: `DHCP ${messageType.toUpperCase()}`,
      },
      {
        ipv4: { srcIp: "0.0.0.0", dstIp: "255.255.255.255", ttl: 64, protocol: "UDP", identification: 0 },
        udp: { srcPort: DHCP_CLIENT_PORT, dstPort: DHCP_SERVER_PORT, length: DHCP_UPPER_BYTES },
        dhcp,
      },
    );
  }

  transmit(deviceId: string, interfaceId: string, frame: Frame): void {
    if (!this.step()) return; // loop / runaway guard

    const device = this.state.devices[deviceId];
    if (!device) return;
    const iface = findInterface(device, interfaceId);
    if (!iface) return;

    if (iface.adminState !== "up") {
      this.emit({
        type: "FRAME_DROPPED",
        deviceId,
        deviceName: device.name,
        interfaceId,
        interfaceName: iface.name,
        message: `${device.name} ${iface.name}: interface administratively down — frame dropped`,
        osiLayers: [1],
        frame,
      });
      return;
    }

    iface.statistics.txFrames += 1;
    iface.statistics.txBytes += frame.meta.sizeBytes;
    this.capture(deviceId, interfaceId, "tx", frame);

    const peer = getPeer(this.state, deviceId, interfaceId);
    if (!peer) {
      this.emit({
        type: "FRAME_DROPPED",
        deviceId,
        deviceName: device.name,
        interfaceId,
        interfaceName: iface.name,
        message: `${device.name} ${iface.name}: no cable connected — frame dropped`,
        osiLayers: [1],
        frame,
      });
      return;
    }

    if (peer.connection.state !== "up" || iface.operState !== "up") {
      this.emit({
        type: "FRAME_DROPPED",
        deviceId,
        deviceName: device.name,
        interfaceId,
        interfaceName: iface.name,
        message: `${device.name} ${iface.name}: link is down — frame dropped`,
        osiLayers: [1],
        frame,
      });
      return;
    }

    const peerDevice = this.state.devices[peer.endpoint.deviceId];
    const peerIface = peerDevice && findInterface(peerDevice, peer.endpoint.interfaceId);

    this.emit({
      type: "FRAME_SENT",
      deviceId,
      deviceName: device.name,
      interfaceId,
      interfaceName: iface.name,
      message: `${device.name} ${iface.name} → ${peerDevice?.name} ${peerIface?.name}: ${frame.meta.summary}`,
      osiLayers: [1, 2],
      frame,
      link: {
        fromDeviceId: deviceId,
        fromInterfaceId: interfaceId,
        toDeviceId: peer.endpoint.deviceId,
        toInterfaceId: peer.endpoint.interfaceId,
      },
    });

    this.advance(LINK_LATENCY_MS);
    this.deliverToDevice(peer.endpoint.deviceId, peer.endpoint.interfaceId, frame);
  }

  private deliverToDevice(deviceId: string, interfaceId: string, frame: Frame): void {
    const device = this.state.devices[deviceId];
    if (!device) return;
    const iface = findInterface(device, interfaceId);
    if (!iface) return;

    if (iface.adminState !== "up" || iface.operState !== "up") {
      this.emit({
        type: "FRAME_DROPPED",
        deviceId,
        deviceName: device.name,
        interfaceId,
        interfaceName: iface.name,
        message: `${device.name} ${iface.name}: ingress interface down — frame dropped`,
        osiLayers: [1],
        frame,
      });
      return;
    }

    iface.statistics.rxFrames += 1;
    iface.statistics.rxBytes += frame.meta.sizeBytes;
    this.capture(deviceId, interfaceId, "rx", frame);

    this.emit({
      type: "FRAME_RECEIVED",
      deviceId,
      deviceName: device.name,
      interfaceId,
      interfaceName: iface.name,
      message: `${device.name} ${iface.name}: received ${frame.meta.summary}`,
      osiLayers: [1, 2],
      frame,
    });

    if (isSwitch(device.type)) {
      switchForward(this, device, iface, frame);
    } else if (isRouter(device.type)) {
      routerReceive(this, device, iface, frame);
    } else {
      hostReceive(this, device, iface, frame);
    }
  }

  // --- Ping orchestration ---
  runPing(srcDeviceId: string, dstIp: string, opts?: { count?: number; ttl?: number }): PingSummary {
    const count = opts?.count ?? 4;
    const ttl = opts?.ttl ?? 64;
    const src = this.state.devices[srcDeviceId];
    const replies: PingReply[] = [];
    this.announceVrrp(); // ensure switches point virtual-MAC → the CURRENT master (handles failover)

    if (src) {
      for (let seq = 1; seq <= count; seq++) {
        replies.push(this.pingOnce(src, dstIp, this.icmpId, seq, ttl));
        this.advance(5); // small spacing so timestamps differ between probes
      }
    }

    const received = replies.filter((r) => r.success).length;
    this.emit({
      type: "PING_RESULT",
      deviceId: srcDeviceId,
      deviceName: src?.name ?? srcDeviceId,
      message: `ping ${dstIp}: ${received}/${replies.length} replies received`,
      osiLayers: [3],
    });

    return { dstIp, transmitted: replies.length, received, replies };
  }

  private pingOnce(src: Device, dstIp: string, id: number, seq: number, ttl: number): PingReply {
    // Silent lookup to pick the source address (the egress interface's IP).
    const match = longestPrefixMatch(src.routingTable, dstIp);
    if (!match) {
      this.emit({
        type: "ROUTE_LOOKUP",
        deviceId: src.id,
        deviceName: src.name,
        message: `${src.name}: no route to ${dstIp}`,
        osiLayers: [3],
        detail: {
          kind: "route-lookup",
          destinationIp: dstIp,
          result: "no-route",
          routingTable: routeTableSnapshot(src, dstIp),
        },
      });
      return { seq, success: false, reason: "no-route" };
    }
    const egress = findInterface(src, match.route.interfaceId);
    if (!egress || egress.adminState !== "up") return { seq, success: false, reason: "iface-down" };
    const srcAddr = primaryIpv4(egress);
    if (!srcAddr) return { seq, success: false, reason: "no-src-ip" };

    const icmp = echoPayload("echo-request", id, seq);
    this.emit({
      type: "ICMP_ECHO_REQUEST",
      deviceId: src.id,
      deviceName: src.name,
      interfaceId: egress.id,
      interfaceName: egress.name,
      message: `${src.name}: echo request → ${dstIp} (id ${id}, seq ${seq}, ttl ${ttl})`,
      osiLayers: [3],
    });

    const start = this.clock;
    this.echoReplies = [];
    const res = ipOutput(this, src, {
      srcIp: srcAddr.address,
      dstIp,
      ttl,
      protocol: "ICMP",
      identification: id,
      icmp,
      upperBytes: ICMP_ECHO_TOTAL,
      summary: `ICMP echo request id ${id} seq ${seq}`,
    });

    if (!res.ok) {
      const reason: PingFailure = res.reason === "arp-failed" ? "arp-failed" : res.reason ?? "timeout";
      return { seq, success: false, reason };
    }

    const reply = this.takeEchoReply(src.id, id, seq);
    if (reply && reply.ipv4) {
      return {
        seq,
        success: true,
        fromIp: reply.ipv4.srcIp,
        ttl: reply.ipv4.ttl,
        rttMs: this.clock - start,
        bytes: ICMP_ECHO_DATA_BYTES + 8,
      };
    }
    return { seq, success: false, reason: "timeout" };
  }

  // --- Traceroute (spec §17): probe with increasing TTL, record who answers ---
  runTraceroute(
    srcDeviceId: string,
    dstIp: string,
    opts?: { maxHops?: number },
  ): { dstIp: string; hops: TraceHop[] } {
    const maxHops = opts?.maxHops ?? 30;
    const src = this.state.devices[srcDeviceId];
    const hops: TraceHop[] = [];
    if (!src) return { dstIp, hops };

    for (let ttl = 1; ttl <= maxHops; ttl++) {
      const probe = this.traceProbe(src, dstIp, this.icmpId, ttl);
      if (probe.reachedDst && probe.fromIp) {
        hops.push({ ttl, reached: true, fromIp: probe.fromIp, rttMs: probe.rttMs });
        break;
      }
      if (probe.fromIp) {
        hops.push({ ttl, reached: false, fromIp: probe.fromIp, rttMs: probe.rttMs });
      } else {
        hops.push({ ttl, reached: false }); // '*' — no response
      }
      this.advance(5);
    }
    return { dstIp, hops };
  }

  private traceProbe(
    src: Device,
    dstIp: string,
    id: number,
    ttl: number,
  ): { reachedDst: boolean; fromIp?: string; rttMs?: number } {
    const match = longestPrefixMatch(src.routingTable, dstIp);
    if (!match) return { reachedDst: false };
    const egress = findInterface(src, match.route.interfaceId);
    if (!egress || egress.adminState !== "up") return { reachedDst: false };
    const srcAddr = primaryIpv4(egress);
    if (!srcAddr) return { reachedDst: false };

    const start = this.clock;
    const marker = this.events.length;
    this.echoReplies = [];
    const res = ipOutput(this, src, {
      srcIp: srcAddr.address,
      dstIp,
      ttl,
      protocol: "ICMP",
      identification: id,
      icmp: echoPayload("echo-request", id, ttl),
      upperBytes: ICMP_ECHO_TOTAL,
      summary: `ICMP echo request (traceroute ttl ${ttl})`,
    });
    if (!res.ok) return { reachedDst: false };

    const reply = this.takeEchoReply(src.id, id, ttl);
    if (reply?.ipv4) {
      return { reachedDst: true, fromIp: reply.ipv4.srcIp, rttMs: this.clock - start };
    }
    // Look for an ICMP time-exceeded that came back to the source.
    const te = this.events
      .slice(marker)
      .find(
        (e) =>
          e.type === "FRAME_RECEIVED" &&
          e.deviceId === src.id &&
          e.frame?.icmp?.type === "time-exceeded",
      );
    if (te?.frame?.ipv4) {
      return { reachedDst: false, fromIp: te.frame.ipv4.srcIp, rttMs: this.clock - start };
    }
    return { reachedDst: false };
  }

  private takeEchoReply(deviceId: string, id: number, seq: number): Frame | undefined {
    const idx = this.echoReplies.findIndex(
      (r) =>
        r.deviceId === deviceId &&
        r.frame.icmp?.type === "echo-reply" &&
        r.frame.icmp.identifier === id &&
        r.frame.icmp.sequence === seq,
    );
    if (idx < 0) return undefined;
    return this.echoReplies.splice(idx, 1)[0].frame;
  }

  // --- OSPF (spec §24): converge the domain (Hello → adjacency → SPF routes) ---
  runOspf(): OspfSummary {
    return convergeOspfDomain(this);
  }

  // --- BGP (spec §25): open sessions to configured neighbors + exchange NLRI ---
  runBgp(): BgpSummary {
    return convergeBgpDomain(this);
  }

  // --- IPv6 ping (spec §40): ICMPv6 echo over NDP-resolved L2 ---
  runPing6(srcDeviceId: string, dstIp: string, opts?: { count?: number; hopLimit?: number }): PingSummary {
    const count = opts?.count ?? 4;
    const hop = opts?.hopLimit ?? 64;
    const src = this.state.devices[srcDeviceId];
    const replies: PingReply[] = [];
    if (src) {
      for (let seq = 1; seq <= count; seq++) {
        replies.push(this.ping6Once(src, dstIp, this.icmpId, seq, hop));
        this.advance(5);
      }
    }
    const received = replies.filter((r) => r.success).length;
    this.emit({
      type: "PING_RESULT",
      deviceId: srcDeviceId,
      deviceName: src?.name ?? srcDeviceId,
      message: `ping6 ${dstIp}: ${received}/${replies.length} replies received`,
      osiLayers: [3],
    });
    return { dstIp, transmitted: replies.length, received, replies };
  }

  private ping6Once(src: Device, dstIp: string, id: number, seq: number, hop: number): PingReply {
    const match = longestPrefixMatch6(src.routingTable6 ?? [], dstIp);
    if (!match) {
      this.emit({
        type: "ROUTE_LOOKUP",
        deviceId: src.id,
        deviceName: src.name,
        message: `${src.name}: no IPv6 route to ${dstIp}`,
        osiLayers: [3],
      });
      return { seq, success: false, reason: "no-route" };
    }
    const egress = findInterface(src, match.route.interfaceId);
    if (!egress || egress.adminState !== "up") return { seq, success: false, reason: "iface-down" };
    const srcAddr = primaryIpv6(egress);
    if (!srcAddr) return { seq, success: false, reason: "no-src-ip" };

    this.emit({
      type: "ICMP6_ECHO_REQUEST",
      deviceId: src.id,
      deviceName: src.name,
      interfaceId: egress.id,
      interfaceName: egress.name,
      message: `${src.name}: ICMPv6 echo request → ${dstIp} (id ${id}, seq ${seq}, hlim ${hop})`,
      osiLayers: [3],
    });
    const start = this.clock;
    this.echoReplies = [];
    const res = ip6Output(this, src, {
      srcIp: srcAddr.address,
      dstIp,
      hopLimit: hop,
      nextHeader: "ICMPv6",
      icmp6: echo6("echo-request", id, seq),
      upperBytes: ICMP6_ECHO_TOTAL,
      summary: `ICMPv6 echo request id ${id} seq ${seq}`,
    });
    if (!res.ok) {
      const reason: PingFailure = res.reason === "ndp-failed" ? "ndp-failed" : res.reason ?? "timeout";
      return { seq, success: false, reason };
    }
    const reply = this.takeEchoReply6(src.id, id, seq);
    if (reply?.ipv6) {
      return {
        seq,
        success: true,
        fromIp: reply.ipv6.srcIp,
        ttl: reply.ipv6.hopLimit,
        rttMs: this.clock - start,
        bytes: ICMP6_ECHO_DATA_BYTES + 8,
      };
    }
    return { seq, success: false, reason: "timeout" };
  }

  private takeEchoReply6(deviceId: string, id: number, seq: number): Frame | undefined {
    const idx = this.echoReplies.findIndex(
      (r) =>
        r.deviceId === deviceId &&
        r.frame.icmp6?.type === "echo-reply" &&
        r.frame.icmp6.identifier === id &&
        r.frame.icmp6.sequence === seq,
    );
    if (idx < 0) return undefined;
    return this.echoReplies.splice(idx, 1)[0].frame;
  }
}
