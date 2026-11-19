/** Remote syslog (rsyslog omfwd UDP/514), `config syslog`, KLISH `logging server`, `logger`. */
import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "../lib/labs";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";
import { l4Payload } from "../lib/control/packet";
import { formatPacket } from "../lib/commands/tcpdump";
import { CaptureRecord } from "../lib/engine";

const id = (dev: string) => byName(dev).id;
function bash(dev: string, cmd: string): string {
  if (byName(dev).type === "switch" && (S().cliMode[id(dev)] ?? ["exec"]).length) S().execCommand(id(dev), "exit");
  return out(S().execCommand(id(dev), cmd));
}
function klish(dev: string, ...lines: string[]): string {
  if (!(S().cliMode[id(dev)] ?? ["exec"]).length) S().execCommand(id(dev), "sonic-cli");
  return lines.map((l) => out(S().execCommand(id(dev), l))).join("\n");
}
const conn = (a: string, b: string) =>
  S().network.connections.find((c) => [c.a.deviceId, c.b.deviceId].sort().join() === [id(a), id(b)].sort().join())!;
/** Syslog datagrams received by `dev` on `port`. */
const rx = (dev: string, port = 514): CaptureRecord[] =>
  S().captures.filter((c) => c.deviceId === id(dev) && c.dir === "rx" && c.frame.udp?.dstPort === port);
const text = (c: CaptureRecord) => new TextDecoder().decode(l4Payload(c.frame)!);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
  S().loadFeatureLab("bgp");
  advance(3000);
});
afterEach(() => vi.useRealTimers());

describe("config syslog add / del (config/syslog.py) → UDP/514 forwarding", () => {
  it("forwards each new line as one RFC-3164-PRI datagram in SONiCForwardFormat; H1 stores it", () => {
    const r = bash("S1", "config syslog add 192.168.1.10");
    expect(r).toContain("Running command: systemctl restart rsyslog-config");
    expect(bash("S1", "show syslog").split("\n")).toEqual([
      "SERVER IP     SOURCE IP  PORT  VRF",
      "------------  ---------  ----  ---",
      "192.168.1.10  N/A        N/A   N/A",
    ]);
    advance(200);
    S().disconnect(conn("S1", "S2").id);
    advance(500);
    const got = rx("H1");
    expect(got.length).toBeGreaterThanOrEqual(4);
    for (const c of got) {
      expect(c.frame.ipv4).toMatchObject({ srcIp: "192.168.1.1", dstIp: "192.168.1.10", protocol: "UDP" });
      expect(c.frame.udp!.srcPort).toBeGreaterThanOrEqual(32768);
      expect(text(c).endsWith("\n")).toBe(true);
    }
    const msgs = got.map(text);
    // config's own log_notice (user.notice = 13), then bgpd (local4.info = 166), orchagent (user.notice = 13)
    expect(msgs[0]).toMatch(/^<13>\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}[+-]\d\d:\d\d s1 NOTICE config: Added remote syslog logging: server=192\.168\.1\.10,source=N\/A,port=N\/A,vrf=N\/A\n$/);
    expect(msgs).toContainEqual(expect.stringMatching(/^<166>\S+ s1 INFO bgp#bgpd\[\d+\]: %ADJCHANGE: neighbor 10\.0\.12\.2\(S2\) in vrf default Down Interface down\n$/));
    expect(msgs).toContainEqual(expect.stringMatching(/^<13>\S+ s1 NOTICE swss#orchagent: :- updatePortOperStatus: Port Ethernet0 oper state set from up to down\n$/));
    // the receiving host's rsyslog wrote them (traditional format), `show logging` there shows them
    const h1 = bash("H1", "show logging");
    expect(h1).toMatch(/^[A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d s1 INFO bgp#bgpd\[\d+\]: %ADJCHANGE: neighbor 10\.0\.12\.2\(S2\) in vrf default Down Interface down$/m);
    // lines logged before the server existed are not replayed
    expect(msgs.some((m) => m.includes(" Up\n"))).toBe(false);
  });

  it("tcpdump decodes the datagram like print-syslog.c", () => {
    bash("S1", "config syslog add 192.168.1.10");
    bash("S1", "logger -p local4.warning link flap test");
    advance(300);
    const c = rx("H1").find((x) => text(x).includes("link flap test"))!;
    expect(formatPacket(c.frame)[0]).toMatch(/^IP 192\.168\.1\.1\.\d+ > 192\.168\.1\.10\.514: SYSLOG local4\.warning, length: \d+$/);
    const v = formatPacket(c.frame, { verbose: true });
    expect(v[0]).toMatch(/SYSLOG, length: \d+\n\tFacility local4 \(20\), Severity warning \(4\)\n\tMsg: \S+ s1 WARNING admin: link flap test$/);
  });

  it("--port and --source are honoured; del stops forwarding; validation errors", () => {
    expect(bash("S1", "config syslog add 192.168.1.10 -p 5140 -s 10.0.13.1")).toContain("Running command");
    expect(bash("S1", "show syslog")).toMatch(/^192\.168\.1\.10\s+10\.0\.13\.1\s+5140\s+N\/A$/m);
    expect(bash("S1", "config syslog add 192.168.1.10")).toContain("192.168.1.10 is a valid syslog server");
    expect(bash("S1", "config syslog add 1.2.3")).toContain("does not appear to be an IPv4 or IPv6 address");
    expect(bash("S1", "config syslog add 192.168.1.11 -s 10.9.9.9")).toContain("10.9.9.9 IP doesn't exist in Linux default VRF");
    expect(bash("S1", "config syslog add 192.168.1.11 -p 70000")).toContain("is not in the valid range of 0 to 65535");
    bash("S1", "logger hello");
    advance(300);
    const c = rx("H1", 5140).find((x) => text(x).includes("admin: hello"))!;
    expect(c.frame.ipv4!.srcIp).toBe("10.0.13.1");
    expect(rx("H1", 514).length).toBe(0);
    expect(bash("S1", "config syslog del 192.168.1.10")).toContain("Running command");
    expect(bash("S1", "config syslog del 192.168.1.10")).toContain("192.168.1.10 is not a valid syslog server");
    const n = rx("H1", 5140).length;
    bash("S1", "logger after delete");
    advance(300);
    expect(rx("H1", 5140).length).toBe(n);
  });
});

describe("KLISH logging server (logging.xml) shares SYSLOG_SERVER", () => {
  it("severity filter: `severity notice` forwards NOTICE but not bgpd INFO; Click `show syslog` lists it", () => {
    klish("S1", "configure terminal", "logging server 192.168.1.10 severity notice", "end");
    expect(bash("S1", "show syslog")).toMatch(/^192\.168\.1\.10\s+N\/A\s+N\/A\s+N\/A$/m);
    S().disconnect(conn("S1", "S2").id);
    advance(500);
    const msgs = rx("H1").map(text);
    expect(msgs.some((m) => m.includes("swss#orchagent"))).toBe(true);
    expect(msgs.some((m) => m.includes("bgp#bgpd"))).toBe(false);
  });

  it("KLISH `show logging lines N` and `clear logging`", () => {
    const all = bash("S1", "show logging").split("\n");
    expect(klish("S1", "show logging lines 2").split("\n")).toEqual(all.slice(-2));
    expect(klish("S1", "show logging").split("\n")).toEqual(all);
    klish("S1", "clear logging");
    expect(klish("S1", "show logging").trim()).toBe("");
  });
});

describe("logger (util-linux)", () => {
  it("default tag/priority, -t, -p, -i, -s, errors", () => {
    bash("S1", "logger hello world");
    bash("S1", "logger -t mytag -p local0.err disk failing");
    bash("S1", "logger -i -t app started");
    const s = bash("S1", "logger -s -t x stderr copy");
    expect(s).toMatch(/^<13>[A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d x: stderr copy$/);
    const lines = bash("S1", "show logging -l 4").split("\n");
    expect(lines[0]).toMatch(/ s1 NOTICE admin: hello world$/);
    expect(lines[1]).toMatch(/ s1 ERR mytag: disk failing$/);
    expect(lines[2]).toMatch(/ s1 NOTICE app\[\d+\]: started$/);
    expect(bash("S1", "logger -p bogus.info x")).toContain("logger: unknown facility name: bogus");
    expect(bash("S1", "logger -p user.loud x")).toContain("logger: unknown priority name: loud");
    // on a PC the default tag is the shell user
    bash("H1", "logger from the host");
    expect(bash("H1", "show logging")).toMatch(/ h1 NOTICE h1: from the host$/m);
  });

  it("logger lines are forwarded with their facility (local0.err → PRI 131)", () => {
    bash("S1", "config syslog add 192.168.1.10");
    bash("S1", "logger -t mytag -p local0.err disk failing");
    advance(300);
    expect(rx("H1").map(text)).toContainEqual(expect.stringMatching(/^<131>\S+ s1 ERR mytag: disk failing\n$/));
  });
});
