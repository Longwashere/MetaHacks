import path from "node:path";

// Timeouts for AI work. Generous defaults because image generation can take minutes;
// override any of them in .env.

const MINUTE = 60_000;

function ms(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function url(name: string, fallback: string): string {
  return (process.env[name] || fallback).replace(/\/+$/, "");
}

export const PORT = Number(process.env.PORT ?? 4000);

/** Hard cap on a whole remix job (Muse + image model + packing). */
export const REMIX_JOB_TIMEOUT_MS = ms("REMIX_JOB_TIMEOUT_MS", 30 * MINUTE);
/**
 * How many remixes and part fixes run at once; the rest wait in line. Each job makes many Meta
 * calls in parallel (one per page, plus checks), and a burst of 4 Spark calls already hit failures.
 */
export const MAX_RUNNING_JOBS = Math.floor(ms("MAX_RUNNING_JOBS", 3));
/** Cap on a single Muse request. */
export const MUSE_TIMEOUT_MS = ms("MUSE_TIMEOUT_MS", 5 * MINUTE);
/** Cap on a single image model request. */
export const IMAGE_TIMEOUT_MS = ms("IMAGE_TIMEOUT_MS", 20 * MINUTE);

/** Meta Model API (OpenAI-compatible). */
export const META_API_BASE_URL = url("META_API_BASE_URL", "https://api.meta.ai/v1");
/**
 * A model id from the environment. Hosting dashboards often keep quotes or a trailing newline
 * pasted into a value, which the API rejects as model_not_found, so both are stripped.
 */
function modelId(name: string, fallback: string): string {
  return (process.env[name] ?? "").trim().replace(/^(["'])(.*)\1$/, "$2").trim() || fallback;
}

export const MUSE_MODEL = modelId("MUSE_MODEL", "muse-spark-1.3");
export const IMAGE_MODEL = modelId("IMAGE_MODEL", "muse-image-1.0");
/**
 * `reasoning_effort` for both generated-animation calls (plan and keyframes). The API accepts
 * none, minimal, low, medium, high, xhigh and max; other Muse calls send nothing and get its default.
 */
export const ANIMATE_REASONING_EFFORT = process.env.ANIMATE_REASONING_EFFORT || "medium";
/**
 * Whether generated animations get a third Muse call that looks at frames rendered from the
 * first pass and rewrites the keys (see reviewAnimation in animate.ts). Set to "off" to skip it.
 */
export const ANIMATE_REVIEW = process.env.ANIMATE_REVIEW !== "off";
/** Cap on the review call. It's skipped when the plan and keys already used more than ANIMATE_REVIEW_AFTER_MS. */
export const ANIMATE_REVIEW_TIMEOUT_MS = ms("ANIMATE_REVIEW_TIMEOUT_MS", 3 * MINUTE);
export const ANIMATE_REVIEW_AFTER_MS = ms("ANIMATE_REVIEW_AFTER_MS", 5 * MINUTE);

/**
 * Baseten's OpenAI-compatible API, serving Muse Spark Open (hackathon credits). The key only works
 * with that one model. Null until BASETEN_API_KEY is set; nothing calls it yet.
 */
export const BASETEN = (() => {
  const apiKey = process.env.BASETEN_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: url("BASETEN_API_BASE_URL", "https://inference.baseten.co/v1"),
    model: modelId("BASETEN_MODEL", "meta-models/muse-spark-open-1026"),
  };
})();

/** Where the base rigs' files are served from (the frontend serves /spine/… in dev). */
export const ASSET_BASE_URL = url("ASSET_BASE_URL", "http://localhost:5173");
/** This server's public origin, used to build URLs for generated textures. */
export const PUBLIC_URL = url("PUBLIC_URL", `http://localhost:${PORT}`);
/** Where generated atlases and textures are written when R2 isn't configured. */
export const REMIX_OUTPUT_DIR = path.resolve(process.env.REMIX_OUTPUT_DIR || "data/remixes");
/**
 * Where each auto-tweak run's snapshots, request and Muse reply are saved. Always local, never R2:
 * the snapshots can show private remixes.
 */
export const AUTO_TWEAK_LOG_DIR = path.resolve(process.env.AUTO_TWEAK_LOG_DIR || "data/auto-tweaks");
/** Where each generated-animation run's request, Muse reply and result are saved. Always local, like auto-tweak runs. */
export const ANIMATION_LOG_DIR = path.resolve(process.env.ANIMATION_LOG_DIR || "data/animations");

/** Cloudflare R2 bucket for generated files. Used only when every R2_* variable is set. */
export const R2 = (() => {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET;
  const publicUrl = process.env.R2_PUBLIC_URL?.replace(/\/+$/, "");
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket || !publicUrl) return null;
  return { accountId, accessKeyId, secretAccessKey, bucket, publicUrl };
})();

/** Supabase project. The backend uses the service-role key, so it bypasses RLS: keep it server-side. */
export const SUPABASE = (() => {
  const url = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) return null;
  return { url, serviceRoleKey };
})();

/** The website's public origin, for Stripe's return URLs. */
export const APP_URL = url("APP_URL", "http://localhost:5173");

/** Stripe subscription. Billing endpoints return 503 until all three are set. */
export const STRIPE = (() => {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const priceId = process.env.STRIPE_PRICE_ID;
  if (!secretKey || !webhookSecret || !priceId) return null;
  return { secretKey, webhookSecret, priceId };
})();

function count(name: string, fallback: number): number {
  const value = Number(process.env[name] || NaN);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

/** Credits each plan gets per calendar month (UTC). Failed jobs cost nothing. */
export const PLAN_CREDITS = {
  free: count("FREE_MONTHLY_CREDITS", 6),
  pro: count("PRO_MONTHLY_CREDITS", 200),
} as const;

/**
 * Credits a remix costs per atlas page it repaints. Muse Image is most of a job's cost and every
 * page is an image call (in v3, one per round); v3's loop makes about twice v2's Muse spend.
 */
export const CREDITS_PER_PAGE = { v1: 1, v2: 1, v3: 2 } as const;

/** Credits a part fix costs, whatever the number of parts. */
export const PART_FIX_CREDITS = 1;

/**
 * USD of Muse spend one credit stands for, for metered jobs (generated animations and edits). A
 * v3 remix spends about $0.026 (Spark plus two images) for 2 credits, so a credit is about $0.013;
 * Pro sells 200 credits for $20 ($0.10 each).
 */
export const CREDIT_USD = (() => {
  const value = Number(process.env.CREDIT_USD || NaN);
  return Number.isFinite(value) && value > 0 ? value : 0.0125;
})();

/** The fewest credits a metered job costs; also what it reserves while it runs. */
export const MIN_METERED_CREDITS = 1;

/**
 * Meta Model API prices in USD: per million tokens for chat models, per image for Muse Image.
 * From third-party listings (Meta's rate sheet wasn't reachable); the contributor rate is the
 * least confirmed. Unknown models are priced as standard Spark, so they never come out free.
 */
export const MUSE_RATES: Record<string, { inPerM: number; outPerM: number; perCall?: number }> = {
  "muse-spark-1.3": { inPerM: 1.25, outPerM: 4.25 },
  "muse-spark-1.3-contributor": { inPerM: 0.1, outPerM: 0.2 },
  "muse-image-1.0": { inPerM: 0, outPerM: 0, perCall: 0.01 },
};
export const DEFAULT_MUSE_RATE = MUSE_RATES["muse-spark-1.3"];

/** Distinct assets each plan can download per calendar month (UTC); null is unlimited. Admins are unlimited too. */
export const DOWNLOAD_LIMITS: Record<"free" | "pro", number | null> = {
  free: count("FREE_MONTHLY_DOWNLOADS", 3),
  pro: null,
};
