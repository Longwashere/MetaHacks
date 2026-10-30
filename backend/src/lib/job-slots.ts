import { MAX_RUNNING_JOBS } from "./config.js";

// Remixes and part fixes share these slots: each one makes many Meta calls and does pixel work
// on the main thread, so too many at once trip rate limits and slow every request.

interface Waiter {
  start: () => void;
  onPosition: (ahead: number) => void;
}

let running = 0;
const waiting: Waiter[] = [];

/**
 * Runs `task` once a slot is free, first in, first out. While it waits, `onPosition` is told how
 * many jobs are ahead of it (0 means it's next), and again each time that changes.
 */
export async function runInSlot<T>(task: () => Promise<T>, onPosition: (ahead: number) => void = () => {}): Promise<T> {
  if (running >= MAX_RUNNING_JOBS) {
    await new Promise<void>((start) => {
      waiting.push({ start, onPosition });
      onPosition(waiting.length - 1);
    });
  }
  running++;
  try {
    return await task();
  } finally {
    running--;
    waiting.shift()?.start();
    waiting.forEach((w, i) => w.onPosition(i));
  }
}

/** The stage text for a job waiting in line. */
export function queuedStage(ahead: number): string {
  return ahead === 0 ? "Queued: you're next" : `Queued: ${ahead} ${ahead === 1 ? "job" : "jobs"} ahead of you`;
}
