# Development

## Prerequisites

- Node 18+ (developed on 18.19.1), npm 9+.

## Commands

```bash
npm run dev         # dev server @ :3000
npm run build       # production build
npm run start       # serve the production build
npm run typecheck   # tsc --noEmit (strict)
npm test            # vitest engine tests
npm run test:watch  # vitest watch
npm run sim         # headless PC1—SW1—PC2 ping (prints the full event stream)
npx tsx scripts/e2e-commands.ts   # headless terminal-command driver
```

## Principles (keep these)

1. **One source of truth.** All state lives in `NetworkState` in the Zustand
   store. Never keep a second copy of device/interface/table state in a component.
2. **Don't fake behavior.** Command output and UI views must be *derived* from the
   engine and state, never hardcoded. If you're tempted to `return "64 bytes..."`,
   stop — make the packet actually travel.
3. **Engine stays UI-free.** `lib/engine` and `lib/protocols` must not import
   React or the store. They must run headless (that's what `npm run sim` proves).
4. **Small modules.** No monolith files. New protocols get their own module.

## Adding a protocol

1. Add its layer(s) to `Frame` in `lib/models/packet.ts` and to `describeFrame`.
2. Create `lib/protocols/<name>.ts` with builders + a handler that takes
   `SimContext`.
3. Wire it into dispatch (host/router/switch receive) or, longer-term, register it
   through the `ProtocolEngine` plugin API (`lib/engine/plugin.ts`).
4. Add event types to `lib/engine/events.ts` if needed.
5. Add a command in `lib/commands/` + register it, if it needs one.
6. Add vitest coverage under `tests/` (use the builders in `tests/helpers.ts`).

## Testing

Engine tests import from `lib/` directly (no `@/` alias needed) and build small
topologies with `tests/helpers.ts` (`lan2()`, `routed()`). Call `resetAll()` (done
inside the helpers) for deterministic MACs and ids. Current coverage: MAC learning,
flood vs. forward, ARP request/reply/cache/failure, longest-prefix routing, ping
success/failure, router TTL + new-frame, traceroute, VLAN isolation.

## Working directory rule

Everything stays under `/home/sonic-claude2/deelaksha/Neworking/`. Do not create or
modify files elsewhere.
