"use client";
import { useState } from "react";
import { SwitchConfigDetail } from "@/lib/firebase/types";

interface Props {
  open: boolean;
  onClose: () => void;
  sessionName?: string;
  switches: Record<string, SwitchConfigDetail>;
}

export function SwitchConfigViewerModal({ open, onClose, sessionName, switches }: Props) {
  const switchIds = Object.keys(switches);
  const [selectedSwitchId, setSelectedSwitchId] = useState<string>(switchIds[0] || "");
  const [activeTab, setActiveTab] = useState<"running-config" | "interfaces" | "vlans" | "features" | "history">("running-config");
  const [copied, setCopied] = useState(false);

  if (!open || switchIds.length === 0) return null;

  const currentSwitchId = switches[selectedSwitchId] ? selectedSwitchId : switchIds[0];
  const currentSwitch = switches[currentSwitchId];

  const handleCopy = () => {
    if (!currentSwitch) return;
    navigator.clipboard.writeText(currentSwitch.runningConfigText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    if (!currentSwitch) return;
    const blob = new Blob([currentSwitch.runningConfigText], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${currentSwitch.hostname || currentSwitch.name}_running.cfg`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
      <div className="relative w-full max-w-4xl rounded-xl border border-edge bg-panel shadow-2xl overflow-hidden flex flex-col h-[85vh]">
        {/* Modal Top Bar */}
        <div className="flex items-center justify-between border-b border-edge px-5 py-3 bg-panel-2">
          <div className="flex items-center gap-2">
            <span className="text-xl">🖧</span>
            <div>
              <h2 className="text-sm font-semibold text-[#e6edf3]">
                Switch Configurations Viewer
              </h2>
              <p className="text-[11px] text-[#8b98a5]">
                {sessionName ? `Session: ${sessionName}` : "Saved Switch Configurations"} · {switchIds.length} switch{switchIds.length === 1 ? "" : "es"}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-[#8b98a5] hover:bg-panel hover:text-[#e6edf3] text-sm"
          >
            ✕
          </button>
        </div>

        {/* Switch Selector Bar */}
        <div className="flex border-b border-edge bg-[#080b10] px-4 overflow-x-auto">
          {switchIds.map((id) => {
            const sw = switches[id];
            const isSelected = id === currentSwitchId;
            return (
              <button
                key={id}
                onClick={() => setSelectedSwitchId(id)}
                className={`flex items-center gap-2 border-b-2 px-4 py-2.5 text-xs font-semibold whitespace-nowrap transition-colors ${
                  isSelected
                    ? "border-accent-2 text-accent-2 bg-panel/50"
                    : "border-transparent text-[#8b98a5] hover:text-[#e6edf3]"
                }`}
              >
                <span>🖧 {sw.name}</span>
                <span className="rounded bg-panel-2 px-1.5 py-0.2 text-[10px] text-[#6b7789]">
                  {sw.ports}p
                </span>
              </button>
            );
          })}
        </div>

        {/* Switch Detail Summary Bar */}
        {currentSwitch && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-edge bg-panel-2/60 px-5 py-2 text-xs">
            <div className="flex items-center gap-4 text-[11px]">
              <div>
                <span className="text-[#6b7789]">Hostname:</span>{" "}
                <span className="font-semibold text-[#e6edf3]">{currentSwitch.hostname}</span>
              </div>
              <div>
                <span className="text-[#6b7789]">VLANs:</span>{" "}
                <span className="text-accent-2">
                  {currentSwitch.vlans.length > 0 ? currentSwitch.vlans.map((v) => v.id).join(", ") : "None"}
                </span>
              </div>
              <div>
                <span className="text-[#6b7789]">Active Features:</span>{" "}
                <span className="text-[#e6edf3]">
                  {Object.keys(currentSwitch.features).length > 0
                    ? Object.keys(currentSwitch.features).join(", ")
                    : "L2 Switching"}
                </span>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={handleCopy}
                className="rounded border border-edge bg-panel px-2.5 py-1 text-[11px] text-[#e6edf3] hover:border-accent-2"
              >
                {copied ? "✓ Copied!" : "📋 Copy Config"}
              </button>
              <button
                onClick={handleDownload}
                className="rounded border border-edge bg-panel px-2.5 py-1 text-[11px] text-[#e6edf3] hover:border-accent-2"
              >
                💾 Download .cfg
              </button>
            </div>
          </div>
        )}

        {/* Sub-Tabs */}
        <div className="flex border-b border-edge bg-panel px-5 text-xs">
          {[
            { id: "running-config", label: "SONiC Running Config" },
            { id: "interfaces", label: `Interfaces (${currentSwitch?.interfaces.length || 0})` },
            { id: "vlans", label: `VLANs (${currentSwitch?.vlans.length || 0})` },
            { id: "features", label: "CONFIG_DB State" },
            { id: "history", label: "Terminal Transcript" },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as typeof activeTab)}
              className={`border-b-2 px-3 py-2 text-xs font-semibold ${
                activeTab === tab.id
                  ? "border-accent-2 text-accent-2"
                  : "border-transparent text-[#8b98a5] hover:text-[#e6edf3]"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <div className="flex-1 overflow-y-auto p-5 bg-[#0a0d12]">
          {activeTab === "running-config" && (
            <pre className="font-mono text-xs text-green-300/90 leading-relaxed overflow-x-auto whitespace-pre p-4 rounded-lg border border-edge bg-[#05070a]">
              {currentSwitch?.runningConfigText || "! No configuration"}
            </pre>
          )}

          {activeTab === "interfaces" && (
            <div className="rounded-lg border border-edge overflow-hidden bg-panel">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-edge bg-panel-2 text-[#8b98a5] text-[11px]">
                    <th className="p-2.5 font-semibold">Port</th>
                    <th className="p-2.5 font-semibold">Admin / Oper</th>
                    <th className="p-2.5 font-semibold">MAC Address</th>
                    <th className="p-2.5 font-semibold">IPv4 / IPv6</th>
                    <th className="p-2.5 font-semibold">VLAN Mode</th>
                    <th className="p-2.5 font-semibold">Connected To</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-edge/50">
                  {currentSwitch?.interfaces.map((iface) => (
                    <tr key={iface.id} className="hover:bg-panel-2/40">
                      <td className="p-2.5 font-mono text-[#e6edf3] font-semibold">{iface.name}</td>
                      <td className="p-2.5">
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                            iface.operState === "up"
                              ? "bg-green-500/15 text-green-400"
                              : "bg-slate-700/50 text-slate-400"
                          }`}
                        >
                          {iface.operState.toUpperCase()}
                        </span>
                      </td>
                      <td className="p-2.5 font-mono text-[11px] text-[#8b98a5]">{iface.mac}</td>
                      <td className="p-2.5 font-mono text-[11px] text-[#e6edf3]">
                        {iface.ipv4.length > 0
                          ? iface.ipv4.map((ip) => `${ip.address}/${ip.prefix}`).join(", ")
                          : "—"}
                      </td>
                      <td className="p-2.5 text-[11px]">
                        {iface.vlan.mode === "access" ? (
                          <span className="text-accent-2">Access (VLAN {iface.vlan.accessVlan})</span>
                        ) : (
                          <span className="text-amber-300">
                            Trunk (Native {iface.vlan.nativeVlan})
                          </span>
                        )}
                      </td>
                      <td className="p-2.5 text-[11px] text-[#8b98a5]">
                        {iface.connectedTo ? `${iface.connectedTo.deviceId} / ${iface.connectedTo.interfaceId}` : "Not cabled"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {activeTab === "vlans" && (
            <div className="space-y-3">
              {currentSwitch?.vlans && currentSwitch.vlans.length > 0 ? (
                <div className="grid grid-cols-2 gap-3">
                  {currentSwitch.vlans.map((vlan) => (
                    <div
                      key={vlan.id}
                      className="rounded-lg border border-edge bg-panel p-3 text-xs"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-accent-2">VLAN {vlan.id}</span>
                        <span className="text-[#8b98a5] text-[11px]">{vlan.name || `Vlan${vlan.id}`}</span>
                      </div>
                      <div className="mt-2 text-[11px] text-[#6b7789]">
                        Associated Switch Ports:
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {currentSwitch.interfaces
                          .filter(
                            (i) =>
                              (i.vlan.mode === "access" && i.vlan.accessVlan === vlan.id) ||
                              (i.vlan.mode === "trunk" && i.vlan.allowedVlans?.includes(vlan.id)),
                          )
                          .map((i) => (
                            <span
                              key={i.id}
                              className="rounded border border-edge bg-panel-2 px-1.5 py-0.5 text-[10px] text-[#e6edf3]"
                            >
                              {i.name}
                            </span>
                          ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="p-6 text-center text-xs text-[#6b7789]">
                  No custom VLANs configured on this switch yet.
                </div>
              )}
            </div>
          )}

          {activeTab === "features" && (
            <pre className="font-mono text-xs text-blue-300/90 leading-relaxed overflow-x-auto whitespace-pre p-4 rounded-lg border border-edge bg-[#05070a]">
              {JSON.stringify(currentSwitch?.features || {}, null, 2)}
            </pre>
          )}

          {activeTab === "history" && (
            <div className="space-y-2 font-mono text-xs">
              {currentSwitch?.terminalLines && currentSwitch.terminalLines.length > 0 ? (
                currentSwitch.terminalLines.map((line) => (
                  <div
                    key={line.id}
                    className={`leading-relaxed ${
                      line.kind === "input" ? "text-accent-2 font-bold" : "text-[#c9d3de]"
                    }`}
                  >
                    {line.kind === "input" ? `$ ${line.text}` : line.text}
                  </div>
                ))
              ) : (
                <div className="text-[#6b7789] text-xs">No terminal output recorded for this switch.</div>
              )}
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="flex items-center justify-between border-t border-edge bg-panel-2 px-5 py-3">
          <div className="text-[11px] text-[#8b98a5]">
            Configurations are saved per switch in Firebase Firestore sessions.
          </div>
          <button onClick={onClose} className="btn-primary py-1 px-4 text-xs">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

