#!/usr/bin/env node
/**
 * Vendor the packet engine runtime into public/packet-engine/ so the browser
 * never fetches code from a CDN or PyPI at runtime:
 *   - Pyodide (CPython on WebAssembly) from node_modules/pyodide
 *   - the pinned Scapy wheel from PyPI, verified by sha256
 * Idempotent; runs before `dev` and `build`.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "public", "packet-engine");
const pyodideDir = join(root, "node_modules", "pyodide");

const PYODIDE_FILES = ["pyodide.js", "pyodide.asm.js", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"];
const SCAPY = {
  file: "scapy-2.8.0-py3-none-any.whl",
  url: "https://files.pythonhosted.org/packages/b9/1e/f07107ed79e69a659f1ab65ee7894d71fc1cf15108cf475782d3979a480d/scapy-2.8.0-py3-none-any.whl",
  sha256: "abf855145ee829a42b2eb28983cd6a0a52b12a31d3f861cb7be36791195ed9aa",
};

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

mkdirSync(out, { recursive: true });
for (const f of PYODIDE_FILES) {
  const src = join(pyodideDir, f);
  if (!existsSync(src)) throw new Error(`missing ${src} — run npm install`);
  copyFileSync(src, join(out, f));
}

const wheel = join(out, SCAPY.file);
if (!existsSync(wheel) || sha256(readFileSync(wheel)) !== SCAPY.sha256) {
  const res = await fetch(SCAPY.url);
  if (!res.ok) throw new Error(`download ${SCAPY.url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== SCAPY.sha256) throw new Error(`scapy wheel sha256 mismatch: ${got}`);
  writeFileSync(wheel, buf);
}
writeFileSync(join(out, "manifest.json"), JSON.stringify({ pyodide: "0.26.4", scapyWheel: SCAPY.file }, null, 2));
console.log(`packet engine vendored into ${out}`);
