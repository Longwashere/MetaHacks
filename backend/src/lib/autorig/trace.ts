import { putFile } from "../storage.js";

// A record of one auto-rig request, for debugging and pricing (AUTO_RIG_PLAN.md, "Tracing"). Every
// model call is timed with its usage and outcome, and the steps add what they decided (joints
// flagged, gear found and where it went, how much Muse filled). Prepare saves `prepare.json` in
// its own folder and hands the page its id; Build rig saves `autorig.json` beside the rig, linking
// to the prepare trace. Traces go to public storage like the rig files, so they hold no user data.

export type TraceStep = "pose" | "joints" | "gear" | "fill";

export interface TraceCall {
  step: TraceStep;
  model: string;
  /** What the call was for, e.g. the SAM phrase. */
  label?: string;
  startedAt: string;
  ms: number;
  ok: boolean;
  /** The response's `usage`, as the API sent it. */
  usage?: unknown;
  error?: string;
  /** What came back, in brief (matches, flagged joints…). */
  detail?: Record<string, unknown>;
}

/** Filled in by a traced call while it runs. */
export interface CallRecord {
  usage?: unknown;
  detail?: Record<string, unknown>;
}

const MAX_ERROR_LENGTH = 500;

export class RigTrace {
  readonly calls: TraceCall[] = [];
  readonly steps: Record<string, unknown> = {};
  private readonly started = Date.now();

  constructor(readonly kind: "prepare" | "create") {}

  /** Runs one model call, recording its time, usage and outcome even when it throws. */
  async call<T>(step: TraceStep, model: string, label: string | undefined, run: (record: CallRecord) => Promise<T>): Promise<T> {
    const record: CallRecord = {};
    const startedAt = new Date().toISOString();
    const t = Date.now();
    try {
      const value = await run(record);
      this.calls.push({ step, model, label, startedAt, ms: Date.now() - t, ok: true, ...record });
      return value;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.calls.push({ step, model, label, startedAt, ms: Date.now() - t, ok: false, ...record, error: message.slice(0, MAX_ERROR_LENGTH) });
      throw error;
    }
  }

  /** Records what a step decided. */
  set(key: string, value: unknown): void {
    this.steps[key] = value;
  }

  toJSON(): Record<string, unknown> {
    const byModel: Record<string, { calls: number; failed: number; ms: number }> = {};
    for (const c of this.calls) {
      const m = (byModel[c.model] ??= { calls: 0, failed: 0, ms: 0 });
      m.calls++;
      if (!c.ok) m.failed++;
      m.ms += c.ms;
    }
    return { kind: this.kind, startedAt: new Date(this.started).toISOString(), totalMs: Date.now() - this.started, byModel, steps: this.steps, calls: this.calls };
  }

  /** Saves the trace as `<name>` in the folder; a failed save is logged, never thrown. */
  async save(folder: string, name: string): Promise<void> {
    try {
      const json = this.toJSON();
      await putFile(folder, name, JSON.stringify(json, null, 1));
      const models = Object.entries(json.byModel as Record<string, { calls: number; failed: number }>)
        .map(([model, m]) => `${model} ×${m.calls}${m.failed ? ` (${m.failed} failed)` : ""}`)
        .join(", ");
      console.log(`[autorig] ${this.kind} trace: remixes/${folder}/${name} (${json.totalMs} ms; ${models || "no model calls"})`);
    } catch (error) {
      console.error(`[autorig] couldn't save the ${this.kind} trace`, error);
    }
  }
}

/** Folder names for traces: `<time>_autorig-prep_<id>` for prepare, the rig's own folder for create. */
export const PREPARE_FOLDER = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_autorig-prep_[0-9a-f]{8}$/;
