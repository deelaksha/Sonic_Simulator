/**
 * ICMP engine (spec §16, §17). Echo request/reply + error messages. Replies are
 * routed back through the real IP output path, so ping timing/output is derived
 * from the actual packet journey — never hardcoded.
 */
import { Device } from "../models/device";
import { NetInterface } from "../models/interface";
import { Frame, IcmpPayload, IcmpType } from "../models/packet";
import { SimContext } from "../engine/context";
import { ipOutput } from "./ipv4";

export const ICMP_HEADER_BYTES = 8;
export const ICMP_ECHO_DATA_BYTES = 56; // → 64-byte ICMP message, matching `ping`
export const ICMP_ECHO_TOTAL = ICMP_HEADER_BYTES + ICMP_ECHO_DATA_BYTES;

export function echoPayload(type: IcmpType, identifier: number, sequence: number): IcmpPayload {
  return { type, code: 0, identifier, sequence };
}

/**
 * Local delivery of an ICMP packet addressed to this device.
 * Echo request → generate and route an echo reply.
 * Echo reply → signal the origin that its ping succeeded.
 */
export function handleIcmpLocal(
  ctx: SimContext,
  device: Device,
  ingress: NetInterface,
  frame: Frame,
): void {
  const icmp = frame.icmp;
  const ip = frame.ipv4;
  if (!icmp || !ip) return;

  if (icmp.type === "echo-request") {
    const reply = echoPayload("echo-reply", icmp.identifier, icmp.sequence);
    ctx.emit({
      type: "ICMP_ECHO_REPLY",
      deviceId: device.id,
      deviceName: device.name,
      interfaceId: ingress.id,
      interfaceName: ingress.name,
      message: `${device.name}: echo request from ${ip.srcIp} → sending echo reply`,
      osiLayers: [3],
    });
    ipOutput(ctx, device, {
      srcIp: ip.dstIp, // reply comes from the address that was pinged
      dstIp: ip.srcIp,
      ttl: 64,
      protocol: "ICMP",
      identification: icmp.identifier,
      icmp: reply,
      upperBytes: ICMP_ECHO_TOTAL,
      summary: `ICMP echo reply id ${icmp.identifier} seq ${icmp.sequence}`,
    });
    return;
  }

  if (icmp.type === "echo-reply") {
    ctx.recordEchoReply(device.id, frame);
  }
}
