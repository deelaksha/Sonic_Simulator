"use client";
import { useState, useEffect, useCallback } from "react";
import { useLabStore } from "@/lib/store/lab-store";
import {
  listSessions,
  loadSession,
  saveSwitchSnapshot,
  listSwitchSnapshots,
} from "@/lib/firebase/session-service";
import {
  CloudSessionListItem,
  SwitchConfigDetail,
  SwitchSnapshot,
} from "@/lib/firebase/types";
import { isFirebaseConfigured } from "@/lib/firebase/config";
import { SwitchConfigViewerModal } from "./SwitchConfigViewerModal";
import { FirebaseConfigModal } from "./FirebaseConfigModal";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function SessionManagerModal({ open, onClose }: Props) {
  const currentSessionId = useLabStore((s) => s.currentSessionId);
  const labName = useLabStore((s) => s.labName);
  const network = useLabStore((s) => s.network);
  const autoSave = useLabStore((s) => s.autoSave);
  const setAutoSave = useLabStore((s) => s.setAutoSave);
  const saveToCloud = useLabStore((s) => s.saveToCloud);
  const loadFromCloud = useLabStore((s) => s.loadFromCloud);
  const deleteFromCloud = useLabStore((s) => s.deleteFromCloud);

  const [sessions, setSessions] = useState<CloudSessionListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [sessionNameInput, setSessionNameInput] = useState("");
  const [savingNew, setSavingNew] = useState(false);
  const [activeTab, setActiveTab] = useState<"sessions" | "snapshots">("sessions");
  const [snapshots, setSnapshots] = useState<SwitchSnapshot[]>([]);

  // Config Viewer state
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewingSessionName, setViewingSessionName] = useState("");
  const [viewingSwitches, setViewingSwitches] = useState<Record<string, SwitchConfigDetail>>({});
  const [viewerLoading, setViewerLoading] = useState(false);

  // Firebase Config Modal state
  const [configModalOpen, setConfigModalOpen] = useState(false);

  const refreshSessions = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listSessions();
      setSessions(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshSnapshots = useCallback(async () => {
    try {
      const data = await listSwitchSnapshots();
      setSnapshots(data);
    } catch (err) {
      console.error(err);
    }
  }, []);

  useEffect(() => {
    if (open) {
      setSessionNameInput(labName || "SONiC Switch Lab");
      refreshSessions();
      refreshSnapshots();
    }
  }, [open, labName, refreshSessions, refreshSnapshots]);

  if (!open) return null;

  const handleSaveCurrent = async () => {
    setSavingNew(true);
    const res = await saveToCloud(sessionNameInput.trim() || undefined);
    setSavingNew(false);
    if (res.ok) {
      await refreshSessions();
    }
  };

  const handleOpenSession = async (id: string) => {
    setLoading(true);
    const res = await loadFromCloud(id);
    setLoading(false);
    if (res.ok) {
      onClose();
    }
  };

  const handleDeleteSession = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("Are you sure you want to delete this session?")) return;
    await deleteFromCloud(id);
    await refreshSessions();
  };

  const handleInspectSwitchConfigs = async (id: string, name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setViewerLoading(true);
    setViewingSessionName(name);
    try {
      const full = await loadSession(id);
      if (full && full.switches) {
        setViewingSwitches(full.switches);
        setViewerOpen(true);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setViewerLoading(false);
    }
  };

  const handleSaveSelectedSwitchSnapshot = async () => {
    const selectedDeviceId = useLabStore.getState().selectedDeviceId;
    const dev = selectedDeviceId ? network.devices[selectedDeviceId] : undefined;
    if (!dev || dev.type !== "switch") {
      alert("Please select a switch in the canvas first.");
      return;
    }
    const name = prompt("Name this switch snapshot:", `${dev.name} Template`);
    if (!name) return;
    await saveSwitchSnapshot(dev, name);
    await refreshSnapshots();
  };

  const configured = isFirebaseConfigured();
  const filteredSessions = sessions.filter(
    (s) =>
      s.name.toLowerCase().includes(search.toLowerCase()) ||
      s.switchesSummary.some((sw) => sw.name.toLowerCase().includes(search.toLowerCase()) || sw.hostname.toLowerCase().includes(search.toLowerCase())),
  );

  const switchCountInCurrent = Object.values(network.devices).filter((d) => d.type === "switch").length;

  return (
    <>
      <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
        <div className="relative w-full max-w-3xl rounded-xl border border-edge bg-panel shadow-2xl overflow-hidden flex flex-col h-[85vh]">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-edge px-5 py-3.5 bg-panel-2">
            <div className="flex items-center gap-2.5">
              <span className="text-xl">☁️</span>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-[#e6edf3]">
                    Switch Sessions &amp; Cloud Database
                  </h2>
                  <span
                    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                      configured
                        ? "bg-green-500/15 text-green-400 border border-green-500/30"
                        : "bg-amber-500/15 text-amber-400 border border-amber-500/30"
                    }`}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${configured ? "bg-green-400" : "bg-amber-400"}`} />
                    {configured ? "Firebase Firestore" : "Local Database"}
                  </span>
                </div>
                <p className="text-[11px] text-[#8b98a5]">
                  Save, reopen, and inspect switch configurations across browser sessions
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => setConfigModalOpen(true)}
                className="rounded border border-edge bg-panel px-2.5 py-1 text-[11px] text-[#8b98a5] hover:border-accent-2 hover:text-[#e6edf3]"
              >
                ⚙ Firebase Settings
              </button>
              <button
                onClick={onClose}
                className="rounded p-1 text-[#8b98a5] hover:bg-panel hover:text-[#e6edf3] text-sm"
              >
                ✕
              </button>
            </div>
          </div>

          {/* Current Session Bar */}
          <div className="border-b border-edge bg-[#0a0d12] px-5 py-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 flex-1 min-w-[280px]">
              <span className="text-xs text-[#8b98a5]">Active:</span>
              <input
                type="text"
                value={sessionNameInput}
                onChange={(e) => setSessionNameInput(e.target.value)}
                placeholder="Session Name"
                className="flex-1 rounded border border-edge bg-panel px-2.5 py-1 text-xs text-[#e6edf3] outline-none focus:border-accent-2"
              />
              <button
                onClick={handleSaveCurrent}
                disabled={savingNew}
                className="btn-primary py-1 px-3 text-xs flex items-center gap-1.5 whitespace-nowrap"
              >
                {savingNew ? "Saving..." : currentSessionId ? "💾 Update Cloud" : "💾 Save New Session"}
              </button>
            </div>

            <div className="flex items-center gap-3 text-xs">
              <label className="flex items-center gap-1.5 cursor-pointer text-[#8b98a5] hover:text-[#e6edf3]">
                <input
                  type="checkbox"
                  checked={autoSave}
                  onChange={(e) => setAutoSave(e.target.checked)}
                  className="rounded border-edge bg-panel text-accent-2"
                />
                <span className="text-[11px]">Auto-save active session</span>
              </label>
              <span className="text-[11px] text-[#5f6b7a]">
                {switchCountInCurrent} switch{switchCountInCurrent === 1 ? "" : "es"} in canvas
              </span>
            </div>
          </div>

          {/* Tab Navigation */}
          <div className="flex border-b border-edge bg-panel-2 px-5">
            <button
              onClick={() => setActiveTab("sessions")}
              className={`border-b-2 px-4 py-2 text-xs font-semibold ${
                activeTab === "sessions"
                  ? "border-accent-2 text-accent-2"
                  : "border-transparent text-[#8b98a5] hover:text-[#e6edf3]"
              }`}
            >
              Saved Sessions ({sessions.length})
            </button>
            <button
              onClick={() => setActiveTab("snapshots")}
              className={`border-b-2 px-4 py-2 text-xs font-semibold ${
                activeTab === "snapshots"
                  ? "border-accent-2 text-accent-2"
                  : "border-transparent text-[#8b98a5] hover:text-[#e6edf3]"
              }`}
            >
              Switch Snapshots &amp; Templates ({snapshots.length})
            </button>
          </div>

          {/* Tab Content */}
          <div className="flex-1 overflow-y-auto p-5 bg-[#080b10] flex flex-col gap-3">
            {activeTab === "sessions" ? (
              <>
                {/* Search Bar */}
                <div className="flex items-center justify-between gap-3">
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search sessions by name or switch..."
                    className="w-full max-w-sm rounded border border-edge bg-panel px-3 py-1.5 text-xs text-[#e6edf3] outline-none focus:border-accent-2"
                  />
                  <button
                    onClick={refreshSessions}
                    className="rounded border border-edge bg-panel px-2.5 py-1.5 text-xs text-[#8b98a5] hover:text-[#e6edf3]"
                  >
                    ↻ Refresh
                  </button>
                </div>

                {loading ? (
                  <div className="flex flex-1 items-center justify-center p-8 text-xs text-[#8b98a5]">
                    <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-accent-2 border-t-transparent mr-2" />
                    Loading sessions...
                  </div>
                ) : filteredSessions.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-edge/60 p-8 text-center text-xs text-[#6b7789]">
                    <div className="text-2xl mb-2">📁</div>
                    <div className="font-semibold text-[#8b98a5]">No sessions found</div>
                    <div className="mt-1">
                      {search ? "No sessions match your search query." : "Save your current switches and topology above to create your first session!"}
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2.5">
                    {filteredSessions.map((s) => {
                      const isActive = s.id === currentSessionId;
                      const dateStr = new Date(s.updatedAt).toLocaleString();

                      return (
                        <div
                          key={s.id}
                          className={`group rounded-lg border p-3.5 transition-all ${
                            isActive
                              ? "border-accent-2/60 bg-accent-2/5 shadow-[0_0_12px_rgba(56,189,248,0.1)]"
                              : "border-edge bg-panel hover:border-edge/90 hover:bg-panel-2/60"
                          }`}
                        >
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div>
                              <div className="flex items-center gap-2">
                                <h3 className="text-xs font-bold text-[#e6edf3]">{s.name}</h3>
                                {isActive && (
                                  <span className="rounded bg-accent-2/20 px-1.5 py-0.2 text-[10px] font-semibold text-accent-2">
                                    CURRENT ACTIVE
                                  </span>
                                )}
                              </div>
                              <div className="mt-1 flex items-center gap-3 text-[11px] text-[#6b7789]">
                                <span>Updated: {dateStr}</span>
                                <span>·</span>
                                <span>{s.switchCount} switch{s.switchCount === 1 ? "" : "es"}</span>
                                <span>·</span>
                                <span>{s.deviceCount} total devices</span>
                              </div>
                            </div>

                            <div className="flex items-center gap-1.5">
                              <button
                                onClick={(e) => handleInspectSwitchConfigs(s.id, s.name, e)}
                                disabled={viewerLoading}
                                title="See switch running configs, interfaces, and VLANs"
                                className="rounded border border-edge bg-panel px-2.5 py-1 text-[11px] font-medium text-[#8b98a5] hover:border-accent-2 hover:text-[#e6edf3]"
                              >
                                🔍 See Switch Configs
                              </button>
                              <button
                                onClick={() => handleOpenSession(s.id)}
                                title="Open this session and continue working with these switches"
                                className="rounded bg-accent-2/20 border border-accent-2/40 px-3 py-1 text-[11px] font-semibold text-accent-2 hover:bg-accent-2/30"
                              >
                                🚀 Open Session
                              </button>
                              <button
                                onClick={(e) => handleDeleteSession(s.id, e)}
                                title="Delete session"
                                className="rounded border border-edge p-1 text-[11px] text-[#6b7789] hover:border-red-500/50 hover:text-red-400"
                              >
                                🗑
                              </button>
                            </div>
                          </div>

                          {/* Switch Badges Summary */}
                          {s.switchesSummary && s.switchesSummary.length > 0 && (
                            <div className="mt-2.5 flex flex-wrap gap-1.5 border-t border-edge/40 pt-2">
                              {s.switchesSummary.map((sw) => (
                                <span
                                  key={sw.id}
                                  className="inline-flex items-center gap-1 rounded bg-[#0a0d12] border border-edge px-2 py-0.5 text-[10px] text-[#c9d3de]"
                                >
                                  <span className="font-semibold text-accent-2">{sw.name}</span>
                                  {sw.vlans.length > 0 && (
                                    <span className="text-[#8b98a5]">
                                      [VLAN {sw.vlans.join(",")}]
                                    </span>
                                  )}
                                  {sw.features.length > 0 && (
                                    <span className="text-green-400/80">
                                      ({sw.features.slice(0, 2).join(", ")})
                                    </span>
                                  )}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            ) : (
              /* Standalone Switch Snapshots Tab */
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs text-[#8b98a5]">
                    Save and reuse switch configurations as modular templates.
                  </p>
                  <button
                    onClick={handleSaveSelectedSwitchSnapshot}
                    className="btn-primary py-1 px-3 text-xs"
                  >
                    + Snapshot Selected Switch
                  </button>
                </div>

                {snapshots.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-edge/60 p-8 text-center text-xs text-[#6b7789]">
                    No switch snapshots saved yet. Select a switch on the canvas and snapshot its configuration!
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-3">
                    {snapshots.map((snap) => (
                      <div
                        key={snap.id}
                        className="rounded-lg border border-edge bg-panel p-3 text-xs space-y-1.5"
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-bold text-[#e6edf3]">{snap.name}</span>
                          <span className="text-[10px] text-[#6b7789]">
                            {new Date(snap.updatedAt).toLocaleDateString()}
                          </span>
                        </div>
                        <div className="text-[11px] text-[#8b98a5]">
                          Hostname: {snap.hostname} · {snap.interfaces.length} ports
                        </div>
                        <div className="flex items-center justify-between pt-2 border-t border-edge">
                          <span className="text-[10px] text-accent-2">
                            {snap.vlans.length > 0 ? `VLANs: ${snap.vlans.map((v) => v.id).join(", ")}` : "Default VLAN"}
                          </span>
                          <button
                            onClick={() => {
                              setViewingSwitches({
                                [snap.switchId]: {
                                  deviceId: snap.switchId,
                                  name: snap.name,
                                  hostname: snap.hostname,
                                  ports: snap.interfaces.length,
                                  interfaces: snap.interfaces,
                                  vlans: snap.vlans,
                                  features: snap.features,
                                  routingTable: [],
                                  routingTable6: [],
                                  runningConfigText: snap.runningConfigText,
                                },
                              });
                              setViewingSessionName(snap.name);
                              setViewerOpen(true);
                            }}
                            className="rounded border border-edge px-2 py-0.5 text-[11px] text-[#8b98a5] hover:text-[#e6edf3]"
                          >
                            Inspect Config
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between border-t border-edge bg-panel-2 px-5 py-3 text-xs">
            <span className="text-[11px] text-[#6b7789]">
              Reopening any session restores all switch interfaces, VLANs, SONiC features, and cables.
            </span>
            <button onClick={onClose} className="btn py-1 px-4 text-xs">
              Close
            </button>
          </div>
        </div>
      </div>

      {/* Switch Config Viewer Modal */}
      <SwitchConfigViewerModal
        open={viewerOpen}
        onClose={() => setViewerOpen(false)}
        sessionName={viewingSessionName}
        switches={viewingSwitches}
      />

      {/* Firebase Settings Modal */}
      <FirebaseConfigModal
        open={configModalOpen}
        onClose={() => setConfigModalOpen(false)}
        onSaved={refreshSessions}
      />
    </>
  );
}

