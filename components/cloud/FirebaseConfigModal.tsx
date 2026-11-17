"use client";
import { useState, useEffect } from "react";
import {
  getStoredFirebaseConfig,
  saveStoredFirebaseConfig,
  isFirebaseConfigured,
  getFirestoreDb,
} from "@/lib/firebase/config";
import { FirebaseConfigOptions } from "@/lib/firebase/types";
import { collection, getDocs, limit, query } from "firebase/firestore";

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
}

export function FirebaseConfigModal({ open, onClose, onSaved }: Props) {
  const [apiKey, setApiKey] = useState("");
  const [authDomain, setAuthDomain] = useState("");
  const [projectId, setProjectId] = useState("");
  const [storageBucket, setStorageBucket] = useState("");
  const [messagingSenderId, setMessagingSenderId] = useState("");
  const [appId, setAppId] = useState("");
  const [pasteJson, setPasteJson] = useState("");
  const [statusMessage, setStatusMessage] = useState<{ type: "success" | "error" | "info"; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [rawMode, setRawMode] = useState(false);

  useEffect(() => {
    if (open) {
      const cfg = getStoredFirebaseConfig();
      if (cfg) {
        setApiKey(cfg.apiKey || "");
        setAuthDomain(cfg.authDomain || "");
        setProjectId(cfg.projectId || "");
        setStorageBucket(cfg.storageBucket || "");
        setMessagingSenderId(cfg.messagingSenderId || "");
        setAppId(cfg.appId || "");
      }
      setStatusMessage(null);
    }
  }, [open]);

  if (!open) return null;

  const handleParseJson = () => {
    try {
      let str = pasteJson.trim();
      // Handle "const firebaseConfig = { ... };"
      if (str.includes("{")) {
        const start = str.indexOf("{");
        const end = str.lastIndexOf("}");
        if (start !== -1 && end !== -1) {
          str = str.substring(start, end + 1);
        }
      }
      // Replace single quotes and unquoted keys
      const sanitized = str
        .replace(/'/g, '"')
        .replace(/([a-zA-Z0-9_]+)\s*:/g, '"$1":')
        .replace(/,\s*}/g, "}");

      const parsed = JSON.parse(sanitized);
      if (parsed.apiKey) setApiKey(parsed.apiKey);
      if (parsed.authDomain) setAuthDomain(parsed.authDomain);
      if (parsed.projectId) setProjectId(parsed.projectId);
      if (parsed.storageBucket) setStorageBucket(parsed.storageBucket);
      if (parsed.messagingSenderId) setMessagingSenderId(parsed.messagingSenderId);
      if (parsed.appId) setAppId(parsed.appId);

      setRawMode(false);
      setStatusMessage({ type: "info", text: "Configuration parsed from snippet. Click 'Test & Save' below." });
    } catch {
      setStatusMessage({ type: "error", text: "Invalid JSON or snippet format. Please check syntax." });
    }
  };

  const handleSaveAndTest = async () => {
    if (!apiKey.trim() || !projectId.trim()) {
      setStatusMessage({ type: "error", text: "API Key and Project ID are required." });
      return;
    }

    setTesting(true);
    setStatusMessage(null);

    const config: FirebaseConfigOptions = {
      apiKey: apiKey.trim(),
      authDomain: authDomain.trim() || undefined,
      projectId: projectId.trim(),
      storageBucket: storageBucket.trim() || undefined,
      messagingSenderId: messagingSenderId.trim() || undefined,
      appId: appId.trim() || "",
    };

    try {
      saveStoredFirebaseConfig(config);
      const db = getFirestoreDb();
      if (!db) {
        throw new Error("Could not initialize Firestore with this configuration.");
      }

      // Quick test query to verify Firestore connectivity
      const q = query(collection(db, "sonic_sessions"), limit(1));
      await getDocs(q);

      setStatusMessage({ type: "success", text: "Connected to Firebase Firestore successfully!" });
      setTesting(false);
      onSaved?.();
      setTimeout(() => {
        onClose();
      }, 900);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatusMessage({
        type: "error",
        text: `Connection test failed: ${msg}. (Check if Cloud Firestore is enabled in Firebase Console). Saved config locally regardless.`,
      });
      setTesting(false);
      onSaved?.();
    }
  };

  const handleDisconnect = () => {
    saveStoredFirebaseConfig(null);
    setApiKey("");
    setAuthDomain("");
    setProjectId("");
    setStorageBucket("");
    setMessagingSenderId("");
    setAppId("");
    setStatusMessage({ type: "info", text: "Firebase configuration cleared. Using local cache fallback." });
    onSaved?.();
  };

  const configured = isFirebaseConfigured();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="relative w-full max-w-lg rounded-xl border border-edge bg-panel shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-edge px-5 py-3.5 bg-panel-2">
          <div className="flex items-center gap-2">
            <span className="text-xl">🔥</span>
            <div>
              <h2 className="text-sm font-semibold text-[#e6edf3]">Firebase Database Connection</h2>
              <p className="text-[11px] text-[#8b98a5]">
                Persist switch sessions &amp; configurations to Cloud Firestore
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

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4 text-xs">
          {/* Status Badge */}
          <div className="flex items-center justify-between rounded-lg border border-edge bg-[#0a0d12] p-3">
            <div className="flex items-center gap-2.5">
              <span
                className={`h-2.5 w-2.5 rounded-full ${
                  configured ? "bg-green-400 shadow-[0_0_8px_#22c55e]" : "bg-amber-400"
                }`}
              />
              <div>
                <div className="font-semibold text-[#e6edf3]">
                  {configured ? "Firebase Configured" : "Not Connected to Firebase"}
                </div>
                <div className="text-[11px] text-[#6b7789]">
                  {configured
                    ? `Project: ${projectId || "Active"} · Sessions sync to Firestore`
                    : "Sessions currently saved to local storage cache"}
                </div>
              </div>
            </div>
            {configured && (
              <button
                onClick={handleDisconnect}
                className="rounded border border-edge px-2 py-1 text-[11px] text-red-400 hover:border-red-500/50 hover:bg-red-500/10"
              >
                Disconnect
              </button>
            )}
          </div>

          {/* Mode Toggle */}
          <div className="flex gap-2 border-b border-edge pb-2">
            <button
              onClick={() => setRawMode(false)}
              className={`px-3 py-1 text-xs rounded ${
                !rawMode ? "bg-accent-2/20 text-accent-2 font-semibold" : "text-[#8b98a5] hover:text-[#e6edf3]"
              }`}
            >
              Field by Field
            </button>
            <button
              onClick={() => setRawMode(true)}
              className={`px-3 py-1 text-xs rounded ${
                rawMode ? "bg-accent-2/20 text-accent-2 font-semibold" : "text-[#8b98a5] hover:text-[#e6edf3]"
              }`}
            >
              Paste Firebase Snippet
            </button>
          </div>

          {rawMode ? (
            <div className="space-y-2">
              <label className="block text-[11px] text-[#8b98a5]">
                Paste your <code className="text-accent-2">firebaseConfig</code> object from Firebase Console:
              </label>
              <textarea
                value={pasteJson}
                onChange={(e) => setPasteJson(e.target.value)}
                rows={7}
                placeholder={`const firebaseConfig = {\n  apiKey: "AIza...",\n  authDomain: "...",\n  projectId: "...",\n  appId: "..."\n};`}
                className="w-full font-mono text-[11px] rounded border border-edge bg-[#0a0d12] p-2 text-[#e6edf3] outline-none focus:border-accent-2"
              />
              <button
                type="button"
                onClick={handleParseJson}
                className="btn-primary w-full py-1.5"
              >
                Parse &amp; Apply
              </button>
            </div>
          ) : (
            <div className="space-y-2.5">
              <div>
                <label className="block mb-1 text-[11px] font-medium text-[#8b98a5]">
                  API Key <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="AIzaSy..."
                  className="w-full rounded border border-edge bg-[#0a0d12] px-2.5 py-1.5 text-xs text-[#e6edf3] outline-none focus:border-accent-2"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block mb-1 text-[11px] font-medium text-[#8b98a5]">
                    Project ID <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="text"
                    value={projectId}
                    onChange={(e) => setProjectId(e.target.value)}
                    placeholder="my-sonic-lab"
                    className="w-full rounded border border-edge bg-[#0a0d12] px-2.5 py-1.5 text-xs text-[#e6edf3] outline-none focus:border-accent-2"
                  />
                </div>
                <div>
                  <label className="block mb-1 text-[11px] font-medium text-[#8b98a5]">Auth Domain</label>
                  <input
                    type="text"
                    value={authDomain}
                    onChange={(e) => setAuthDomain(e.target.value)}
                    placeholder="my-sonic-lab.firebaseapp.com"
                    className="w-full rounded border border-edge bg-[#0a0d12] px-2.5 py-1.5 text-xs text-[#e6edf3] outline-none focus:border-accent-2"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block mb-1 text-[11px] font-medium text-[#8b98a5]">Storage Bucket</label>
                  <input
                    type="text"
                    value={storageBucket}
                    onChange={(e) => setStorageBucket(e.target.value)}
                    placeholder="my-sonic-lab.appspot.com"
                    className="w-full rounded border border-edge bg-[#0a0d12] px-2.5 py-1.5 text-xs text-[#e6edf3] outline-none focus:border-accent-2"
                  />
                </div>
                <div>
                  <label className="block mb-1 text-[11px] font-medium text-[#8b98a5]">App ID</label>
                  <input
                    type="text"
                    value={appId}
                    onChange={(e) => setAppId(e.target.value)}
                    placeholder="1:123456789:web:abcdef"
                    className="w-full rounded border border-edge bg-[#0a0d12] px-2.5 py-1.5 text-xs text-[#e6edf3] outline-none focus:border-accent-2"
                  />
                </div>
              </div>
            </div>
          )}

          {statusMessage && (
            <div
              className={`rounded-lg border p-2.5 text-[11px] leading-relaxed ${
                statusMessage.type === "success"
                  ? "border-green-500/40 bg-green-500/10 text-green-300"
                  : statusMessage.type === "error"
                  ? "border-red-500/40 bg-red-500/10 text-red-300"
                  : "border-blue-500/40 bg-blue-500/10 text-blue-300"
              }`}
            >
              {statusMessage.text}
            </div>
          )}

          <div className="rounded-lg border border-edge bg-[#0a0d12] p-3 text-[11px] text-[#6b7789] space-y-1">
            <div className="font-semibold text-[#8b98a5]">Firebase Setup Guide:</div>
            <ol className="list-decimal pl-4 space-y-0.5">
              <li>Open <span className="text-accent-2">console.firebase.google.com</span> and create a project</li>
              <li>Under Project Settings, add a <strong>Web App</strong> to get your credentials</li>
              <li>Go to <strong>Build &gt; Firestore Database</strong> and click Create Database (Test mode is easiest)</li>
              <li>Paste the credentials above and click <strong>Test &amp; Connect</strong></li>
            </ol>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-edge bg-panel-2 px-5 py-3">
          <button onClick={onClose} className="btn py-1.5 px-3">
            Close
          </button>
          <button
            onClick={handleSaveAndTest}
            disabled={testing}
            className="btn-primary py-1.5 px-4 flex items-center gap-2"
          >
            {testing ? (
              <>
                <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />
                Testing...
              </>
            ) : (
              "Test & Connect"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

