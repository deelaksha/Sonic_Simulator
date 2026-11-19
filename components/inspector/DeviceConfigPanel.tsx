"use client";
import { useEffect, useState } from "react";
import { useLabStore } from "@/lib/store/lab-store";
import { chassisKind } from "@/lib/switch3d/model";
import { Device, isHost, isRouter, isSwitch, findInterface } from "@/lib/models/device";
import { NetInterface } from "@/lib/models/interface";
import { NetworkState } from "@/lib/models/topology";
import { isValidIpv4, isValidPrefix } from "@/lib/models/ip";
import { formatRouteLine } from "@/lib/commands/ip";
import { SwitchConfigViewerModal } from "../cloud/SwitchConfigViewerModal";
import { saveSwitchSnapshot } from "@/lib/firebase/session-service";
import { generateSonicRunningConfig } from "@/lib/sonic/config-export";

function peerLabel(network: NetworkState, iface: NetInterface): string {
  if (!iface.connectedTo) return "— not connected —";
  const dev = network.devices[iface.connectedTo.deviceId];
  const remote = dev && findInterface(dev, iface.connectedTo.interfaceId);
  return dev && remote ? `${dev.name} · ${remote.name}` : "—";
}

function InterfaceRow({ device, iface }: { device: Device; iface: NetInterface }) {
  const setInterfaceIp = useLabStore((s) => s.setInterfaceIp);
  const clearInterfaceIp = useLabStore((s) => s.clearInterfaceIp);
  const setInterfaceMac = useLabStore((s) => s.setInterfaceMac);
  const setAdminState = useLabStore((s) => s.setAdminState);
  const network = useLabStore((s) => s.network);

  const current = iface.ipv4[0];
  const [addr, setAddr] = useState(current?.address ?? "");
  const [prefix, setPrefix] = useState(String(current?.prefix ?? 24));
  const [error, setError] = useState<string | null>(null);

  const [isEditingMac, setIsEditingMac] = useState(false);
  const [macInput, setMacInput] = useState(iface.mac);
  const [macError, setMacError] = useState<string | null>(null);

  useEffect(() => {
    setAddr(current?.address ?? "");
    setPrefix(String(current?.prefix ?? 24));
  }, [current?.address, current?.prefix]);

  useEffect(() => {
    setMacInput(iface.mac);
  }, [iface.mac]);

  const isL3 = isHost(device.type) || isRouter(device.type);

  const apply = () => {
    if (!isValidIpv4(addr)) return setError("Invalid IPv4 address");
    const p = Number(prefix);
    if (!isValidPrefix(p)) return setError("Prefix must be 0–32");
    setError(null);
    setInterfaceIp(device.id, iface.id, addr, p);
  };

  return (
    <div className="rounded-md border border-edge bg-panel-2 p-2.5">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-[#e6edf3]">{iface.name}</span>
        <button
          onClick={() => setAdminState(device.id, iface.id, iface.adminState !== "up")}
          className={`rounded px-2 py-0.5 text-[10px] font-semibold ${
            iface.operState === "up"
              ? "bg-green-500/15 text-green-400"
              : iface.adminState === "up"
                ? "bg-amber-500/15 text-amber-400"
                : "bg-slate-600/30 text-slate-400"
          }`}
          title="Toggle admin state"
        >
          {iface.adminState === "up" ? (iface.operState === "up" ? "UP" : "NO-CARRIER") : "ADMIN DOWN"}
        </button>
      </div>

      {!isEditingMac ? (
        <div className="mt-1 flex items-center justify-between text-[10px]">
          <span className="text-[#6b7789]">
            MAC <span className="font-mono text-[#c9d3de]">{iface.mac}</span>
          </span>
          <button
            onClick={() => {
              setMacInput(iface.mac);
              setMacError(null);
              setIsEditingMac(true);
            }}
            className="text-[10px] text-accent-2 hover:underline"
            title="Change interface MAC address"
          >
            Edit
          </button>
        </div>
      ) : (
        <div className="mt-1">
          <div className="flex items-center gap-1">
            <input
              value={macInput}
              onChange={(e) => {
                setMacInput(e.target.value);
                setMacError(null);
              }}
              placeholder="02:00:00:11:22:33"
              className="w-36 rounded border border-edge bg-panel px-1.5 py-0.5 font-mono text-[10px] text-[#e6edf3] outline-none focus:border-accent-2"
            />
            <button
              onClick={() => {
                const res = setInterfaceMac(device.id, iface.id, macInput);
                if (!res.ok) {
                  setMacError(res.error ?? "Invalid MAC");
                } else {
                  setIsEditingMac(false);
                }
              }}
              className="rounded border border-accent/50 bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent-2"
            >
              Save
            </button>
            <button
              onClick={() => {
                setIsEditingMac(false);
                setMacError(null);
              }}
              className="rounded border border-edge px-1.5 py-0.5 text-[10px] text-[#8b98a5] hover:text-[#e6edf3]"
            >
              Cancel
            </button>
          </div>
          {macError && <div className="mt-0.5 text-[9.5px] text-red-400">{macError}</div>}
        </div>
      )}

      <div className="text-[10px] text-[#6b7789]">link → {peerLabel(network, iface)}</div>

      {isL3 && (
        <div className="mt-2">
          <div className="flex items-center gap-1">
            <input
              value={addr}
              onChange={(e) => setAddr(e.target.value)}
              placeholder="192.168.1.10"
              className="w-32 rounded border border-edge bg-panel px-1.5 py-1 text-[11px] outline-none focus:border-accent-2"
            />
            <span className="text-[#6b7789]">/</span>
            <input
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
              className="w-10 rounded border border-edge bg-panel px-1.5 py-1 text-[11px] outline-none focus:border-accent-2"
            />
            <button onClick={apply} className="rounded border border-accent/50 bg-accent/15 px-2 py-1 text-[11px] text-accent-2">
              Set
            </button>
            {current && (
              <button
                onClick={() => clearInterfaceIp(device.id, iface.id, current.address)}
                className="rounded border border-edge px-1.5 py-1 text-[11px] text-[#8b98a5] hover:text-red-300"
              >
                Clear
              </button>
            )}
          </div>
          {error && <div className="mt-1 text-[10px] text-red-400">{error}</div>}
        </div>
      )}
      {isSwitch(device.type) && (
        <div className="mt-1 text-[10px] text-[#6b7789]">
          VLAN {iface.vlan.mode === "access" ? `access ${iface.vlan.accessVlan}` : `trunk (native ${iface.vlan.nativeVlan})`}
        </div>
      )}
    </div>
  );
}

function Table({ title, rows, empty }: { title: string; rows: string[]; empty: string }) {
  return (
    <div>
      <h3 className="panel-title mb-1">{title}</h3>
      <div className="rounded-md border border-edge bg-panel font-mono text-[11px]">
        {rows.length === 0 ? (
          <div className="px-2 py-1.5 text-[#6b7789]">{empty}</div>
        ) : (
          rows.map((r, i) => (
            <div key={i} className="border-b border-edge/50 px-2 py-1 text-[#c9d3de] last:border-0">
              {r}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** Opens the 3D hardware view (components/switch3d) for this device. */
function OpenDeviceView({ deviceId }: { deviceId: string }) {
  const open = useLabStore((s) => s.openDeviceView);
  return (
    <button
      onClick={() => open(deviceId)}
      className="w-full rounded-md border border-accent-2/40 bg-accent-2/10 px-2.5 py-2 text-left text-[11px] text-accent-2 hover:bg-accent-2/20"
      title="Also: double-click the switch on the canvas"
    >
      <span className="font-semibold">Open 3D hardware view</span>
      <span className="block text-[10px] text-[#8b98a5]">Ports, LEDs, cables, what is inside, and live port data</span>
    </button>
  );
}

/** SONiC-VS (kernel forwards) vs hardware ASIC (only CPU traffic visible to tcpdump). */
function DataplaneMode({ device }: { device: Device }) {
  const setMode = useLabStore((s) => s.setDataplaneMode);
  const mode = (device.config.features?.["dataplane-mode"] as { mode?: string } | undefined)?.mode === "hardware" ? "hardware" : "vs";
  return (
    <div className="rounded-md border border-edge bg-panel-2 p-2.5">
      <div className="text-[11px] font-semibold text-[#e6edf3]">Data plane</div>
      <div className="mt-1 flex overflow-hidden rounded border border-edge text-[11px]">
        {(["vs", "hardware"] as const).map((m) => (
          <button key={m} onClick={() => setMode(device.id, m)} className={`flex-1 px-2 py-1 ${mode === m ? "bg-accent-2/20 text-accent-2" : "text-[#8b98a5] hover:text-[#e6edf3]"}`}>
            {m === "vs" ? "SONiC-VS (kernel)" : "Hardware ASIC"}
          </button>
        ))}
      </div>
      <div className="mt-1 text-[10px] leading-relaxed text-[#6b7789]">
        {mode === "vs"
          ? "The Linux kernel forwards: tcpdump on EthernetN sees every frame."
          : "The ASIC forwards transit traffic: tcpdump on EthernetN only sees frames trapped to the CPU (ARP, LACP, BGP, OSPF, …) and frames the CPU sends."}
      </div>
    </div>
  );
}

export function DeviceConfigPanel() {
  const device = useLabStore((s) => (s.selectedDeviceId ? s.network.devices[s.selectedDeviceId] : undefined));
  const network = useLabStore((s) => s.network);
  const renameDevice = useLabStore((s) => s.renameDevice);
  const setDefaultGateway = useLabStore((s) => s.setDefaultGateway);
  const removeDevice = useLabStore((s) => s.removeDevice);
  const openTerminal = useLabStore((s) => s.openTerminal);

  const [gw, setGw] = useState("");
  const [configViewerOpen, setConfigViewerOpen] = useState(false);
  const [snapshotSavedMsg, setSnapshotSavedMsg] = useState<string | null>(null);

  useEffect(() => {
    setGw(device?.config.defaultGateway ?? "");
  }, [device?.config.defaultGateway, device?.id]);

  const handleSnapshot = async () => {
    if (!device) return;
    const name = prompt("Name this switch configuration snapshot:", `${device.name} Snapshot`);
    if (!name) return;
    try {
      await saveSwitchSnapshot(device, name);
      setSnapshotSavedMsg("Snapshot saved successfully!");
      setTimeout(() => setSnapshotSavedMsg(null), 2500);
    } catch {
      alert("Failed to save snapshot.");
    }
  };

  if (!device) {
    return <div className="p-4 text-sm text-[#6b7789]">Select a device to configure it.</div>;
  }

  const routeRows = device.routingTable.map((r) => formatRouteLine(device, r));
  const arpRows = device.arpTable.map(
    (e) => `${e.ip.padEnd(15)} ${e.state === "incomplete" ? "INCOMPLETE" : e.mac}`,
  );
  const macRows = device.macTable.map((m) => {
    const iface = findInterface(device, m.interfaceId);
    return `${m.mac}  ${iface?.name ?? m.interfaceId}  vlan ${m.vlan}`;
  });

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center gap-2">
        <input
          value={device.name}
          onChange={(e) => renameDevice(device.id, e.target.value)}
          className="min-w-0 flex-1 rounded border border-edge bg-panel px-2 py-1 text-sm font-semibold outline-none focus:border-accent-2"
        />
        <button
          onClick={() => removeDevice(device.id)}
          className="rounded border border-edge px-2 py-1 text-[11px] text-[#8b98a5] hover:border-danger hover:text-red-300"
        >
          Delete
        </button>
      </div>
      <div className="-mt-1 text-[11px] text-[#6b7789]">
        {device.type} · {device.interfaces.length} port{device.interfaces.length === 1 ? "" : "s"}
      </div>

      <button onClick={openTerminal} className="btn-primary flex items-center gap-2">
        <span>⌨</span> Open terminal for {device.name}
      </button>
      <p className="-mt-1.5 text-[10px] text-[#5f6b7a]">
        The terminal is the bottom panel and follows the selected device — run{" "}
        <code className="text-accent-2">ping</code>, <code className="text-accent-2">ip addr</code>, etc.
      </p>

      {/* port map (§33) */}
      <div className="flex flex-wrap gap-1">
        {device.interfaces.map((i) => (
          <span
            key={i.id}
            title={`${i.name} — ${i.operState}`}
            className="flex items-center gap-1 rounded border border-edge bg-panel-2 px-1.5 py-0.5 text-[10px]"
          >
            <span
              className="h-2 w-2 rounded-full"
              style={{ background: i.operState === "up" ? "#22c55e" : i.connectedTo ? "#f59e0b" : "#475569" }}
            />
            {i.name}
          </span>
        ))}
      </div>

      {chassisKind(device.type) && <OpenDeviceView deviceId={device.id} />}
      {isSwitch(device.type) && <DataplaneMode device={device} />}

      {isSwitch(device.type) && (
        <div className="rounded-md border border-edge bg-panel-2 p-2.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-[#e6edf3]">Switch Database &amp; Config</span>
            <span className="rounded bg-accent-2/15 px-1.5 py-0.5 text-[10px] text-accent-2 font-mono">
              SONiC
            </span>
          </div>
          <div className="mt-1 text-[10px] text-[#6b7789]">
            VLANs, interfaces, and CONFIG_DB features are saved and synced with your database sessions.
          </div>
          <div className="mt-2 flex gap-1.5">
            <button
              onClick={() => setConfigViewerOpen(true)}
              className="flex-1 rounded border border-edge bg-panel px-2 py-1 text-[11px] font-medium text-[#e6edf3] hover:border-accent-2 hover:text-accent-2 transition-colors"
            >
              🔍 View Full Config
            </button>
            <button
              onClick={handleSnapshot}
              className="rounded border border-edge bg-panel px-2.5 py-1 text-[11px] text-[#8b98a5] hover:border-accent-2 hover:text-[#e6edf3] transition-colors"
            >
              💾 Snapshot
            </button>
          </div>
          {snapshotSavedMsg && (
            <div className="mt-1.5 text-[10px] text-green-400 font-medium">✓ {snapshotSavedMsg}</div>
          )}
        </div>
      )}

      <div>
        <h3 className="panel-title mb-1">Interfaces</h3>
        <div className="flex flex-col gap-2">
          {device.interfaces.map((iface) => (
            <InterfaceRow key={iface.id} device={device} iface={iface} />
          ))}
        </div>
      </div>

      {(isHost(device.type) || isRouter(device.type)) && (
        <div>
          <h3 className="panel-title mb-1">Default gateway</h3>
          <div className="flex items-center gap-1">
            <input
              value={gw}
              onChange={(e) => setGw(e.target.value)}
              placeholder="192.168.1.1"
              className="w-40 rounded border border-edge bg-panel px-1.5 py-1 text-[11px] outline-none focus:border-accent-2"
            />
            <button
              onClick={() => setDefaultGateway(device.id, gw.trim() || undefined)}
              className="rounded border border-accent/50 bg-accent/15 px-2 py-1 text-[11px] text-accent-2"
            >
              Set
            </button>
          </div>
        </div>
      )}

      {(isHost(device.type) || isRouter(device.type)) && (
        <>
          <Table title="Routing table (ip route)" rows={routeRows} empty="(no routes)" />
          <Table title="ARP / neighbours (ip neigh)" rows={arpRows} empty="(empty)" />
        </>
      )}
      {isSwitch(device.type) && (
        <Table title="MAC address table" rows={macRows} empty="(nothing learned yet)" />
      )}

      <p className="text-[10px] leading-relaxed text-[#5f6b7a]">
        Everything here is the same state the terminal and packet engine use. Change an IP and
        <code className="mx-1 text-accent-2">ip addr</code> updates too. {network.connections.length} cable
        {network.connections.length === 1 ? "" : "s"} in this lab.
      </p>

      {isSwitch(device.type) && (
        <SwitchConfigViewerModal
          open={configViewerOpen}
          onClose={() => setConfigViewerOpen(false)}
          sessionName={device.name}
          switches={{
            [device.id]: {
              deviceId: device.id,
              name: device.name,
              hostname: device.config.hostname || device.name,
              ports: device.interfaces.length,
              interfaces: device.interfaces,
              vlans: device.config.vlans || [],
              features: device.config.features || {},
              routingTable: device.routingTable,
              routingTable6: device.routingTable6,
              runningConfigText: generateSonicRunningConfig(device),
              terminalLines: useLabStore.getState().terminals[device.id] || [],
              terminalHistory: useLabStore.getState().terminalHistory[device.id] || [],
              cliMode: useLabStore.getState().cliMode[device.id] || [],
            },
          }}
        />
      )}
    </div>
  );
}
