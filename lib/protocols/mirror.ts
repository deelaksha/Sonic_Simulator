/**
 * Port mirroring — SPAN and ERSPAN — as orchagent's MirrorOrch programs it
 * (sonic-swss orchagent/mirrororch.cpp), on the MIRROR_SESSION rows that KLISH
 * `mirror-session` (features/mirror.ts) and Click `config mirror_session`
 * (commands/sonic/mirror.ts) both write into the config-plane store "cp_mirror".
 *
 *   SPAN    every frame received (rx) and/or sent (tx) on a source port is
 *           copied out of the destination port unchanged (SAI_MIRROR_SESSION_
 *           TYPE_LOCAL, mirrororch.cpp:960-970), so a host running tcpdump on
 *           the destination port sees the monitored traffic.
 *   ERSPAN  the copy is encapsulated (SAI_ERSPAN_ENCAPSULATION_TYPE_MIRROR_L3_
 *           GRE_TUNNEL, mirrororch.cpp:992-1036): outer IPv4 src/dst from the
 *           session, TOS = dscp << 2 (:1001-1003), TTL (:1006-1007), GRE
 *           protocol type = gre_type (:1034-1035), then an ERSPAN type II
 *           header and the original frame. Defaults dscp 8, ttl 255, gre_type
 *           0x88be (MirrorEntry ctor, mirrororch.cpp:56-72). The packet is routed
 *           to dst_ip like any IPv4 packet (the session follows the route /
 *           neighbor of the destination, mirrororch.cpp updateSession*).
 *
 * Direction rx/tx/both = SAI_PORT_ATTR_INGRESS/EGRESS_MIRROR_SESSION
 * (mirrororch.cpp:817-818); the sonic-utilities default is "both"
 * (config/main.py gather_session_info).
 *
 * Status (STATE_DB MIRROR_SESSION_TABLE status, mirrororch.cpp:15-17):
 * SPAN is active when its destination port exists; ERSPAN when a route to
 * dst_ip exists (orchagent activates it once the next hop resolves; the
 * simulator resolves ARP when the first copy is sent).
 *
 * Simulator choices (no source): GRE carries a sequence number (S bit, as
 * ERSPAN type II requires — draft-foschiano-erspan-03 §4.1); the ERSPAN header
 * has ver 1 (type II), the original VLAN, session id 0 and index 0 (SONiC sets
 * neither attribute). Copies are not mirrored again.
 */
import { registerDataPlaneHook } from "../control/hooks";
import { registerDaemon } from "../control/daemon";
import { ipPayload, sendIpv4 } from "../control/packet";
import { cpList } from "../commands/sonic-cli/config-plane";
import { Device, interfaceByName, isSwitch } from "../models/device";
import { NetInterface } from "../models/interface";
import { Frame, cloneFrame } from "../models/packet";
import { featureState } from "../models/feature-state";
import { longestPrefixMatch } from "../models/route";
import { SimContext } from "../engine/context";
import { frameToBytes } from "../sflow/wire";
import { bytesToFrame } from "../packetgen/frame";
import { formatPacket } from "../commands/tcpdump";

/** One MIRROR_SESSION row as stored by the KLISH and Click front-ends. */
export interface MirrorSession {
  name: string;
  type?: string; // "span" | "erspan"
  dst?: string; // SPAN destination port
  src?: string; // comma-separated source ports
  direction?: string; // rx | tx | both
  src_ip?: string;
  dst_ip?: string;
  dscp?: string;
  ttl?: string;
  gre?: string;
  queue?: string;
  policer?: string;
}

export const GRE_PROTO = 47;
export const ERSPAN_DEFAULTS = { dscp: 8, ttl: 255, gre: 0x88be }; // mirrororch.cpp:56-72

export function mirrorSessions(device: Device): MirrorSession[] {
  return cpList(device, "mirror", "sessions") as unknown as MirrorSession[];
}

const isErspan = (s: MirrorSession) => s.type === "erspan";

/** STATE_DB status of a session: "active" | "inactive". */
export function sessionStatus(device: Device, s: MirrorSession): "active" | "inactive" {
  if (isErspan(s)) return s.src_ip && s.dst_ip && longestPrefixMatch(device.routingTable, s.dst_ip) ? "active" : "inactive";
  return s.dst && interfaceByName(device, s.dst) ? "active" : "inactive";
}

const sources = (s: MirrorSession) => (s.src ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const wants = (s: MirrorSession, dir: "rx" | "tx") => {
  const d = (s.direction || "both").toLowerCase();
  return d === "both" || d === dir;
};

const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const num = (v: string | undefined, dflt: number) => (v === undefined || v === "" ? dflt : Number(v));

/** GRE (S bit + sequence) + ERSPAN type II header + the mirrored frame's bytes. */
export function erspanPayload(frame: Frame, greType: number, seq: number): number[] {
  const vlan = frame.vlan?.vlanId ?? 0;
  const en = frame.vlan ? 3 : 0; // 3 = original VLAN tag preserved in the copy
  return [
    0x10, 0x00, ...u16(greType), ...u32(seq), // GRE: S bit, version 0
    (1 << 4) | ((vlan >> 8) & 0x0f), vlan & 0xff, // ver 1 (type II) | VLAN
    (en << 3), 0x00, // COS 0 | En | T 0 | session id 0
    0, 0, 0, 0, // reserved | index 0
    ...frameToBytes(frame),
  ];
}

let copying = false; // a copy being sent is never mirrored again

function mirror(ctx: SimContext, device: Device, iface: NetInterface, frame: Frame, dir: "rx" | "tx"): void {
  if (copying || !isSwitch(device.type)) return;
  const list = device.config.features?.cp_mirror ? mirrorSessions(device) : [];
  for (const s of list) {
    if (!wants(s, dir) || !sources(s).includes(iface.name) || sessionStatus(device, s) !== "active") continue;
    copying = true;
    try {
      if (isErspan(s)) {
        const st = featureState<{ seq: Record<string, number> }>(device, "mirror", () => ({ seq: {} }));
        const seq = (st.seq[s.name] = (st.seq[s.name] ?? 0) + 1);
        const greType = num(s.gre, ERSPAN_DEFAULTS.gre);
        sendIpv4(ctx, device, {
          src: s.src_ip!,
          dst: s.dst_ip!,
          ttl: num(s.ttl, ERSPAN_DEFAULTS.ttl),
          tos: (num(s.dscp, ERSPAN_DEFAULTS.dscp) << 2) & 0xfc,
          proto: GRE_PROTO,
          payload: erspanPayload(frame, greType, seq),
          summary: `ERSPAN ${s.name}: ${frame.meta.summary}`,
        });
      } else {
        const dst = interfaceByName(device, s.dst!)!;
        if (dst.id !== iface.id) {
          const copy = cloneFrame(frame);
          copy.meta.summary = `SPAN ${s.name}: ${frame.meta.summary}`;
          ctx.transmit(device.id, dst.id, copy);
        }
      }
    } finally {
      copying = false;
    }
  }
}

registerDataPlaneHook({
  id: "mirror",
  portIngress(ctx, device, iface, frame) {
    mirror(ctx, device, iface, frame, "rx");
    return true;
  },
  portEgress(ctx, device, iface, frame) {
    mirror(ctx, device, iface, frame, "tx");
    return true;
  },
});

// tcpdump for GRE/ERSPAN (tcpdump print-gre.c / print-erspan.c layout), inner frame with its link header.
registerDaemon({
  id: "mirror",
  describe(frame, verbose) {
    if (frame.ipv4?.protocol !== "OTHER" || frame.ipv4.protocolNumber !== GRE_PROTO || !frame.rawL3) return undefined;
    const gre = ipPayload(frame);
    if (!gre || gre.length < 4) return undefined;
    const proto = (gre[2] << 8) | gre[3];
    const hasSeq = (gre[0] & 0x10) !== 0;
    const seq = hasSeq && gre.length >= 8 ? ((gre[4] << 24) | (gre[5] << 16) | (gre[6] << 8) | gre[7]) >>> 0 : undefined;
    const hdr = `GREv0, ${seq !== undefined ? `seq ${seq}, ` : ""}proto ERSPAN (0x${proto.toString(16).padStart(4, "0")}), length ${gre.length}`;
    const off = hasSeq ? 8 : 4;
    if (proto !== 0x88be || gre.length < off + 8) return hdr;
    const e = gre.slice(off, off + 8);
    const vlan = ((e[0] & 0x0f) << 8) | e[1];
    const session = ((e[2] & 0x03) << 8) | e[3];
    let inner = "[|ether]";
    try {
      inner = formatPacket(bytesToFrame(gre.slice(off + 8), ""), { showEther: true, verbose }).join("\n");
    } catch {
      /* truncated */
    }
    return `${hdr}: ERSPAN v${(e[0] >> 4) + 1}, session ${session}, vlan ${vlan}\n${inner}`;
  },
});
