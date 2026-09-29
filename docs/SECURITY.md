# Security

This platform is intended for public users, so it never executes anything on the
host. The networking behavior is a pure in-memory simulation.

## No arbitrary execution (spec §44)

Terminal input flows through a strict pipeline:

```
User command
   → parser (tokenize)                lib/commands/parser.ts
   → allowed-command registry         lib/commands/registry.ts
   → command handler (pure)           lib/commands/*.ts
   → simulation engine                lib/engine
   → formatted result
```

There is **no** `exec`, `child_process`, `eval`, or shell anywhere in the command
path. `execute()` (`lib/commands/index.ts`) resolves the first token against a
fixed `Map` of registered handlers; an unknown command returns
`command not found`. A handler can only:

- read/mutate the in-memory `NetworkState`, and
- run the simulation engine over it.

Handlers run inside a `try/catch`, so a buggy handler surfaces an error line
instead of crashing the app.

## No real network / filesystem access

- The engine models packets as plain objects; it does not open sockets, touch OS
  routing tables, or read/write files.
- Lab persistence is client-side only: **Export** downloads a JSON file the user
  chose to save; **Import** reads a file the user chose to open. The app writes no
  files on the server.
- The host's real interfaces, namespaces, and system config are never touched.

## Future "Real Linux Lab Mode" (spec §43)

The architecture leaves room for a future advanced mode backed by real Linux
network namespaces + veth pairs. That mode is **not** implemented here and must
only ever run inside an isolated container/VM with strict resource and network
limits — never as arbitrary host commands from public users. The default and only
mode today is the safe simulation engine.
