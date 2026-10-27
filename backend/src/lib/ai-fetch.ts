import { Agent, fetch, type RequestInit, type Response } from "undici";

// Node's built-in fetch gives up after 5 minutes without response headers or body data,
// which is too short for image generation. This agent turns those limits off; the
// AbortSignal below is what bounds each call instead.
const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

export class AiTimeoutError extends Error {}

/**
 * fetch for AI calls. Aborts after `timeoutMs`, or earlier if `signal` (the job's
 * deadline) fires first.
 */
export async function aiFetch(
  url: string,
  init: RequestInit & { timeoutMs: number; signal: AbortSignal },
): Promise<Response> {
  const { timeoutMs, signal, ...rest } = init;
  const callSignal = AbortSignal.timeout(timeoutMs);
  try {
    return await fetch(url, { ...rest, dispatcher, signal: AbortSignal.any([signal, callSignal]) });
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (callSignal.aborted) throw new AiTimeoutError(`Request timed out after ${Math.round(timeoutMs / 1000)}s.`);
    throw error;
  }
}
