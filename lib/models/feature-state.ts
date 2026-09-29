/**
 * Per-device feature-config store access (the simulated CONFIG_DB, task §15).
 *
 * Feature modules keep their configuration/state under device.config.features[id]
 * so adding a feature requires no model changes. `config` commands mutate it;
 * `show` commands + `show running-config` read it — one source of truth (§61).
 */
import { Device } from "./device";

/** Get the feature's state, lazily initializing it with `init()` on first use. */
export function featureState<T>(device: Device, id: string, init: () => T): T {
  const cfg = device.config;
  if (!cfg.features) cfg.features = {};
  if (cfg.features[id] === undefined) cfg.features[id] = init();
  return cfg.features[id] as T;
}

/** Read a feature's state without creating it (undefined if never configured). */
export function peekFeatureState<T>(device: Device, id: string): T | undefined {
  return device.config.features?.[id] as T | undefined;
}
