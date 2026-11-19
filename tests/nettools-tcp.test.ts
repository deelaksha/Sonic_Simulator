import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";
import { peekTcpStack } from "../lib/protocols/tcp-stack";

const term = (id: string) => (S().terminals[id] ?? []).map((l) => l.text);
const run = (dev: string, cmd: string) => out(S().execCommand(byName(dev).id, cmd));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(30_000_000);
  resetAll();
  S().loadFeatureLab("sflow"); // PC1 192.168.100.11 ─ SW1 ─ PC2 192.168.100.12
});
afterEach(() => vi.useRealTimers());

describe("host TCP stack + nc", () => {
  it("nc listener and client: handshake, one line of data, FIN close — all on the wire", () => {
    const pc2 = byName("PC2").id;
    expect(run("PC2", "nc -l 5000")).toMatch(/^Listening on 0\.0\.0\.0 5000/);
    expect(run("PC2", "nc -l")).toMatch(/tcp 0\.0\.0\.0:5000/);
    S().execCommand(pc2, "sudo tcpdump -i eth0 -nn tcp");

    expect(run("PC1", "nc -v 192.168.100.12 5000 hello from pc1")).toBe("Connection to 192.168.100.12 5000 port [tcp/*] succeeded!");
    S().stopLiveCapture(pc2);
    const pk = term(pc2).filter((t) => / IP 192\.168\.100\.1[12]\.\d+ > /.test(t));
    const flags = pk.map((t) => /Flags \[([^\]]+)\]/.exec(t)![1]);
    expect(flags).toEqual(["S", "S.", ".", "P.", ".", "F.", "F.", "."]);
    expect(pk[0]).toMatch(/192\.168\.100\.11\.\d+ > 192\.168\.100\.12\.5000: Flags \[S\], seq \d+, win 64240, length 0$/);
    expect(pk[3]).toMatch(/Flags \[P\.\], seq \d+, ack \d+, win 502, length 15$/);
    // seq/ack consistency: SYN-ACK acks ISN+1, the data segment acks the server ISN+1
    const num = (t: string, k: string) => Number(new RegExp(`${k} (\\d+)`).exec(t)![1]);
    expect(num(pk[1], "ack")).toBe(num(pk[0], "seq") + 1);
    expect(num(pk[3], "ack")).toBe(num(pk[1], "seq") + 1);
    expect(num(pk[4], "ack")).toBe(num(pk[3], "seq") + 15); // data ACKed
    expect(num(pk[5], "seq")).toBe(num(pk[3], "seq") + 15); // client FIN follows the data

    // Data waits on the listener; nc without -k has exited after the session.
    const r = run("PC2", "nc -l 5000");
    expect(r).toMatch(/^Connection received on 192\.168\.100\.11 \d+\nhello from pc1\n/);
    expect(r).toMatch(/listener on port 5000 has exited/);
    expect(peekTcpStack(byName("PC2"))!.conns).toHaveLength(0);
    expect(run("PC2", "nc -l")).toMatch(/no listeners/);
  });

  it("-k keeps listening across sessions; --stop closes it", () => {
    run("PC2", "nc -lk 6000");
    run("PC1", "nc 192.168.100.12 6000 one");
    run("PC1", "nc 192.168.100.12 6000 two");
    const r = run("PC2", "nc -l 6000");
    expect(r.split("\n").filter((l) => !l.startsWith("Connection"))).toEqual(["one", "two"]);
    expect(run("PC2", "nc -l 6000")).toMatch(/still listening/);
    expect(run("PC2", "nc -l --stop 6000")).toMatch(/closed/);
    expect(run("PC1", "nc 192.168.100.12 6000 three")).toMatch(/Connection refused/);
  });

  it("connection refused: RST,ACK when nothing listens", () => {
    const pc1 = byName("PC1").id;
    S().execCommand(pc1, "sudo tcpdump -i eth0 -nn tcp");
    expect(run("PC1", "nc 192.168.100.12 5555 hi")).toBe("nc: connect to 192.168.100.12 port 5555 (tcp) failed: Connection refused");
    S().stopLiveCapture(pc1);
    const pk = term(pc1).filter((t) => /Flags/.test(t));
    expect(pk).toHaveLength(2);
    expect(pk[1]).toMatch(/192\.168\.100\.12\.5555 > 192\.168\.100\.11\.\d+: Flags \[R\.\], seq 0, ack \d+, win 0, length 0$/);
  });

  it("connect timeout to a silent address; unreachable without a route", () => {
    expect(run("PC1", "nc 192.168.100.99 80")).toMatch(/nc: connect to 192\.168\.100\.99 port 80 \(tcp\) failed: No route to host/);
    expect(run("PC1", "nc 203.0.113.5 80")).toMatch(/failed: Network is unreachable|failed: No route to host/);
  });

  it("port scan: open / refused (PCs run no sshd; listeners on 22 and 8080)", () => {
    expect(run("PC1", "nc 192.168.100.12 22")).toMatch(/Connection refused/);
    run("PC2", "nc -lk 22");
    run("PC2", "nc -l 8080");
    const scan = run("PC1", "nc -zv 192.168.100.12 20-23,8080");
    expect(scan.split("\n")).toEqual([
      "nc: connect to 192.168.100.12 port 20 (tcp) failed: Connection refused",
      "nc: connect to 192.168.100.12 port 21 (tcp) failed: Connection refused",
      "Connection to 192.168.100.12 22 port [tcp/ssh] succeeded!",
      "nc: connect to 192.168.100.12 port 23 (tcp) failed: Connection refused",
      "Connection to 192.168.100.12 8080 port [tcp/*] succeeded!",
    ]);
    // without -v only the open ports are reported
    expect(run("PC1", "nc -z 192.168.100.12 21-22")).toBe("Connection to 192.168.100.12 22 port [tcp/ssh] succeeded!");
  });

  it("nc -u sends a UDP datagram that an nc -u -l listener logs", () => {
    run("PC2", "nc -u -l 7000");
    S().execCommand(byName("PC2").id, "sudo tcpdump -i eth0 -nn udp");
    expect(run("PC1", "nc -u -v 192.168.100.12 7000 ping over udp")).toBe("Connection to 192.168.100.12 7000 port [udp/*] succeeded!");
    S().stopLiveCapture(byName("PC2").id);
    expect(term(byName("PC2").id).some((t) => /192\.168\.100\.11\.\d+ > 192\.168\.100\.12\.7000: UDP, length 14$/.test(t))).toBe(true);
    expect(run("PC2", "nc -u -l 7000")).toMatch(/^ping over udp/);
  });
});

// NOTE: lib/commands/traffic.ts (frozen) still claims the "hping3" alias, which
// shadows nettools' hping3Command in the registry; the "hping" alias reaches it.
describe("hping3", () => {
  it("SYN to a closed port: flags=RA replies + statistics", () => {
    const r = run("PC1", "hping -S -p 81 -c 3 192.168.100.12");
    const lines = r.split("\n");
    expect(lines[0]).toBe("HPING 192.168.100.12 (eth0 192.168.100.12): S set, 40 headers + 0 data bytes");
    const replies = lines.filter((l) => l.startsWith("len="));
    expect(replies).toHaveLength(3);
    expect(replies[0]).toMatch(/^len=46 ip=192\.168\.100\.12 ttl=64 DF id=0 sport=81 flags=RA seq=0 win=0 rtt=\d+\.\d ms$/);
    expect(replies[2]).toMatch(/seq=2 /);
    expect(r).toMatch(/--- 192\.168\.100\.12 hping statistic ---\n3 packets transmitted, 3 packets received, 0% packet loss\nround-trip min\/avg\/max = [\d.]+\/[\d.]+\/[\d.]+ ms$/);
  });

  it("SYN to an open port gets SA, then the kernel RSTs; -A to a closed port gets a bare R", () => {
    const pc1 = byName("PC1").id;
    run("PC2", "nc -lk 8080");
    S().execCommand(pc1, "sudo tcpdump -i eth0 -nn tcp");
    expect(run("PC1", "hping -S -p 8080 -c 1 192.168.100.12")).toMatch(/sport=8080 flags=SA seq=0 win=64240/);
    S().stopLiveCapture(pc1);
    const flags = term(pc1).filter((t) => /Flags/.test(t)).map((t) => /Flags \[([^\]]+)\]/.exec(t)![1]);
    expect(flags).toEqual(["S", "S.", "R"]);
    expect(run("PC1", "hping -A -p 81 -c 1 192.168.100.12")).toMatch(/flags=R seq=0 win=0/);
  });

  it("ICMP mode and flood refusal", () => {
    expect(run("PC1", "hping -1 -c 2 192.168.100.12")).toMatch(/icmp mode set[\s\S]*len=46 ip=192\.168\.100\.12 ttl=64 id=\d+ icmp_seq=1 rtt=[\d.]+ ms[\s\S]*2 packets received/);
    expect(run("PC1", "hping --flood -S 192.168.100.12")).toMatch(/not available/);
  });
});

describe("arping", () => {
  it("replies from the neighbour; first probe broadcast then unicast", () => {
    const pc2 = byName("PC2");
    const mac = pc2.interfaces[0].mac.toUpperCase();
    const r = run("PC1", "arping -c 3 -I eth0 192.168.100.12");
    const reply = `Unicast reply from 192.168.100.12 [${mac}]  4.000ms`; // PC1 → SW1 → PC2 and back
    expect(r.split("\n")).toEqual([
      "ARPING 192.168.100.12 from 192.168.100.11 eth0",
      reply,
      reply,
      reply,
      "Sent 3 probes (1 broadcast(s))",
      "Received 3 response(s)",
    ]);
    expect(run("PC1", "arping -c 2 192.168.100.77")).toMatch(/Sent 2 probes \(2 broadcast\(s\)\)\nReceived 0 response\(s\)$/);
  });

  it("-D duplicate address detection: sender 0.0.0.0, a reply means duplicate", () => {
    const pc1 = byName("PC1").id;
    S().execCommand(pc1, "sudo tcpdump -i eth0 -nn arp");
    const dup = run("PC1", "arping -D -c 3 -I eth0 192.168.100.12");
    S().stopLiveCapture(pc1);
    expect(dup).toMatch(/^ARPING 192\.168\.100\.12 from 0\.0\.0\.0 eth0\nUnicast reply from 192\.168\.100\.12 \[/);
    expect(dup).toMatch(/Sent 1 probes \(1 broadcast\(s\)\)\nReceived 1 response\(s\)/);
    expect(term(pc1).some((t) => /ARP, Request who-has 192\.168\.100\.12 tell 0\.0\.0\.0/.test(t))).toBe(true);
    const free = run("PC1", "arping -D -c 2 -I eth0 192.168.100.50");
    expect(free).toMatch(/Sent 2 probes \(2 broadcast\(s\)\)\nReceived 0 response\(s\)$/);
  });
});

describe("OSPF triangle: mtr report + TCP to a routed switch", () => {
  it("a switch's own address: closed port → RST, sshd on 22 answers (router.ts path)", () => {
    resetAll();
    S().loadFeatureLab("ospf");
    advance(25_000);
    expect(run("H1", "nc 192.168.1.1 5555")).toBe("nc: connect to 192.168.1.1 port 5555 (tcp) failed: Connection refused");
    expect(run("H1", "nc -v 10.0.13.2 22")).toBe("Connection to 10.0.13.2 22 port [tcp/ssh] succeeded!\nSSH-2.0-OpenSSH_9.2p1 Debian-2+deb12u3");
    expect(run("H1", "hping -S -p 23 -c 1 10.0.13.2")).toMatch(/len=46 ip=10\.0\.13\.2 ttl=63 DF id=0 sport=23 flags=RA seq=0/);
  });

  it("shows every hop H1 → S1 → S3 → H3 with loss and latency", () => {
    resetAll();
    S().loadFeatureLab("ospf");
    advance(25_000);
    const r = run("H1", "mtr -r -c 5 -n 192.168.3.10");
    const lines = r.split("\n");
    expect(lines[0]).toMatch(/^Start: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+0000$/);
    expect(lines[1]).toMatch(/^HOST: H1\s+Loss%   Snt   Last   Avg  Best  Wrst StDev$/);
    const hops = lines.slice(2);
    expect(hops).toHaveLength(3);
    expect(hops[0]).toMatch(/^  1\.\|-- 192\.168\.1\.1\s+0\.0%     5(\s+\d+\.\d){5}$/);
    expect(hops[1]).toMatch(/^  2\.\|-- 10\.0\.13\.2\s+0\.0%     5/);
    expect(hops[2]).toMatch(/^  3\.\|-- 192\.168\.3\.10\s+0\.0%     5/);
    // latency grows with hop count
    const avg = (l: string) => Number(l.trim().split(/\s+/)[5]);
    expect(avg(hops[2])).toBeGreaterThan(avg(hops[0]));
  });
});
