"use client";
import { useState } from "react";
import { SONIC_FEATURES, FEATURE_GROUPS } from "@/lib/sonic/feature-registry";
import { implementedSonicFeatures } from "@/lib/commands/sonic";
import { useLabStore } from "@/lib/store/lab-store";

/**
 * SONiC feature selector (task §9, §52). Read-only status board plus lab loaders
 * for implemented features. "Ready" = SONiC commands available now; the rest are
 * on the roadmap (docs/SONIC_ANALYSIS.md). Commands trace to 20Augcheats.
 */
export function SonicFeaturePanel() {
  const [open, setOpen] = useState(true);
  const loadFeatureLab = useLabStore((s) => s.loadFeatureLab);
  const ready = new Set(implementedSonicFeatures());

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="mb-2 flex w-full items-center justify-between panel-title"
      >
        <span>SONiC Feature Labs</span>
        <span>{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <>
          <div className="mb-2">
            <label className="text-[10px] uppercase tracking-wide text-[#5f6b7a]">DHCP scenario</label>
            <select
              className="mt-0.5 w-full rounded border border-edge bg-panel-2 px-1.5 py-1 text-[11px] text-[#c9d3de]"
              defaultValue=""
              onChange={(e) => {
                if (e.target.value) loadFeatureLab(e.target.value);
                e.currentTarget.selectedIndex = 0;
              }}
            >
              <option value="" disabled>
                Load a DHCP scenario…
              </option>
              <option value="dhcp">Direct server (same subnet)</option>
              <option value="dhcprelay">Relay agent (cross-subnet)</option>
            </select>
          </div>

          <div className="mb-2">
            <label className="text-[10px] uppercase tracking-wide text-[#5f6b7a]">NTP scenario</label>
            <select
              className="mt-0.5 w-full rounded border border-edge bg-panel-2 px-1.5 py-1 text-[11px] text-[#c9d3de]"
              defaultValue=""
              onChange={(e) => {
                if (e.target.value) loadFeatureLab(e.target.value);
                e.currentTarget.selectedIndex = 0;
              }}
            >
              <option value="" disabled>
                Load an NTP scenario…
              </option>
              <option value="ntp">Direct server (same subnet)</option>
              <option value="ntp-upstream">Public upstream via internet (routed)</option>
            </select>
          </div>

          <div className="mb-2">
            <label className="text-[10px] uppercase tracking-wide text-[#5f6b7a]">DNS scenario</label>
            <select
              className="mt-0.5 w-full rounded border border-edge bg-panel-2 px-1.5 py-1 text-[11px] text-[#c9d3de]"
              defaultValue=""
              onChange={(e) => {
                if (e.target.value) loadFeatureLab(e.target.value);
                e.currentTarget.selectedIndex = 0;
              }}
            >
              <option value="" disabled>
                Load a DNS scenario…
              </option>
              <option value="dns">Direct dns-server (A records)</option>
              <option value="dns-upstream">Public DNS via internet (routed)</option>
            </select>
          </div>

          <div className="flex flex-col gap-2">
            {FEATURE_GROUPS.map((g) => {
              const feats = SONIC_FEATURES.filter((f) => f.group === g.group);
              if (feats.length === 0) return null;
              return (
                <div key={g.group}>
                  <div className="text-[10px] uppercase tracking-wide text-[#5f6b7a]">{g.label}</div>
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    {feats.map((f) => {
                      const isReady = ready.has(f.id);
                      return (
                        <button
                          key={f.id}
                          type="button"
                          disabled={!isReady}
                          onClick={() => loadFeatureLab(f.id)}
                          title={isReady ? `Load the ${f.label} lab — ${f.description}` : `${f.description} (roadmap)`}
                          className={`flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] ${
                            isReady
                              ? "cursor-pointer border-ok/50 text-ok hover:border-ok hover:bg-ok/10"
                              : "cursor-default border-edge text-[#6b7789]"
                          }`}
                        >
                          <span
                            className="h-1.5 w-1.5 rounded-full"
                            style={{ background: isReady ? "#22c55e" : "#475569" }}
                          />
                          {f.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          <p className="mt-2 text-[10px] leading-relaxed text-[#5f6b7a]">
            Click a green feature to load a ready-to-use lab for it (topology + config).
            Grey features are on the roadmap.
          </p>
        </>
      )}
    </div>
  );
}
