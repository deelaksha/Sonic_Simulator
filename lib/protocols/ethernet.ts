/**
 * Ethernet framing helpers (spec §2 physical/§7 Ethernet). Pure builders — no
 * behavior. Frame sizes are realistic-ish approximations used for stats and the
 * "N bytes" ping/tcpdump output.
 */
import { EtherType, EthernetHeader, Frame, FrameMeta } from "../models/packet";
import { nextFrameId } from "../engine/ids";

export const ETH_HEADER_BYTES = 14;
export const ETH_FCS_BYTES = 4;
export const DOT1Q_BYTES = 4;
export const MIN_FRAME_BYTES = 64;

export interface BuildFrameInput {
  srcMac: string;
  dstMac: string;
  etherType: EtherType;
  payloadBytes: number; // size of everything above Ethernet
  summary: string;
  vlanId?: number; // when set, an 802.1Q tag is added
}

export function buildFrame(
  input: BuildFrameInput,
  layers: Pick<Frame, "arp" | "ipv4" | "icmp" | "ipv6" | "icmp6" | "udp" | "ntp" | "dhcp" | "dns" | "ospf" | "tcp" | "bgp">,
): Frame {
  const eth: EthernetHeader = {
    srcMac: input.srcMac,
    dstMac: input.dstMac,
    etherType: input.etherType,
  };
  const tagBytes = input.vlanId !== undefined ? DOT1Q_BYTES : 0;
  const wire = Math.max(
    MIN_FRAME_BYTES,
    ETH_HEADER_BYTES + tagBytes + input.payloadBytes + ETH_FCS_BYTES,
  );
  const meta: FrameMeta = { sizeBytes: wire, summary: input.summary };

  const frame: Frame = { id: nextFrameId(), ethernet: eth, meta, ...layers };
  if (input.vlanId !== undefined) {
    frame.vlan = { vlanId: input.vlanId, priority: 0 };
  }
  return frame;
}
