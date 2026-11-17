# Third-party components

| Component | Version | License | Where | How it is used |
|-----------|---------|---------|-------|----------------|
| [Pyodide](https://pyodide.org) | 0.26.4 | MPL-2.0 | `node_modules/pyodide`, copied to `public/packet-engine/` | CPython on WebAssembly, runs the packet engine in a browser Web Worker |
| [Scapy](https://scapy.net) | 2.8.0 | **GPL-2.0-only** | `public/packet-engine/scapy-2.8.0-py3-none-any.whl` (fetched at build) | Packet building/dissection for the traffic generator and inspector |

## ⚠ Licensing review required before public release

Serving the Scapy wheel to browsers distributes GPL-2.0-only software. Before
the site is opened to the public:

- publish Scapy's license text and a written offer / link to the exact source
  (https://github.com/secdev/scapy/tree/v2.8.0);
- have legal review whether the simulator, which talks to Scapy only through
  JSON messages to a separate Web Worker, is a separate work or a derivative
  work under the GPL.

The engine is behind the `PacketEngine` interface (`lib/packetgen/engine.ts`),
so a permissively licensed library (e.g. dpkt, BSD) can replace it if needed.
