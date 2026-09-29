/**
 * Monotonic id generators. Deterministic (no randomness) so simulation runs are
 * reproducible and unit-testable. Tests call resetIds() for stable output.
 */
let frameSeq = 1;
let eventSeq = 1;

export function nextFrameId(): string {
  return `f${frameSeq++}`;
}

export function nextEventId(): string {
  return `e${eventSeq++}`;
}

export function resetIds(): void {
  frameSeq = 1;
  eventSeq = 1;
}
