/**
 * A pcap-filter(7) subset compiled to a predicate over simulated frames:
 *
 *   expr      := and-expr { (or | "||") and-expr }
 *   and-expr  := unary { (and | "&&") unary }
 *   unary     := (not | "!") unary | "(" expr ")" | primitive
 *   primitive := icmp | arp | ip | ip6 | tcp | udp | vlan [id]
 *              | [src|dst] host <ip> | [src|dst] net <cidr>
 *              | [tcp|udp] [src|dst] port <n> | [tcp|udp] [src|dst] portrange <a-b>
 *              | ether [src|dst] host <mac> | less <n> | greater <n>
 *
 * Adjacent primitives without an operator are an implicit `and` (as pcap does
 * for e.g. `udp port 6343`). Errors use tcpdump's wording.
 */
import { Frame } from "../models/packet";
import { cidrContains } from "../models/ip";
import { wireLength } from "../sflow/wire";

export type FramePredicate = (frame: Frame) => boolean;

export class BpfSyntaxError extends Error {}

function l4Ports(f: Frame): { src: number; dst: number } | null {
  if (f.udp) return { src: f.udp.srcPort, dst: f.udp.dstPort };
  if (f.tcp) return { src: f.tcp.srcPort, dst: f.tcp.dstPort };
  return null;
}

function ips(f: Frame): { src?: string; dst?: string } {
  if (f.ipv4) return { src: f.ipv4.srcIp, dst: f.ipv4.dstIp };
  if (f.arp) return { src: f.arp.senderIp, dst: f.arp.targetIp };
  return {};
}

const eqMac = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function compileFilter(expression: string): FramePredicate {
  const tokens = expression
    .replace(/\(/g, " ( ")
    .replace(/\)/g, " ) ")
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.length) return () => true;
  let i = 0;
  const peek = () => tokens[i]?.toLowerCase();
  const next = () => tokens[i++];
  const fail = (): never => {
    throw new BpfSyntaxError("syntax error in filter expression: syntax error");
  };
  const num = (t: string | undefined): number => {
    if (t === undefined || !/^\d+$/.test(t)) fail();
    return Number(t);
  };

  function primitive(): FramePredicate {
    const t = peek();
    if (t === undefined) return fail();
    let dir: "src" | "dst" | undefined;
    let proto: "tcp" | "udp" | undefined;

    if (t === "ether") {
      next();
      if (peek() === "src" || peek() === "dst") dir = next().toLowerCase() as "src" | "dst";
      if (peek() !== "host") fail();
      next();
      const m = next();
      if (!m || !/^([0-9a-f]{1,2}:){5}[0-9a-f]{1,2}$/i.test(m)) fail();
      return (f) =>
        dir === "src" ? eqMac(f.ethernet.srcMac, m) : dir === "dst" ? eqMac(f.ethernet.dstMac, m) : eqMac(f.ethernet.srcMac, m) || eqMac(f.ethernet.dstMac, m);
    }
    if (t === "less" || t === "greater") {
      next();
      const n = num(next());
      return t === "less" ? (f) => wireLength(f) <= n : (f) => wireLength(f) >= n;
    }
    if (t === "vlan") {
      next();
      if (peek() && /^\d+$/.test(peek()!)) {
        const id = num(next());
        return (f) => f.vlan?.vlanId === id;
      }
      return (f) => !!f.vlan;
    }
    if (t === "tcp" || t === "udp") {
      const after = tokens[i + 1]?.toLowerCase();
      if (after === "port" || after === "portrange" || after === "src" || after === "dst") {
        proto = next().toLowerCase() as "tcp" | "udp";
      } else {
        next();
        return t === "tcp" ? (f) => !!f.tcp : (f) => !!f.udp;
      }
    }
    if (peek() === "src" || peek() === "dst") dir = next().toLowerCase() as "src" | "dst";

    const kw = next()?.toLowerCase();
    if (kw === "icmp" && !dir && !proto) return (f) => !!f.icmp;
    if (kw === "arp" && !dir && !proto) return (f) => !!f.arp;
    if (kw === "ip" && !dir && !proto) return (f) => !!f.ipv4;
    if (kw === "ip6" && !dir && !proto) return (f) => !!f.ipv6;
    if (kw === "host" && !proto) {
      const h = next();
      if (!h) fail();
      return (f) => {
        const a = ips(f);
        return dir === "src" ? a.src === h : dir === "dst" ? a.dst === h : a.src === h || a.dst === h;
      };
    }
    if (kw === "net" && !proto) {
      const spec = next() ?? fail();
      const [net, lenStr] = spec.split("/");
      const len = lenStr === undefined ? 32 : num(lenStr);
      const inNet = (ip?: string) => !!ip && cidrContains(net, len, ip);
      return (f) => {
        const a = ips(f);
        return dir === "src" ? inNet(a.src) : dir === "dst" ? inNet(a.dst) : inNet(a.src) || inNet(a.dst);
      };
    }
    if (kw === "port" || kw === "portrange") {
      let lo: number;
      let hi: number;
      if (kw === "port") lo = hi = num(next());
      else {
        const m = /^(\d+)-(\d+)$/.exec(next() ?? "");
        if (!m) return fail();
        lo = Number(m[1]);
        hi = Number(m[2]);
      }
      const inRange = (p: number) => p >= lo && p <= hi;
      return (f) => {
        if (proto === "tcp" && !f.tcp) return false;
        if (proto === "udp" && !f.udp) return false;
        const p = l4Ports(f);
        if (!p) return false;
        return dir === "src" ? inRange(p.src) : dir === "dst" ? inRange(p.dst) : inRange(p.src) || inRange(p.dst);
      };
    }
    return fail();
  }

  function unary(): FramePredicate {
    const t = peek();
    if (t === "not" || t === "!") {
      next();
      const p = unary();
      return (f) => !p(f);
    }
    if (t === "(") {
      next();
      const p = orExpr();
      if (next() !== ")") fail();
      return p;
    }
    return primitive();
  }

  function andExpr(): FramePredicate {
    let p = unary();
    for (;;) {
      const t = peek();
      if (t === "and" || t === "&&") next();
      else if (t === undefined || t === "or" || t === "||" || t === ")") break;
      // implicit and between adjacent primitives
      const left = p;
      const right = unary();
      p = (f) => left(f) && right(f);
    }
    return p;
  }

  function orExpr(): FramePredicate {
    let p = andExpr();
    while (peek() === "or" || peek() === "||") {
      next();
      const left = p;
      const right = andExpr();
      p = (f) => left(f) || right(f);
    }
    return p;
  }

  const pred = orExpr();
  if (i < tokens.length) fail();
  return pred;
}
