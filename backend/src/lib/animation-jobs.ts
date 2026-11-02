import { randomUUID } from "node:crypto";
import { AnimateError, type AnimateResult } from "./animate.js";
import { meteredCredits, museCostUsd } from "./billing.js";
import { MIN_METERED_CREDITS } from "./config.js";
import { check, db } from "./db.js";
import { allowanceError } from "./remix-jobs.js";
import { type ModelCall, recordModelCalls, totalUsage } from "../v3/lib/meta.js";

// Billing for generated animations and edits. Unlike remixes they run inside the request, so a job
// is one animation_jobs row: it reserves MIN_METERED_CREDITS while Muse works, then is charged
// what its Muse calls cost (meteredCredits). Failed jobs are free, like failed remixes.

export type MeteredAnimateResult = AnimateResult & {
  /** Credits the job was charged. */
  credits: number;
};

/**
 * Runs `task` (generateAnimation or editAnimation) as one of the user's animation jobs: refused
 * with 402 when the user doesn't have the minimum left, recorded, and charged by token use.
 */
export async function runAnimationJob(
  userId: string,
  isAdmin: boolean,
  assetId: string,
  kind: "new" | "edit",
  animation: string | null,
  task: () => Promise<AnimateResult>,
): Promise<MeteredAnimateResult> {
  const limitError = await allowanceError(userId, isAdmin, MIN_METERED_CREDITS);
  if (limitError) throw new AnimateError(limitError, 402);

  const id = `anim_${randomUUID()}`;
  check(await db().from("animation_jobs").insert({ id, user_id: userId, asset_id: assetId, kind, animation, status: "running", credits: MIN_METERED_CREDITS }));

  const calls: ModelCall[] = [];
  const settle = async (status: "succeeded" | "failed", fields: { animation?: string; error?: string }) => {
    const costUsd = museCostUsd(calls);
    const credits = meteredCredits(costUsd);
    const byModel = Object.fromEntries([...new Set(calls.map((c) => c.model))].map((m) => [m, totalUsage(calls.filter((c) => c.model === m))]));
    check(
      await db()
        .from("animation_jobs")
        .update({ status, credits, cost_usd: Math.round(costUsd * 1e6) / 1e6, usage: byModel, ...fields })
        .eq("id", id),
    );
    console.log(`[billing] animation job ${id} ${status}: $${costUsd.toFixed(4)} → ${credits} credit${credits === 1 ? "" : "s"}${status === "failed" ? " (not charged)" : ""}`);
    return credits;
  };

  try {
    const result = await recordModelCalls(calls, task);
    const credits = await settle("succeeded", { animation: result.animation.name });
    return { ...result, credits };
  } catch (error) {
    await settle("failed", { error: error instanceof Error ? error.message.slice(0, 500) : String(error) }).catch((e: unknown) =>
      console.error(`Couldn't settle animation job ${id}`, e),
    );
    throw error;
  }
}
