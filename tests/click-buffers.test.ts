/**
 * Click buffer / watermark / PG / queue-group show commands (lib/commands/sonic/buffers.ts),
 * checked against sonic-utilities show/main.py and the scripts it runs. QoS lab:
 * H1 → S1 → Ethernet2 → H3, S1 left at its bash prompt.
 */
import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetAll } from "./helpers";
import { S, advance, byName } from "./control-helpers";
import { iperf, sw } from "./qos-helpers";
import { peekFeatureState } from "../lib/models/feature-state";
import { QueueCounters } from "../lib/protocols/qos-model";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(60_000_000);
  resetAll();
  S().loadFeatureLab("qos");
});
afterEach(() => vi.useRealTimers());

const S1 = () => byName("S1").id;
const show = (cmd: string) => sw(S1(), cmd);
const uc0 = () => peekFeatureState<QueueCounters>(byName("S1"), "qos-queues")!.Ethernet2[0];

describe("bare Click groups print the group help", () => {
  it("show queue / priority-group / pfcwd / dropcounters ...", () => {
    const q = show("show queue").split("\n");
    expect(q[0]).toBe("Usage: show queue [OPTIONS] COMMAND [ARGS]...");
    expect(q[2]).toBe("  Show details of the queues");
    expect(q.slice(q.indexOf("Commands:") + 1).map((l) => l.trim().split(/\s+/)[0])).toEqual(["counters", "persistent-watermark", "watermark", "wredcounters"]);
    expect(show("show priority-group")).toContain("Usage: show priority-group [OPTIONS] COMMAND [ARGS]...");
    expect(show("show priority-group watermark")).toMatch(/headroom\s+Show user headroom WM for pg\n\s+shared\s+Show user shared WM for pg$/);
    expect(show("show pfcwd")).toMatch(/^Usage: show pfcwd \[OPTIONS\] COMMAND \[ARGS\]\.\.\.\n\n  Show details of the pfc watchdog/);
    expect(show("show dropcounters")).toMatch(/capabilities[\s\S]*configuration[\s\S]*counts\s+Show drop counts/);
    for (const g of ["buffer", "buffer_pool", "headroom-pool", "queue watermark", "queue persistent-watermark", "priority-group drop", "watermark telemetry"]) {
      expect(show(`show ${g}`)).toMatch(new RegExp(`^Usage: show ${g} \\[OPTIONS\\] COMMAND`));
    }
  });

  it("paths the real source does not define are Click errors", () => {
    expect(show("show priority-group watermark unicast")).toBe(
      'Usage: show priority-group watermark [OPTIONS] COMMAND [ARGS]...\nTry "show priority-group watermark -h" for help.\n\nError: No such command "unicast".',
    );
    expect(show("show priority-group watermark telemetry")).toContain('No such command "telemetry"');
  });
});

describe("watermarkstat / pg-drop layouts", () => {
  it("priority-group watermarks and drops: PG0-7 per port, 0 (ingress not modelled)", () => {
    const h = show("show priority-group watermark headroom").split("\n");
    expect(h[0]).toBe("Ingress headroom per PG:");
    expect(h[1]).toBe("     Port    PG0    PG1    PG2    PG3    PG4    PG5    PG6    PG7");
    expect(h[2]).toBe("---------  -----  -----  -----  -----  -----  -----  -----  -----");
    expect(h[3]).toBe("Ethernet0      0      0      0      0      0      0      0      0");
    expect(show("show priority-group persistent-watermark shared").split("\n")[0]).toBe("Ingress shared pool occupancy per PG:");
    const d = show("show priority-group drop counters").split("\n");
    expect(d[0]).toBe("Ingress PG dropped packets:");
    expect(d[1]).toBe(h[1]);
  });

  it("buffer_pool / headroom-pool watermarks; egress_lossy_pool follows live queue peaks", () => {
    expect(show("show headroom-pool watermark")).toBe(
      ["Headroom pool maximum occupancy:", "                 Pool    Bytes", "---------------------  -------", "ingress_lossless_pool        0"].join("\n"),
    );
    sw(S1(), "config interface speed Ethernet2 100");
    iperf(byName("H3").id, "iperf3 -s");
    iperf(byName("H1").id, "iperf3 -c 192.168.3.10 -u -b 200M -t 2");
    advance(1000);
    const bp = show("show buffer_pool watermark").split("\n");
    expect(bp[0]).toBe("Shared pool maximum occupancy:");
    expect(bp[1].trim().split(/\s+/)).toEqual(["Pool", "Bytes"]);
    expect(bp.slice(3).map((l) => l.trim().split(/\s+/)[0])).toEqual(["egress_lossless_pool", "egress_lossy_pool", "ingress_lossless_pool"]);
    expect(bp[4]).toMatch(new RegExp(`egress_lossy_pool\\s+${uc0().wm}$`));
    expect(uc0().wm).toBeGreaterThan(0);
    expect(show("show buffer_pool persistent-watermark")).toBe(bp.join("\n"));
  });

  it("queue watermark groups: unicast/multicast via watermarkstat, all has no ALL queues", () => {
    expect(show("show queue watermark unicast").split("\n")[0]).toBe("Egress shared pool occupancy per unicast queue:");
    expect(show("show queue persistent-watermark multicast").split("\n")[1]).toMatch(/Port\s+MC8\s+MC9/);
    expect(show("show queue watermark all")).toBe("Object map is empty!");
  });

  it("watermark telemetry interval defaults to 120 s", () => {
    expect(show("show watermark telemetry interval")).toBe("\nTelemetry interval 120 second(s)\n");
  });
});

describe("wredstat", () => {
  it("per-port blocks with the real header and live WRED drops", () => {
    sw(S1(), "config interface speed Ethernet2 100");
    sw(S1(), "config qos interface bind Ethernet2 wred-policy LAB-WRED");
    iperf(byName("H3").id, "iperf3 -s");
    iperf(byName("H1").id, "iperf3 -c 192.168.3.10 -u -b 110M -t 5");
    advance(1000);
    const drops = uc0().wredDropPkts;
    expect(drops).toBeGreaterThan(0);
    const l = show("show queue wredcounters Ethernet2").split("\n");
    expect(l[0]).toBe("     Port    TxQ    WredDrp/pkts    WredDrp/bytes    EcnMarked/pkts    EcnMarked/bytes");
    expect(l[2]).toMatch(new RegExp(`^Ethernet2\\s+UC0\\s+${drops}\\s+0\\s+0\\s+0$`));
    expect(l[17]).toMatch(/^Ethernet2\s+MC15\s+0/);
    expect(show("show queue wredcounters").split("\n")[2]).toMatch(/^\s*CPU\s+MC0\s+0/);
    expect(show("show queue wredcounters Ethernet99")).toBe("Port does not exist! Ethernet99");
  });
});

describe("mmuconfig / ecnconfig / acl-loader", () => {
  it("show mmu and show buffer configuration list the VS pools and profiles", () => {
    const m = show("show mmu");
    expect(m.startsWith("Pool: ingress_lossless_pool\n----  --------\nsize  12766208\ntype  ingress\nmode  dynamic\n----  --------\n")).toBe(true);
    expect(m).toContain("Profile: egress_lossy_profile\n----------  -----------------\npool        egress_lossy_pool\nsize        1518\ndynamic_th  3\n");
    expect(show("show buffer configuration")).toBe(m);
    expect(show("show buffer information")).toBe(m);
    const v = show("show mmu -vv");
    expect(v).toContain("Total pools: 3");
    expect(v).toMatch(/Total profiles: 3$/);
  });

  it("show ecn renders WRED_PROFILE rows", () => {
    const e = show("show ecn");
    expect(e).toMatch(/^Profile: LAB-WRED\n-+  -+\n/);
    expect(e).toMatch(/green_min_threshold\s+102400/);
    expect(e).toMatch(/wred_green_enable\s+true/);
  });

  it("show policer prints the acl-loader header", () => {
    expect(show("show policer")).toBe("Name    Type    Mode    CIR    CBS\n------  ------  ------  -----  -----");
  });
});
