/* Hardware look for components/switch3d (adapted from a realistic 1U switch mock-up). */
export const CSS = `
.sw-stage { background: radial-gradient(circle at 50% 30%, rgba(45,55,72,.35) 0%, rgba(10,12,16,.95) 75%); touch-action: none; }
.sw-box { position: relative; transform-style: preserve-3d; transition: transform .35s ease;
  --top:#34383f; --mid:#272a30; --bot:#1b1e23; --border:#4a505c; --silk:#d4d8e0; --silk2:#8b93a1; --ear1:#2b2e35; --ear2:#1c1f24; --cage1:#aeb5bf; --cage2:#6e7580; --cage3:#8c94a0; }
.sw-silver { --top:#e2e5ea; --mid:#cfd4dc; --bot:#b5bcc7; --border:#fff; --silk:#2c313a; --silk2:#5a6270; --ear1:#c8ced8; --ear2:#9ea6b3; --cage1:#949ca8; --cage2:#525862; --cage3:#767e8a; }
.sw-face { position: absolute; left: 0; top: 0; backface-visibility: hidden; }
.sw-chassis { background: repeating-linear-gradient(0deg, rgba(255,255,255,.015) 0 1px, rgba(0,0,0,.025) 1px 2px), linear-gradient(180deg, var(--top) 0%, var(--mid) 45%, var(--bot) 100%);
  border-top: 1px solid var(--border); border-bottom: 2px solid #090a0d; box-shadow: inset 0 1px 0 rgba(255,255,255,.18), inset 0 -1px 2px rgba(0,0,0,.6); }
.sw-dark .sw-chassis, .sw-dark .sw-ear, .sw-dark .sw-lid, .sw-dark .sw-side { filter: brightness(.55) contrast(1.1); }
.sw-lid, .sw-side, .sw-bottom { width: 100%; height: 100%; background: linear-gradient(180deg, var(--mid), var(--bot)); }
.sw-lid { background: repeating-linear-gradient(90deg, rgba(0,0,0,.18) 0 2px, transparent 2px 14px), linear-gradient(180deg, var(--top), var(--bot)); }
.sw-ear { background: linear-gradient(180deg, var(--ear1), var(--ear2)); box-shadow: inset 0 1px 0 rgba(255,255,255,.14), inset 0 -1px 2px rgba(0,0,0,.7); }
.sw-slot { width: 16px; height: 10px; border-radius: 99px; background: #060709; box-shadow: inset 0 2px 4px rgba(0,0,0,.95); }
.sw-screw { width: 11px; height: 11px; border-radius: 50%; position: relative; background: radial-gradient(circle at 35% 35%, #9aa2ad 0%, #4d535e 60%, #23272e 100%); box-shadow: 0 1px 2px rgba(0,0,0,.8); }
.sw-screw::before, .sw-screw::after { content: ''; position: absolute; background: #17191e; top: 50%; left: 50%; transform: translate(-50%,-50%) rotate(22deg); }
.sw-screw::before { width: 7px; height: 1.5px; } .sw-screw::after { width: 1.5px; height: 7px; }
.sw-silk { color: var(--silk); } .sw-silk-sub { color: var(--silk2); }
.sw-vent { background-image: radial-gradient(#090b0e 42%, transparent 48%); background-size: 5px 5px; box-shadow: inset 0 2px 5px rgba(0,0,0,.8); }
.sw-oled-bezel { width: 86px; height: 86px; border-radius: 6px; padding: 6px; background: #090b0e; border: 1px solid rgba(255,255,255,.08); box-shadow: inset 0 2px 6px rgba(0,0,0,.95); }
.sw-oled { width: 100%; height: 100%; border-radius: 3px; padding: 5px; display: flex; flex-direction: column; text-align: left; font-family: ui-monospace, monospace; background: linear-gradient(145deg, #06131f, #030911); box-shadow: inset 0 0 10px rgba(14,165,233,.2); overflow: hidden; }
.sw-sysled { width: 6px; height: 6px; border-radius: 50%; background: #1c2026; border: 1px solid rgba(0,0,0,.75); }
.sw-bank { background: rgba(0,0,0,.28); border: 1px solid rgba(0,0,0,.55); box-shadow: inset 0 2px 6px rgba(0,0,0,.7); }
.sw-rj45, .sw-sfp { position: relative; border-radius: 3px; padding: 2px; cursor: pointer; transition: transform .12s, box-shadow .15s;
  background: linear-gradient(160deg, var(--cage1), var(--cage2) 55%, var(--cage3)); box-shadow: 0 2px 3px rgba(0,0,0,.65), inset 0 1px 0 rgba(255,255,255,.45); }
.sw-rj45 { width: 34px; height: 30px; } .sw-sfp { width: 44px; height: 30px; }
.sw-rj45:hover, .sw-sfp:hover { transform: scale(1.08); z-index: 5; box-shadow: 0 0 0 1.5px rgba(56,189,248,.85), 0 4px 10px rgba(0,0,0,.8); }
.sw-sel { box-shadow: 0 0 0 2px #38bdf8, 0 0 12px rgba(56,189,248,.6) !important; z-index: 6; }
.sw-console { background: linear-gradient(160deg, #38bdf8, #0284c7 60%, #0369a1); cursor: default; }
.sw-mgmt { cursor: default; }
.sw-rj45-cavity, .sw-sfp-cavity { width: 100%; height: 100%; border-radius: 1.5px; background: linear-gradient(180deg, #07080a, #14171c); box-shadow: inset 0 3px 5px rgba(0,0,0,.95); display: flex; align-items: center; justify-content: center; }
.sw-sfp-rail { width: 28px; height: 5px; border-radius: 1px; opacity: .7; background: repeating-linear-gradient(90deg, #854d0e 0, #ca8a04 1.5px, #111318 1.5px, #111318 3px); }
.sw-pled { position: absolute; width: 6px; height: 4px; border-radius: 1px; background: #1a1e24; border: .5px solid rgba(0,0,0,.8); z-index: 4; top: 2.5px; }
.sw-pled-l { left: 2.5px; } .sw-pled-r { right: 2.5px; }
.sw-inv .sw-pled { top: auto; bottom: 2.5px; }
.on-green { background: #4ade80 !important; box-shadow: 0 0 4px #22c55e, 0 0 9px rgba(34,197,94,.85) !important; }
.on-amber { background: #fbbf24 !important; box-shadow: 0 0 4px #f59e0b, 0 0 9px rgba(245,158,11,.85) !important; }
.on-blue { background: #60a5fa !important; box-shadow: 0 0 5px #3b82f6, 0 0 11px rgba(59,130,246,.9) !important; }
.sw-dark .on-green, .sw-dark .on-amber, .sw-dark .on-blue { filter: brightness(1.5); }
.sw-blink { animation: swBlink .8s steps(2) infinite; } @keyframes swBlink { 50% { opacity: .15; } }
.sw-plug { position: absolute; inset: 2px; z-index: 3; display: flex; align-items: center; justify-content: center; pointer-events: none; animation: swSnap .16s cubic-bezier(.22,1,.36,1); }
.sw-plug-body { width: 24px; height: 20px; border-radius: 2px; display: flex; align-items: center; justify-content: center; background: linear-gradient(145deg, rgba(255,255,255,.42), rgba(180,195,210,.25) 50%, rgba(40,48,58,.6)); border: 1px solid rgba(255,255,255,.45); box-shadow: 0 3px 6px rgba(0,0,0,.85); }
.sw-boot { width: 16px; height: 13px; border-radius: 4px; box-shadow: inset 0 2px 3px rgba(255,255,255,.38), inset 0 -2px 4px rgba(0,0,0,.55); }
.sw-sfp-module { position: absolute; inset: 3px; z-index: 3; border-radius: 1.5px; display: flex; align-items: center; justify-content: space-between; padding: 3px 4px; pointer-events: none;
  background: linear-gradient(180deg, #cfd6e0, #8b93a0); box-shadow: 0 3px 6px rgba(0,0,0,.85); animation: swSnap .16s cubic-bezier(.22,1,.36,1); }
.sw-lc { width: 10px; height: 13px; border-radius: 1.5px; border: 1px solid rgba(255,255,255,.35); }
.sw-bail { width: 5px; height: 15px; border-radius: 1.5px; background: linear-gradient(180deg, #38bdf8, #0284c7); }
.sw-tail { position: absolute; left: 50%; width: 8px; height: 22px; transform: translateX(-50%); border-radius: 4px; box-shadow: 2px 4px 6px rgba(0,0,0,.75); }
.sw-tail.down { top: 18px; } .sw-tail.up { bottom: 18px; }
@keyframes swSnap { 0% { transform: scale(1.35); opacity: .5; } 100% { transform: scale(1); opacity: 1; } }
.sw-pcb .sw-t { font: 10px ui-monospace, monospace; fill: #9fb3c8; } .sw-pcb .sw-t.big { font-size: 12px; font-weight: 700; fill: #e6edf3; } .sw-pcb .sw-t.dim { fill: #5f7a8e; }
.sw-trace { fill: none; stroke: #2b6650; stroke-width: 2; } .sw-trace.up { stroke: #4ade80; stroke-opacity: .55; } .sw-trace.sel { stroke: #38bdf8; stroke-opacity: 1; stroke-width: 3; }
.sw-trace.pcie { stroke: #a78bfa; stroke-opacity: .5; stroke-width: 4; } .sw-trace.mgmt { stroke: #a78bfa; stroke-opacity: .4; stroke-dasharray: 6 4; } .sw-trace.hot { stroke-opacity: 1; }
.sw-dot { fill: #fde047; filter: drop-shadow(0 0 4px #facc15); } .sw-dot.cpu { fill: #c4b5fd; filter: drop-shadow(0 0 4px #a78bfa); }
.sw-fan { animation: swSpin .6s linear infinite; } @keyframes swSpin { to { transform: rotate(360deg); } }
/* routers, PCs and servers */
.sw-router .sw-chassis { --top:#2f3a48; --mid:#253041; --bot:#1a2230; }
.sw-silver.sw-router .sw-chassis { --top:#e2e5ea; --mid:#cfd4dc; --bot:#b5bcc7; }
.sw-steel { background: repeating-linear-gradient(90deg, rgba(255,255,255,.02) 0 1px, rgba(0,0,0,.03) 1px 3px), linear-gradient(180deg, #5b6270, #3d434e 50%, #2b3038); border-top: 1px solid #7a8291; box-shadow: inset 0 1px 0 rgba(255,255,255,.2), inset 0 -1px 2px rgba(0,0,0,.6); }
.sw-silver .sw-steel { background: linear-gradient(180deg, #d9dde3, #bfc5ce 55%, #a9b0ba); }
.sw-dark .sw-steel { filter: brightness(.55) contrast(1.1); }
.sw-shield { background: linear-gradient(180deg, #8a919c, #6b727d); border-radius: 3px; box-shadow: inset 0 1px 0 rgba(255,255,255,.35), inset 0 -1px 2px rgba(0,0,0,.5), 0 1px 2px rgba(0,0,0,.6); }
.sw-usb { width: 20px; height: 9px; border-radius: 1.5px; background: #0b0c0f; border: 2px solid #b8bec8; position: relative; }
.sw-usb::after { content: ''; position: absolute; left: 2px; right: 2px; top: 1px; height: 3px; background: var(--usb, #1d4ed8); border-radius: 1px; }
.sw-hdmi { width: 26px; height: 10px; background: #0b0c0f; border: 2px solid #b8bec8; clip-path: polygon(0 0, 100% 0, 88% 100%, 12% 100%); }
.sw-dp { width: 22px; height: 10px; background: #0b0c0f; border: 2px solid #b8bec8; clip-path: polygon(0 0, 100% 0, 100% 100%, 18% 100%, 0 60%); }
.sw-vga { width: 36px; height: 14px; background: linear-gradient(180deg, #3b82f6, #1e40af); clip-path: polygon(0 0, 100% 0, 90% 100%, 10% 100%); border-radius: 2px; }
.sw-db9 { width: 30px; height: 13px; background: linear-gradient(180deg, #14b8a6, #0f766e); clip-path: polygon(0 0, 100% 0, 90% 100%, 10% 100%); border-radius: 2px; }
.sw-jack { width: 11px; height: 11px; border-radius: 50%; border: 2px solid #1b1d22; box-shadow: inset 0 0 0 2px #000; }
.sw-psu { background: linear-gradient(180deg, #2a2f37, #1b1f25); border: 1px solid #454c58; border-radius: 3px; box-shadow: inset 0 1px 0 rgba(255,255,255,.08); }
.sw-grill { border-radius: 50%; background-image: radial-gradient(#07080a 40%, transparent 46%); background-size: 6px 6px; background-color: #3a404b; box-shadow: inset 0 0 6px rgba(0,0,0,.8); }
.sw-iec { width: 26px; height: 18px; background: #0d0f12; border: 2px solid #444b56; clip-path: polygon(20% 0, 80% 0, 100% 30%, 100% 100%, 0 100%, 0 30%); }
.sw-rocker { width: 12px; height: 18px; border-radius: 2px; background: linear-gradient(180deg, #111, #2b2b2b); border: 1px solid #555; }
.sw-slotcover { height: 9px; border-radius: 1px; background: repeating-linear-gradient(90deg, #9aa1ab 0 6px, #6b717b 6px 8px); box-shadow: 0 1px 1px rgba(0,0,0,.5); }
.sw-ont { background: linear-gradient(180deg, #f3f4f6, #e5e7eb 55%, #d1d5db); border-radius: 10px; box-shadow: inset 0 1px 0 #fff, inset 0 -2px 3px rgba(0,0,0,.18); }
.sw-dark .sw-ont { filter: brightness(.6); }
.sw-sc { width: 20px; height: 26px; border-radius: 2px; background: linear-gradient(180deg, #22c55e, #15803d); box-shadow: 0 2px 3px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.4); position: relative; }
.sw-sc::after { content: ''; position: absolute; left: 7px; top: 9px; width: 6px; height: 6px; border-radius: 50%; background: #f8fafc; box-shadow: inset 0 1px 1px rgba(0,0,0,.5); }
.sw-fiber { position: absolute; left: 50%; top: 24px; width: 4px; height: 40px; transform: translateX(-50%); border-radius: 2px; background: linear-gradient(90deg, #ca8a04, #facc15, #ca8a04); box-shadow: 1px 3px 4px rgba(0,0,0,.4); }
.sw-handle { width: 8px; border-radius: 3px; background: linear-gradient(90deg, #6b7280, #9ca3af, #6b7280); }
`;
