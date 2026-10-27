import { randomUUID } from "node:crypto";
import { AiTimeoutError } from "./ai-fetch.js";
import { REMIX_JOB_TIMEOUT_MS } from "./config.js";
import { runRemix } from "./remix.js";
import type { RemixJob, RemixRequest } from "./types.js";

// In-memory store; resets on restart. Swap for a database or queue when you need persistence.
const jobs = new Map<string, RemixJob>();

/** Creates a queued job and starts it in the background. Returns right away. */
export function createRemixJob(input: RemixRequest): RemixJob {
  const job: RemixJob = {
    id: `job_${randomUUID().slice(0, 8)}`,
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
  void runJob(job);
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
