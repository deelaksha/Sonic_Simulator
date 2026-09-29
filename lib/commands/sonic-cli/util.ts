/** Shared helpers for sonic-cli feature handlers. */

/** Expand "10", "200-205", "10,20-22" into a concrete id list (null if malformed). */
export function expandVlanSpec(spec: string): number[] | null {
  if (!spec) return null;
  const ids: number[] = [];
  for (const part of spec.split(",")) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) return null;
    const a = parseInt(m[1], 10);
    const b = m[2] ? parseInt(m[2], 10) : a;
    if (b < a || b - a > 512) return null;
    for (let v = a; v <= b; v++) ids.push(v);
  }
  return ids;
}
