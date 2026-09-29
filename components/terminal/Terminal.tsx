"use client";
/**
 * Linux-style shell for the selected device. This is a TERMINAL UI/UX layer only:
 * every command is still routed through the existing simulation engine via the
 * store (execCommand). Scrollback + command history live in the store per device,
 * so switching PCs preserves each device's session.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLabStore, TerminalLine } from "@/lib/store/lab-store";
import { commandNames, resolveCommand, LineKind } from "@/lib/commands";
import { cliModeFor, cliPrompt } from "@/lib/commands/sonic-cli";
import { loadGrammarBrowser, completeFor, helpFor, viewForStackTop, splitTyped } from "@/lib/sonic/grammar";
import { isSwitch } from "@/lib/models/device";

type Entry = { text: string; kind: "input" | "output"; lineKind?: LineKind };

// Commands that feel like a running process — output is revealed line-by-line
// and can be interrupted with Ctrl+C.
const STREAM_CMDS = new Set(["ping", "ping6", "traceroute", "tracepath", "tcpdump", "ntpdate", "dhclient", "ospf", "bgp"]);
const STREAM_MS = 240;
const IP_SUBS = ["addr", "link", "route", "neigh"];

const OUT_CLASS: Record<string, string> = {
  error: "text-red-400",
  muted: "text-[#6b7789]",
  success: "text-green-400",
  heading: "text-accent-2 font-semibold",
  normal: "text-[#c9d3de]",
};

function commonPrefix(items: string[]): string {
  if (items.length === 0) return "";
  let p = items[0];
  for (const s of items) {
    while (!s.startsWith(p)) p = p.slice(0, -1);
  }
  return p;
}

/** Render a stored input line: colored prompt + command (bash `:~$` or sonic-cli `#`). */
function InputLine({ text }: { text: string }) {
  const i = text.indexOf(":~$");
  if (i >= 0) {
    return (
      <>
        <span className="text-green-400">{text.slice(0, i)}</span>
        <span className="text-sky-400">:~</span>
        <span className="text-[#8b98a5]">$</span>
        <span className="text-[#e6edf3]">{text.slice(i + 3)}</span>
      </>
    );
  }
  // Modal sonic-cli prompt: "sonic# cmd" / "sonic(config-if-Ethernet0)# cmd".
  const h = text.indexOf("# ");
  if (h >= 0) {
    return (
      <>
        <span className="text-green-400">{text.slice(0, h + 1)}</span>
        <span className="text-[#e6edf3]">{text.slice(h + 1)}</span>
      </>
    );
  }
  return <span className="text-green-400">{text}</span>;
}

export function Terminal() {
  const selectedDeviceId = useLabStore((s) => s.selectedDeviceId);
  const device = useLabStore((s) => (s.selectedDeviceId ? s.network.devices[s.selectedDeviceId] : undefined));
  const lines = useLabStore((s) => (s.selectedDeviceId ? s.terminals[s.selectedDeviceId] : undefined));
  const history = useLabStore((s) => (s.selectedDeviceId ? s.terminalHistory[s.selectedDeviceId] : undefined));
  const execCommand = useLabStore((s) => s.execCommand);
  const appendTerminal = useLabStore((s) => s.appendTerminal);
  const clearScreen = useLabStore((s) => s.clearScreen);
  const pushHistory = useLabStore((s) => s.pushHistory);
  const focusNonce = useLabStore((s) => s.terminalFocusNonce);
  const cliOverride = useLabStore((s) => (s.selectedDeviceId ? s.cliMode[s.selectedDeviceId] : undefined));

  const [input, setInput] = useState("");
  const [cursor, setCursor] = useState(0);
  const [histIndex, setHistIndex] = useState(-1);
  const [focused, setFocused] = useState(false);
  const [running, setRunning] = useState(false);
  const [maximized, setMaximized] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const hiddenRef = useRef<HTMLInputElement>(null);
  const atBottomRef = useRef(true);
  const procRef = useRef<{ deviceId: string; remaining: Entry[]; cancelled: boolean; timer: ReturnType<typeof setTimeout> | null } | null>(null);

  const completions = useMemo(() => Array.from(new Set([...commandNames(), "exit", "sonic-cli"])).sort(), []);

  const user = (device?.config.hostname ?? "device").toLowerCase().replace(/\s+/g, "-");
  // SONiC switches log in as `admin@<hostname>`; PCs/servers stay in normal Linux mode.
  const sonic = device ? isSwitch(device.type) : false;
  const mgmtIp = sonic ? device?.interfaces.find((i) => i.management)?.ipv4[0] : undefined;
  // Modal sonic-cli: switches boot into `sonic#`; `exit` drops to the bash shell.
  const cliStack = cliModeFor(device, cliOverride);
  const modal = cliStack.length > 0;
  const bashUser = sonic ? `admin@${user}` : `${user}@networklab`;
  const bashPrompt = `${bashUser}:~$`;
  const promptText = modal ? cliPrompt(cliStack, user) : bashPrompt;

  // auto-scroll to bottom on new output unless the user scrolled up
  useEffect(() => {
    if (atBottomRef.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [lines]);

  useEffect(() => {
    if (focusNonce) hiddenRef.current?.focus();
  }, [focusNonce]);

  // On device switch: flush any running process to its device, reset the line.
  useEffect(() => {
    const p = procRef.current;
    if (p) {
      if (p.timer) clearTimeout(p.timer);
      if (p.remaining.length) appendTerminal(p.deviceId, p.remaining);
      procRef.current = null;
      setRunning(false);
    }
    setInput("");
    setCursor(0);
    setHistIndex(-1);
    atBottomRef.current = true;
    hiddenRef.current?.focus();
  }, [selectedDeviceId, appendTerminal]);

  useEffect(() => () => {
    if (procRef.current?.timer) clearTimeout(procRef.current.timer);
  }, []);

  // Load the real device KLISH grammar (drives sonic-cli tab-completion + `?` help).
  const [, setGrammarReady] = useState(0);
  useEffect(() => {
    loadGrammarBrowser().then(() => setGrammarReady((n) => n + 1));
  }, []);

  // --- streaming (running-process feel) ---
  const stepStream = useCallback(() => {
    const p = procRef.current;
    if (!p || p.cancelled) return;
    if (p.remaining.length === 0) {
      procRef.current = null;
      setRunning(false);
      return;
    }
    appendTerminal(p.deviceId, [p.remaining.shift() as Entry]);
    p.timer = setTimeout(stepStream, STREAM_MS);
  }, [appendTerminal]);

  const cancelRun = useCallback(
    (interrupted: boolean) => {
      const p = procRef.current;
      if (!p) return;
      if (p.timer) clearTimeout(p.timer);
      p.cancelled = true;
      if (interrupted) appendTerminal(p.deviceId, [{ text: "^C", kind: "output", lineKind: "muted" }]);
      if (p.remaining.length) appendTerminal(p.deviceId, p.remaining); // keep stats
      procRef.current = null;
      setRunning(false);
    },
    [appendTerminal],
  );

  const submit = useCallback(() => {
    if (!selectedDeviceId) return;
    const raw = input;
    const trimmed = raw.trim();
    appendTerminal(selectedDeviceId, [{ text: `${promptText} ${raw}`, kind: "input" }]);
    setInput("");
    setCursor(0);
    setHistIndex(-1);
    if (!trimmed) return;

    pushHistory(selectedDeviceId, trimmed);
    const name = trimmed.split(/\s+/)[0];

    // Modal sonic-cli: execCommand handles the grammar + mode transitions; the
    // prompt re-renders reactively from the store's cliMode. No streaming here.
    if (modal) {
      const res = execCommand(selectedDeviceId, trimmed);
      if (res.clear) {
        clearScreen(selectedDeviceId);
        return;
      }
      appendTerminal(
        selectedDeviceId,
        res.output.map((o) => ({ text: o.text, kind: "output", lineKind: o.kind })),
      );
      return;
    }

    // bash shell
    if (name === "exit" || name === "logout") {
      appendTerminal(selectedDeviceId, [{ text: "logout", kind: "output", lineKind: "muted" }]);
      return;
    }
    if (name !== "sonic-cli" && !resolveCommand(name)) {
      appendTerminal(selectedDeviceId, [
        { text: `bash: ${name}: command not found`, kind: "output", lineKind: "error" },
      ]);
      return;
    }

    const res = execCommand(selectedDeviceId, trimmed);
    if (res.clear) {
      clearScreen(selectedDeviceId);
      return;
    }
    const entries: Entry[] = res.output.map((o) => ({ text: o.text, kind: "output", lineKind: o.kind }));
    if (STREAM_CMDS.has(name) && entries.length > 0) {
      procRef.current = { deviceId: selectedDeviceId, remaining: entries, cancelled: false, timer: null };
      setRunning(true);
      stepStream();
    } else {
      appendTerminal(selectedDeviceId, entries);
    }
  }, [selectedDeviceId, input, promptText, modal, appendTerminal, pushHistory, execCommand, clearScreen, stepStream]);

  const complete = useCallback(() => {
    if (!selectedDeviceId) return;
    // Modal sonic-cli: complete against the real device grammar for this view.
    if (modal) {
      const view = viewForStackTop(cliStack[cliStack.length - 1]);
      const r = completeFor(view, input);
      if (r.completed !== undefined) {
        const { typed } = splitTyped(input);
        const done = `${typed.length ? typed.join(" ") + " " : ""}${r.completed} `;
        setInput(done);
        setCursor(done.length);
      } else if (r.candidates.length > 0) {
        appendTerminal(selectedDeviceId, [
          { text: `${promptText} ${input}`, kind: "input" },
          { text: r.candidates.map((c) => c.token).join("  "), kind: "output", lineKind: "muted" },
        ]);
      }
      return;
    }
    const parts = input.split(/\s+/);
    const apply = (prefix: string, options: string[], leading: string) => {
      const matches = options.filter((o) => o.startsWith(prefix));
      if (matches.length === 0) return;
      if (matches.length === 1) {
        const done = `${leading}${matches[0]} `;
        setInput(done);
        setCursor(done.length);
        return;
      }
      const common = commonPrefix(matches);
      if (common.length > prefix.length) {
        const partial = `${leading}${common}`;
        setInput(partial);
        setCursor(partial.length);
      } else {
        appendTerminal(selectedDeviceId, [
          { text: `${promptText} ${input}`, kind: "input" },
          { text: matches.join("  "), kind: "output", lineKind: "muted" },
        ]);
      }
    };
    if (parts.length <= 1) apply(parts[0] ?? "", completions, "");
    else if (parts[0] === "ip" && parts.length === 2) apply(parts[1], IP_SUBS, "ip ");
  }, [input, selectedDeviceId, completions, appendTerminal, promptText, modal, cliStack]);

  // `?` context help (KLISH): list the commands/args valid at the cursor.
  const showHelp = useCallback(() => {
    if (!selectedDeviceId) return;
    const view = viewForStackTop(cliStack[cliStack.length - 1]);
    const cands = helpFor(view, input);
    const body = cands.length
      ? cands.map((c) => ({ text: `  ${c.token.padEnd(24)} ${c.help}`, kind: "output" as const, lineKind: "muted" as const }))
      : [{ text: "  % No matching commands", kind: "output" as const, lineKind: "muted" as const }];
    appendTerminal(selectedDeviceId, [{ text: `${promptText} ${input}?`, kind: "input" }, ...body]);
  }, [input, selectedDeviceId, appendTerminal, promptText, cliStack]);

  const recallHistory = useCallback(
    (dir: -1 | 1) => {
      const h = history ?? [];
      if (h.length === 0) return;
      let idx = histIndex;
      if (dir === -1) idx = idx < 0 ? h.length - 1 : Math.max(0, idx - 1);
      else {
        if (idx < 0) return;
        idx = idx + 1;
        if (idx >= h.length) {
          setHistIndex(-1);
          setInput("");
          setCursor(0);
          return;
        }
      }
      setHistIndex(idx);
      setInput(h[idx]);
      setCursor(h[idx].length);
    },
    [history, histIndex],
  );

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const ctrl = e.ctrlKey || e.metaKey;

      if (e.key === "Escape" && maximized) {
        e.preventDefault();
        setMaximized(false);
        return;
      }
      if (ctrl && e.key.toLowerCase() === "l") {
        e.preventDefault();
        if (selectedDeviceId) clearScreen(selectedDeviceId);
        return;
      }
      if (ctrl && e.key.toLowerCase() === "c") {
        if (e.shiftKey) return; // Ctrl+Shift+C → let the browser copy
        if (typeof window !== "undefined" && window.getSelection()?.toString()) return; // copy selection
        e.preventDefault();
        if (running) {
          cancelRun(true);
          return;
        }
        if (selectedDeviceId) appendTerminal(selectedDeviceId, [{ text: `${promptText} ${input}^C`, kind: "input" }]);
        setInput("");
        setCursor(0);
        setHistIndex(-1);
        return;
      }
      if (e.key === "PageUp" || e.key === "PageDown") {
        e.preventDefault();
        const el = scrollRef.current;
        if (el) el.scrollBy({ top: (e.key === "PageUp" ? -1 : 1) * el.clientHeight * 0.9 });
        return;
      }

      if (running) return; // foreground process owns the terminal

      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      } else if (e.key === "Backspace") {
        e.preventDefault();
        if (cursor > 0) {
          setInput(input.slice(0, cursor - 1) + input.slice(cursor));
          setCursor(cursor - 1);
        }
      } else if (e.key === "Delete") {
        e.preventDefault();
        setInput(input.slice(0, cursor) + input.slice(cursor + 1));
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        setCursor(Math.max(0, cursor - 1));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setCursor(Math.min(input.length, cursor + 1));
      } else if (e.key === "Home" || (ctrl && e.key.toLowerCase() === "a")) {
        e.preventDefault();
        setCursor(0);
      } else if (e.key === "End" || (ctrl && e.key.toLowerCase() === "e")) {
        e.preventDefault();
        setCursor(input.length);
      } else if (ctrl && e.key.toLowerCase() === "u") {
        e.preventDefault();
        setInput(input.slice(cursor));
        setCursor(0);
      } else if (ctrl && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setInput(input.slice(0, cursor));
      } else if (ctrl && e.key.toLowerCase() === "w") {
        e.preventDefault();
        const left = input.slice(0, cursor).replace(/\s*\S+\s*$/, "");
        setInput(left + input.slice(cursor));
        setCursor(left.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        recallHistory(-1);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        recallHistory(1);
      } else if (e.key === "Tab") {
        e.preventDefault();
        complete();
      } else if (modal && e.key === "?") {
        e.preventDefault();
        showHelp();
      } else if (e.key.length === 1 && !ctrl && !e.altKey) {
        e.preventDefault();
        setInput(input.slice(0, cursor) + e.key + input.slice(cursor));
        setCursor(cursor + 1);
      }
  };

  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
      e.preventDefault();
      const text = e.clipboardData.getData("text").replace(/[\r\n]+/g, " ");
      setInput(input.slice(0, cursor) + text + input.slice(cursor));
      setCursor(cursor + text.length);
  };

  const focusInput = () => {
    if (typeof window !== "undefined" && window.getSelection()?.toString()) return; // don't steal a selection
    hiddenRef.current?.focus();
  };

  if (!selectedDeviceId || !device) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[#6b7789]">
        Select a device to open its terminal.
      </div>
    );
  }

  const before = input.slice(0, cursor);
  const at = input.slice(cursor, cursor + 1) || " ";
  const after = input.slice(cursor + 1);

  const rootClass = maximized
    ? "fixed inset-0 z-[70] flex flex-col bg-[#0a0d12]"
    : "relative flex h-full flex-col bg-[#0a0d12]";

  return (
    <div className={rootClass} onMouseUp={focusInput}>
      {maximized && (
        <div className="flex items-center justify-between border-b border-edge px-3 py-1.5">
          <span className="text-xs font-semibold uppercase tracking-wider text-[#8b98a5]">
            Terminal — {device.name}
          </span>
          <button
            onClick={() => setMaximized(false)}
            className="rounded border border-edge px-2 py-0.5 text-xs text-[#8b98a5] hover:border-accent-2 hover:text-accent-2"
          >
            ⤡ Restore (Esc)
          </button>
        </div>
      )}

      {!maximized && (
        <button
          onClick={() => setMaximized(true)}
          title="Full-screen terminal"
          className="absolute right-2 top-1.5 z-10 rounded border border-edge bg-panel-2/80 px-1.5 py-0.5 text-[11px] text-[#8b98a5] hover:border-accent-2 hover:text-accent-2"
        >
          ⤢
        </button>
      )}

      <div
        ref={scrollRef}
        onScroll={() => {
          const el = scrollRef.current;
          if (el) atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
        }}
        className="flex-1 overflow-y-auto px-3 py-2 font-mono text-[12.5px] leading-relaxed"
      >
        {sonic ? (
          <>
            <div className="text-[#6b7789]">SONiC Software Version: SONiC-OS-networklab-sim</div>
            <div className="text-[#6b7789]">
              eth0 (management): {mgmtIp ? `${mgmtIp.address}/${mgmtIp.prefix}` : "unconfigured"}
            </div>
            <div className="text-[#6b7789]">
              sonic-cli — `configure terminal` to configure, `exit` for the bash shell.
            </div>
          </>
        ) : (
          <div className="text-[#6b7789]">Linux networklab 6.1.0-networklab (tty1)</div>
        )}
        <div className="mb-1 text-[#6b7789]">&nbsp;</div>

        {lines?.map((line: TerminalLine) => (
          <div key={line.id} className="whitespace-pre-wrap break-all">
            {line.kind === "input" ? (
              <InputLine text={line.text} />
            ) : (
              <span className={OUT_CLASS[line.lineKind ?? "normal"] ?? OUT_CLASS.normal}>
                {line.text || " "}
              </span>
            )}
          </div>
        ))}

        {/* live prompt line — hidden while a foreground process runs */}
        {!running && (
          <div className="whitespace-pre-wrap break-all">
            {modal ? (
              <span className="text-green-400">{promptText} </span>
            ) : (
              <>
                <span className="text-green-400">{bashUser}</span>
                <span className="text-sky-400">:~</span>
                <span className="text-[#8b98a5]">$</span>{" "}
              </>
            )}
            <span className="text-[#e6edf3]">{before}</span>
            <span className={focused ? "term-cursor bg-accent-2 text-[#0a0d12]" : "bg-[#33404f] text-[#e6edf3]"}>
              {at}
            </span>
            <span className="text-[#e6edf3]">{after}</span>
          </div>
        )}
      </div>

      {/* off-screen input captures keystrokes; output stays selectable */}
      <input
        ref={hiddenRef}
        onKeyDown={onKey}
        onPaste={onPaste}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        className="fixed -top-96 left-0 h-1 w-1 opacity-0"
        aria-hidden
        tabIndex={-1}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
    </div>
  );
}
