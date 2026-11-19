/**
 * BFD control packet wire format (RFC 5880 §4.1, mandatory section only — no
 * authentication) and its tcpdump rendering.
 *
 *    0                   1                   2                   3
 *   |Vers |  Diag   |Sta|P|F|C|A|D|M|  Detect Mult  |    Length     |
 *   |                       My Discriminator                        |
 *   |                      Your Discriminator                       |
 *   |                    Desired Min TX Interval                    |
 *   |                   Required Min RX Interval                    |
 *   |                 Required Min Echo RX Interval                 |
 *
 * Encoding follows FRR bfdd ptm_bfd_snd() (bfd_packet.c:416-466): intervals in
 * microseconds, length 24 (BFD_PKT_LEN, bfd.h:444), P and F never both set.
 */

export const BFD_PKT_LEN = 24;
export const BFD_VERSION = 1;
/** RFC 5881 §4 single-hop / RFC 5883 §5 multihop destination ports (bfd.h:453,455). */
export const BFD_PORT_SINGLEHOP = 3784;
export const BFD_PORT_MULTIHOP = 4784;

/** Session states as encoded on the wire (RFC 5880 §4.1; bfd.h PTM_BFD_*). */
export const ST_ADMIN_DOWN = 0;
export const ST_DOWN = 1;
export const ST_INIT = 2;
export const ST_UP = 3;

export interface BfdPacket {
  version: number;
  diag: number;
  state: number;
  poll: boolean;
  final: boolean;
  cpi: boolean;
  auth: boolean;
  demand: boolean;
  multipoint: boolean;
  detectMult: number;
  length: number;
  myDisc: number;
  yourDisc: number;
  /** Microseconds, as on the wire. */
  desiredMinTx: number;
  requiredMinRx: number;
  requiredMinEchoRx: number;
}

const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const rd32 = (b: ArrayLike<number>, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

export function encodeBfd(p: Omit<BfdPacket, "version" | "length" | "cpi" | "auth" | "demand" | "multipoint">): number[] {
  const flags = ((p.state & 3) << 6) | (p.poll && !p.final ? 0x20 : 0) | (p.final ? 0x10 : 0);
  return [
    (BFD_VERSION << 5) | (p.diag & 0x1f),
    flags,
    p.detectMult & 0xff,
    BFD_PKT_LEN,
    ...u32(p.myDisc),
    ...u32(p.yourDisc),
    ...u32(p.desiredMinTx),
    ...u32(p.requiredMinRx),
    ...u32(p.requiredMinEchoRx),
  ];
}

/** Decode the mandatory section; undefined if fewer than 24 bytes. */
export function decodeBfd(b: ArrayLike<number>): BfdPacket | undefined {
  if (b.length < BFD_PKT_LEN) return undefined;
  return {
    version: b[0] >> 5,
    diag: b[0] & 0x1f,
    state: b[1] >> 6,
    poll: !!(b[1] & 0x20),
    final: !!(b[1] & 0x10),
    cpi: !!(b[1] & 0x08),
    auth: !!(b[1] & 0x04),
    demand: !!(b[1] & 0x02),
    multipoint: !!(b[1] & 0x01),
    detectMult: b[2],
    length: b[3],
    myDisc: rd32(b, 4),
    yourDisc: rd32(b, 8),
    desiredMinTx: rd32(b, 12),
    requiredMinRx: rd32(b, 16),
    requiredMinEchoRx: rd32(b, 20),
  };
}

// --- tcpdump (print-bfd.c, tcpdump 4.99: bfd_port_values, bfd_v1_state_values,
// bfd_v1_flag_values, bfd_diag_values; not in the local source tree) ---------

const TD_STATE = ["AdminDown", "Down", "Init", "Up"];
const TD_DIAG = [
  "No Diagnostic",
  "Control Detection Time Expired",
  "Echo Function Failed",
  "Neighbor Signaled Session Down",
  "Forwarding Plane Reset",
  "Path Down",
  "Concatenated Path Down",
  "Administratively Down",
  "Reverse Concatenated Path Down",
];

function tdFlags(p: BfdPacket): string {
  const f: string[] = [];
  if (p.poll) f.push("Poll");
  if (p.final) f.push("Final");
  if (p.cpi) f.push("Control Plane Independent");
  if (p.auth) f.push("Authentication Present");
  if (p.demand) f.push("Demand");
  if (p.multipoint) f.push("Multipoint");
  return f.length ? f.join(", ") : "none";
}

/** tcpdump text after "IP src.sport > dst.dport: ". `udpLen` = UDP payload length. */
export function tcpdumpBfd(p: BfdPacket, dport: number, udpLen: number, verbose: boolean): string {
  const kind = dport === BFD_PORT_MULTIHOP ? "Multihop" : "Control";
  const st = TD_STATE[p.state];
  if (!verbose) return `BFDv${p.version}, ${kind}, State ${st}, Flags: [${tdFlags(p)}], length: ${udpLen}`;
  const ms = (us: number) => String(Math.floor(us / 1000)).padStart(4);
  return [
    `BFDv${p.version}, length: ${udpLen}`,
    `\t${kind}, State ${st}, Flags: [${tdFlags(p)}], Diagnostic: ${TD_DIAG[p.diag] ?? "unknown"} (0x${p.diag.toString(16).padStart(2, "0")})`,
    `\tDetection Timer Multiplier: ${p.detectMult} (${Math.floor((p.detectMult * p.requiredMinRx) / 1000)} ms Detection time), BFD Length: ${p.length}`,
    `\tMy Discriminator: 0x${p.myDisc.toString(16).padStart(8, "0")}, Your Discriminator: 0x${p.yourDisc.toString(16).padStart(8, "0")}`,
    `\t  Desired min Tx Interval:    ${ms(p.desiredMinTx)} ms`,
    `\t  Required min Rx Interval:   ${ms(p.requiredMinRx)} ms`,
    `\t  Required min Echo Interval: ${ms(p.requiredMinEchoRx)} ms`,
  ].join("\n");
}

// --- echo packets (FRR bfdd struct bfd_echo_pkt, bfd.h:141-153) -------------

/** RFC 5881 §4 echo destination port (BFD_DEF_ECHO_PORT, bfd.h:454). */
export const BFD_PORT_ECHO = 3785;
export const BFD_ECHO_VERSION = 1; // bfd.h:198
export const BFD_ECHO_PKT_LEN = 24; // sizeof(struct bfd_echo_pkt)

/**
 * ver(1) len(1) reserved(2) my_discr(4) time_sent_sec(8) time_sent_usec(8), as
 * ptm_bfd_echo_fp_snd builds it (bfd_packet.c:260-270): the send time lets the
 * sender compute the round-trip time when the peer's forwarding plane loops it back.
 */
export function encodeBfdEcho(myDisc: number, sentMs: number): number[] {
  const sec = Math.floor(sentMs / 1000);
  const usec = Math.round((sentMs - sec * 1000) * 1000);
  const u64 = (n: number) => [0, 0, 0, 0, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  return [BFD_ECHO_VERSION, BFD_ECHO_PKT_LEN, 0, 0, (myDisc >>> 24) & 0xff, (myDisc >>> 16) & 0xff, (myDisc >>> 8) & 0xff, myDisc & 0xff, ...u64(sec), ...u64(usec)];
}

export function decodeBfdEcho(b: Uint8Array): { myDisc: number; sentMs: number } | undefined {
  if (b.length < BFD_ECHO_PKT_LEN) return undefined; // "small echo packet" (bfd_packet.c:1150)
  const u32 = (o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  return { myDisc: u32(4), sentMs: u32(12) * 1000 + u32(20) / 1000 };
}
