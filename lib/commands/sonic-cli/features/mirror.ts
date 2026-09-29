/**
 * Mirror sessions — CONFIG-PLANE feature (no engine/packet backend; store + show).
 *
 *   sonic(config)# mirror-session Mirror1                 -> create + enter sub-view
 *   sonic(config-mirror-Mirror1)# destination Ethernet0 source Ethernet4 direction rx
 *   sonic(config-mirror-Mirror2)# destination erspan dst-ip 10.1.1.1 src-ip 11.1.1.1 \
 *                                   dscp 10 ttl 10 gre 0x88ee queue 10 source Ethernet4 direction rx
 *   sonic(config)# no mirror-session Mirror1              -> delete
 *   sonic# show mirror-session [name]                     -> render from stored config
 *
 * `mirror-session <name>` (configure-view) has its config in a DEDICATED SUB-MODE
 * (grammar view="configure-mirror-view"), so we follow the sub-mode pattern: the
 * entry handler upserts the session and returns `enter: subViewFrame(...)`, and a
 * sub-view handler stores the `destination ...` fields keyed on the session name.
 *
 * Mirroring is a DATA-PLANE feature (the ASIC copies matched packets to the
 * destination). The sim cannot forward mirrored traffic, so we store + show the
 * config honestly and mark dataPlaneNotSimulated. The operational "Status" column
 * is runtime state we do not model, so it is rendered as "-" (never fabricated).
 */
import { line, err, muted, OutputLine } from "../../types";
import { registerModal } from "../registry";
import { cpUpsert, cpRemove, cpList } from "../config-plane";
import { subViewFrame } from "../../../sonic/grammar";

type Session = Record<string, string>;

/** Collect trailing "key value key value ..." tokens into a map (keys lower-cased). */
function kvPairs(tokens: string[]): Record<string, string> {
  const m: Record<string, string> = {};
  for (let i = 0; i + 1 < tokens.length; i += 2) m[tokens[i].toLowerCase()] = tokens[i + 1];
  return m;
}

// configure-view: `mirror-session <name>` — create (upsert) + enter the sub-view;
// `no mirror-session <name>` — delete the session.
registerModal({
  id: "mirror-enter",
  views: ["configure-view"],
  keywords: ["mirror-session"],
  run({ isNo, args, ctx }) {
    const name = args[0];
    if (!name) return { output: [err("% Mirror session name required.")] };
    if (isNo) {
      cpRemove(ctx.device, "mirror", "sessions", "name", name);
      return { output: [] };
    }
    cpUpsert(ctx.device, "mirror", "sessions", { name }, "name");
    return { output: [], enter: subViewFrame("configure-mirror-view", name) };
  },
});

// configure-mirror-view: `destination ...` stores the session's fields.
registerModal({
  id: "mirror",
  views: ["configure-mirror-view"],
  keywords: ["destination"],
  run({ isNo, args, viewctx, ctx }) {
    if (isNo || !viewctx) return null; // deletion is `no mirror-session` in configure-view
    const kind = (args[0] ?? "").toLowerCase();
    if (!args[0]) return { output: [err("% destination interface/erspan/CPU required.")] };

    let item: Session;
    if (kind === "erspan") {
      const kv = kvPairs(args.slice(1));
      item = {
        name: viewctx,
        type: "erspan",
        dst_ip: kv["dst-ip"] ?? "",
        src_ip: kv["src-ip"] ?? "",
        dscp: kv["dscp"] ?? "",
        ttl: kv["ttl"] ?? "",
        gre: kv["gre"] ?? "",
        queue: kv["queue"] ?? "",
        src: kv["source"] ?? "",
        direction: kv["direction"] ?? "",
      };
    } else {
      // SPAN to a physical/PortChannel interface or CPU.
      const kv = kvPairs(args.slice(1));
      item = {
        name: viewctx,
        type: "span",
        dst: kind === "cpu" ? "CPU" : args[0],
        src: kv["source"] ?? "",
        direction: kv["direction"] ?? "",
      };
    }
    cpUpsert(ctx.device, "mirror", "sessions", item, "name");
    return { output: [] };
  },
});

const ERSPAN_HDR =
  "Name      Status    SRC-IP          DST-IP          GRE    DSCP  TTL   Queue   Policer   SRC-Port        Direction";
const SPAN_HDR = "Name      Status    DST-Port        SRC-Port        Direction";
const p = (v: string | undefined, w: number): string => String(v ?? "").padEnd(w);

// enable-view: `show mirror-session [name]` — render exactly what was configured.
registerModal({
  id: "mirror-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "mirror-session") return null; // not ours
    const filter = args[1];
    let sessions = cpList(ctx.device, "mirror", "sessions") as Session[];
    if (filter) sessions = sessions.filter((s) => s.name === filter);
    if (!sessions.length) return { output: [muted("No mirror sessions configured")] };

    const erspan = sessions.filter((s) => s.type === "erspan");
    const span = sessions.filter((s) => s.type !== "erspan");
    const st = "-"; // operational status is runtime state; not simulated.
    const out: OutputLine[] = [];

    if (erspan.length) {
      out.push(line("ERSPAN Sessions"));
      out.push(muted("-".repeat(ERSPAN_HDR.length)));
      out.push(line(ERSPAN_HDR));
      out.push(muted("-".repeat(ERSPAN_HDR.length)));
      for (const s of erspan) {
        out.push(
          line(
            p(s.name, 10) + p(st, 10) + p(s.src_ip, 16) + p(s.dst_ip, 16) + p(s.gre, 7) +
              p(s.dscp, 6) + p(s.ttl, 6) + p(s.queue, 8) + p("", 10) + p(s.src, 16) + (s.direction ?? ""),
          ),
        );
      }
    }
    if (span.length) {
      out.push(line("SPAN Sessions"));
      out.push(muted("-".repeat(SPAN_HDR.length)));
      out.push(line(SPAN_HDR));
      out.push(muted("-".repeat(SPAN_HDR.length)));
      for (const s of span) {
        out.push(line(p(s.name, 10) + p(st, 10) + p(s.dst, 16) + p(s.src, 16) + (s.direction ?? "")));
      }
    }
    return { output: out };
  },
});
