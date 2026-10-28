import { randomUUID } from "node:crypto";
import { AiTimeoutError } from "../../lib/ai-fetch.js";
import { REMIX_JOB_TIMEOUT_MS } from "../../lib/config.js";
import { runRemix } from "./remix.js";
import type { RemixJob, RemixRequest } from "./types.js";

// Live progress lives here and resets on restart; remix-jobs.ts records each job in the database.
const jobs = new Map<string, RemixJob>();

export interface RemixJobOptions {
  /** Job id; generated when omitted. */
  id?: string;
  /** Called once when the job succeeds or fails. Errors it throws are logged. */
  onSettled?: (job: RemixJob) => Promise<void>;
}

export function newRemixJobId(): string {
  return `job_${randomUUID().slice(0, 8)}`;
}

/** Creates a queued job and starts it in the background. Returns right away. */
export function createRemixJob(input: RemixRequest, { id = newRemixJobId(), onSettled }: RemixJobOptions = {}): RemixJob {
  const job: RemixJob = {
    id,
    status: "queued",
    progress: 0,
    stage: "Queued",
    input,
    createdAt: new Date().toISOString(),
    editPrompt: null,
    promptStatus: "original",
    result: null,
    error: null,
  };
  jobs.set(job.id, job);
  void runJob(job).then(async () => {
    try {
      await onSettled?.(job);
    } catch (error) {
      console.error(`Recording remix job ${job.id} failed`, error);
    }
  });
  return job;
}

export function getRemixJob(id: string): RemixJob | null {
  return jobs.get(id) ?? null;
}

async function runJob(job: RemixJob) {
  job.status = "running";
  const deadline = AbortSignal.timeout(REMIX_JOB_TIMEOUT_MS);
  try {
    const result = await runRemix(
      job.id,
      job.input,
      (progress, stage) => {
        job.progress = Math.min(Math.max(progress, 0), 0.99);
        job.stage = stage;
      },
      (editPrompt, promptStatus) => {
        job.editPrompt = editPrompt;
        job.promptStatus = promptStatus;
      },
      deadline,
    );
    // The model code might ignore the signal; the deadline still wins.
    deadline.throwIfAborted();
    job.result = result;
    job.status = "succeeded";
    job.progress = 1;
    job.stage = "Done";
  } catch (error) {
    console.error(`Remix job ${job.id} failed`, error);
    job.status = "failed";
    job.error = deadline.aborted || error instanceof AiTimeoutError
      ? "The remix took too long. Try again."
      : error instanceof Error
        ? error.message
        : "Something went wrong. Try again with a different prompt.";
  }
}
