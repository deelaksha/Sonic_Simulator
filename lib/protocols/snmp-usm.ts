/**
 * SNMPv3 message framing (RFC 3412 §6) and the User-based Security Model
 * (RFC 3414) with HMAC-MD5-96 / HMAC-SHA-96 authentication and AES-128-CFB
 * privacy (RFC 3826), as net-snmp 5.9.3 implements them (snmplib/snmpusm.c,
 * keytools.c, scapi.c):
 *
 *   SNMPv3Message ::= SEQUENCE { msgVersion INTEGER (3),
 *       msgGlobalData SEQUENCE { msgID, msgMaxSize, msgFlags OCTET STRING (1), msgSecurityModel (3) },
 *       msgSecurityParameters OCTET STRING (UsmSecurityParameters),
 *       msgData ScopedPDU | encryptedPDU OCTET STRING }
 *   UsmSecurityParameters ::= SEQUENCE { engineID, engineBoots, engineTime, userName,
 *       authenticationParameters (12 bytes), privacyParameters (8 bytes) }
 *   ScopedPDU ::= SEQUENCE { contextEngineID, contextName, PDU }
 *
 * Keys: password-to-key over 1 MiB of the repeated password, then localized with
 * the authoritative engine ID (RFC 3414 A.2, keytools.c generate_Ku / generate_kul).
 * The AES key is the first 16 bytes of the localized privacy key; IV = engineBoots ||
 * engineTime || the 8-byte salt carried in privacyParameters (RFC 3826 §3.1.2.1).
 * DES privacy and the SHA-2 family are not modelled.
 */
import { SnmpPdu, ber, decodePduAt, encodePdu } from "./snmp-ber";
import { HashFn, aes128Cfb, hmac, md5, sha1 } from "./snmp-crypto";

const { TAG, tlv, intBody, readTlv, readInt, expect } = ber;

export const FLAG = { AUTH: 0x01, PRIV: 0x02, REPORTABLE: 0x04 } as const;
export type SecLevel = "noAuthNoPriv" | "authNoPriv" | "authPriv";
export const levelFlags = (l: SecLevel) => (l === "noAuthNoPriv" ? 0 : l === "authNoPriv" ? FLAG.AUTH : FLAG.AUTH | FLAG.PRIV);
export const flagsLevel = (f: number): SecLevel => (f & FLAG.PRIV ? "authPriv" : f & FLAG.AUTH ? "authNoPriv" : "noAuthNoPriv");
export const LEVEL_RANK: Record<SecLevel, number> = { noAuthNoPriv: 0, authNoPriv: 1, authPriv: 2 };

/** A USM user (credentials as typed; keys are derived per engine). */
export interface UsmUser {
  name: string;
  authProto?: "MD5" | "SHA";
  authPassword?: string;
  privProto?: "AES" | "DES";
  privPassword?: string;
}

export interface V3Message {
  msgId: number;
  maxSize: number;
  flags: number;
  engineId: number[];
  boots: number;
  time: number;
  user: string;
  authParams: number[];
  privParams: number[];
  /** Plaintext scoped PDU (absent when encrypted and not yet decrypted). */
  scoped?: { contextEngineId: number[]; contextName: string; pdu: SnmpPdu };
  encrypted?: number[];
}

/** usmStats* counters (SNMP-USER-BASED-SM-MIB 1.3.6.1.6.3.15.1.1.N.0). */
export const USM_STATS = {
  unsupportedSecLevels: [1, 3, 6, 1, 6, 3, 15, 1, 1, 1, 0],
  notInTimeWindows: [1, 3, 6, 1, 6, 3, 15, 1, 1, 2, 0],
  unknownUserNames: [1, 3, 6, 1, 6, 3, 15, 1, 1, 3, 0],
  unknownEngineIDs: [1, 3, 6, 1, 6, 3, 15, 1, 1, 4, 0],
  wrongDigests: [1, 3, 6, 1, 6, 3, 15, 1, 1, 5, 0],
  decryptionErrors: [1, 3, 6, 1, 6, 3, 15, 1, 1, 6, 0],
} as const;

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const octets = (t: { start: number; end: number }, b: ArrayLike<number>) => Array.from({ length: t.end - t.start }, (_, i) => b[t.start + i]);

function encodeScoped(sc: NonNullable<V3Message["scoped"]>): number[] {
  return tlv(TAG.SEQ, [...tlv(TAG.OCTET, sc.contextEngineId), ...tlv(TAG.OCTET, ascii(sc.contextName)), ...encodePdu(sc.pdu)]);
}

function decodeScoped(b: ArrayLike<number>, off: number, limit: number): NonNullable<V3Message["scoped"]> {
  const seq = expect(readTlv(b, off, limit), TAG.SEQ);
  const ce = expect(readTlv(b, seq.start, seq.end), TAG.OCTET);
  const cn = expect(readTlv(b, ce.next, seq.end), TAG.OCTET);
  return { contextEngineId: octets(ce, b), contextName: String.fromCharCode(...octets(cn, b)), pdu: decodePduAt(b, cn.next, seq.end) };
}

/** BER of a v3 message exactly as given (authParams/privParams/encrypted untouched). */
export function encodeV3(m: V3Message): number[] {
  const global = tlv(TAG.SEQ, [...tlv(TAG.INTEGER, intBody(m.msgId)), ...tlv(TAG.INTEGER, intBody(m.maxSize)), ...tlv(TAG.OCTET, [m.flags]), ...tlv(TAG.INTEGER, intBody(3))]);
  const usm = tlv(TAG.SEQ, [
    ...tlv(TAG.OCTET, m.engineId),
    ...tlv(TAG.INTEGER, intBody(m.boots)),
    ...tlv(TAG.INTEGER, intBody(m.time)),
    ...tlv(TAG.OCTET, ascii(m.user)),
    ...tlv(TAG.OCTET, m.authParams),
    ...tlv(TAG.OCTET, m.privParams),
  ]);
  const data = m.encrypted ? tlv(TAG.OCTET, m.encrypted) : encodeScoped(m.scoped!);
  return tlv(TAG.SEQ, [...tlv(TAG.INTEGER, intBody(3)), ...global, ...tlv(TAG.OCTET, usm), ...data]);
}

/** Decode a v3 message; returns the offset of authParams' contents for verification. */
export function decodeV3(b: ArrayLike<number>): { msg: V3Message; secModel: number; authOffset: number } {
  const top = expect(readTlv(b, 0, b.length), TAG.SEQ);
  const ver = expect(readTlv(b, top.start, top.end), TAG.INTEGER);
  if (readInt(b, ver) !== 3) throw new Error("not SNMPv3");
  const g = expect(readTlv(b, ver.next, top.end), TAG.SEQ);
  const id = expect(readTlv(b, g.start, g.end), TAG.INTEGER);
  const max = expect(readTlv(b, id.next, g.end), TAG.INTEGER);
  const fl = expect(readTlv(b, max.next, g.end), TAG.OCTET);
  const sm = expect(readTlv(b, fl.next, g.end), TAG.INTEGER);
  const sp = expect(readTlv(b, g.next, top.end), TAG.OCTET);
  const usm = expect(readTlv(b, sp.start, sp.end), TAG.SEQ);
  const eid = expect(readTlv(b, usm.start, usm.end), TAG.OCTET);
  const boots = expect(readTlv(b, eid.next, usm.end), TAG.INTEGER);
  const time = expect(readTlv(b, boots.next, usm.end), TAG.INTEGER);
  const user = expect(readTlv(b, time.next, usm.end), TAG.OCTET);
  const auth = expect(readTlv(b, user.next, usm.end), TAG.OCTET);
  const priv = expect(readTlv(b, auth.next, usm.end), TAG.OCTET);
  const flags = fl.end > fl.start ? b[fl.start] : 0;
  const dataT = readTlv(b, sp.next, top.end);
  const msg: V3Message = {
    msgId: readInt(b, id),
    maxSize: readInt(b, max),
    flags,
    engineId: octets(eid, b),
    boots: readInt(b, boots),
    time: readInt(b, time),
    user: String.fromCharCode(...octets(user, b)),
    authParams: octets(auth, b),
    privParams: octets(priv, b),
  };
  if (dataT.tag === TAG.OCTET) msg.encrypted = octets(dataT, b);
  else msg.scoped = decodeScoped(b, sp.next, top.end);
  return { msg, secModel: readInt(b, sm), authOffset: auth.start };
}

// ---------------------------------------------------------------- keys

const hashOf = (p: "MD5" | "SHA" | undefined): HashFn => (p === "SHA" ? sha1 : md5);
const keyCache = new Map<string, number[]>();

/** RFC 3414 A.2: password → Ku (1 MiB digest) → Kul localized to `engineId`. */
export function localizedKey(proto: "MD5" | "SHA", password: string, engineId: number[]): number[] {
  const ck = `${proto}|${password}|${engineId.join(",")}`;
  const hit = keyCache.get(ck);
  if (hit) return hit;
  const pw = ascii(password);
  const buf = new Array<number>(1048576);
  for (let i = 0; i < buf.length; i++) buf[i] = pw[i % pw.length];
  const h = hashOf(proto);
  const ku = h(buf);
  const kul = h([...ku, ...engineId, ...ku]);
  keyCache.set(ck, kul);
  return kul;
}

function authDigest(user: UsmUser, engineId: number[], wholeMsg: number[]): number[] {
  return hmac(hashOf(user.authProto), localizedKey(user.authProto ?? "MD5", user.authPassword ?? "", engineId), wholeMsg).slice(0, 12);
}

function privKeyIv(user: UsmUser, m: V3Message): { key: number[]; iv: number[] } {
  const key = localizedKey(user.authProto ?? "MD5", user.privPassword ?? "", m.engineId).slice(0, 16);
  const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  return { key, iv: [...u32(m.boots), ...u32(m.time), ...m.privParams] };
}

/**
 * Secure and encode an outgoing message at the security level in m.flags:
 * encrypt the scoped PDU (AES, fresh salt) and fill in the authentication digest.
 */
export function secureV3(m: V3Message, user: UsmUser | undefined, salt: number): number[] {
  const out: V3Message = { ...m, authParams: [], privParams: [] };
  if (m.flags & FLAG.PRIV && user) {
    out.privParams = [0, 0, 0, 0, (salt >>> 24) & 0xff, (salt >>> 16) & 0xff, (salt >>> 8) & 0xff, salt & 0xff];
    const { key, iv } = privKeyIv(user, out);
    out.encrypted = aes128Cfb(key, iv, encodeScoped(m.scoped!), true);
  }
  if (!(m.flags & FLAG.AUTH) || !user) return encodeV3(out);
  out.authParams = new Array(12).fill(0);
  const bytes = encodeV3(out);
  const { authOffset } = decodeV3(bytes);
  const digest = authDigest(user, out.engineId, bytes);
  for (let i = 0; i < 12; i++) bytes[authOffset + i] = digest[i];
  return bytes;
}

export type UsmError = "wrongDigest" | "decryptionError";

/** Verify the digest (if authenticated) and decrypt (if private). Mutates msg.scoped. */
export function unsecureV3(bytes: number[], d: { msg: V3Message; authOffset: number }, user: UsmUser): UsmError | undefined {
  const m = d.msg;
  if (m.flags & FLAG.AUTH) {
    const zeroed = [...bytes];
    for (let i = 0; i < 12; i++) zeroed[d.authOffset + i] = 0;
    const want = authDigest(user, m.engineId, zeroed);
    if (m.authParams.length !== 12 || want.some((x, i) => x !== m.authParams[i])) return "wrongDigest";
  }
  if (m.flags & FLAG.PRIV) {
    if (!m.encrypted || m.privParams.length !== 8 || user.privProto !== "AES") return "decryptionError";
    const { key, iv } = privKeyIv(user, m);
    try {
      const plain = aes128Cfb(key, iv, m.encrypted, false);
      m.scoped = decodeScoped(plain, 0, plain.length);
    } catch {
      return "decryptionError";
    }
  }
  return undefined;
}

/** Highest security level the user's credentials support (USM user row). */
export function userMaxLevel(u: UsmUser): SecLevel {
  if (!u.authProto) return "noAuthNoPriv";
  return u.privProto ? "authPriv" : "authNoPriv";
}

/** net-snmp default engineID: enterprise 8072, format 128 (random) — 80 00 1f 88 80 + 8 bytes (snmpv3.c setup_engineID). */
export function defaultEngineId(seed: string): number[] {
  let h1 = 0x811c9dc5;
  let h2 = 0x2545f491;
  for (const ch of seed) {
    h1 = Math.imul(h1 ^ ch.charCodeAt(0), 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ch.charCodeAt(0), 0x5bd1e995) >>> 0;
  }
  const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  return [0x80, 0x00, 0x1f, 0x88, 0x80, ...u32(h1), ...u32(h2)];
}

export const hexOf = (b: number[]) => b.map((x) => x.toString(16).padStart(2, "0")).join("");
