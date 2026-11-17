// setTimeout fires at once for any delay above 2^31 - 1 ms (about 24.8 days), so a deadline a month away
// would pass immediately. Every timer the SDK derives from a deadline, SLA, lease or poll interval uses this.
const MAX_DELAY = 2_147_483_647;

export interface LongTimer {
  clear(): void;
}

/** Like setTimeout, for any delay. `unref` lets the process exit while it waits, as `timer.unref()` does. */
export function setLongTimeout(fn: () => void, ms: number, o: { unref?: boolean } = {}): LongTimer {
  let t: ReturnType<typeof setTimeout> | undefined;
  let remaining = Math.max(0, ms);
  const arm = () => {
    const step = Math.min(remaining, MAX_DELAY);
    t = setTimeout(() => {
      remaining -= step;
      if (remaining > 0) arm();
      else fn();
    }, step);
    if (o.unref) t.unref?.();
  };
  arm();
  return { clear: () => clearTimeout(t) };
}
