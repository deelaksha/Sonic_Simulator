/** Shared helpers for the QoS / iperf3 tests. */
import { S, out } from "./control-helpers";

/** Run iperf3 on a host through the store. */
export function iperf(deviceId: string, cmd: string): string {
  return out(S().execCommand(deviceId, cmd));
}

/** Run a command on a switch from its Linux shell (labs leave S1 there; others start in KLISH). */
export function sw(deviceId: string, cmd: string): string {
  return out(S().execCommand(deviceId, cmd));
}

/** Mbits/sec values of the sender/receiver summary lines for stream `id`. */
export function summaryRate(text: string, role: "sender" | "receiver", id = "  5"): number {
  const re = new RegExp(`\\[${id.replace(/[[\]]/g, "\\$&")}\\]\\s+0\\.00-\\S+\\s+sec\\s+\\S+ \\S+\\s+(\\S+) (\\w)bits/sec.*${role}`);
  const m = re.exec(text);
  if (!m) throw new Error(`no ${role} line for [${id}] in\n${text}`);
  const mul = { K: 1e-3, M: 1, G: 1e3 }[m[2] as "M"] ?? 1e-6;
  return Number(m[1]) * mul;
}
