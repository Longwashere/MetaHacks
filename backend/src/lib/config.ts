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
/** Cap on a single Muse request. */
export const MUSE_TIMEOUT_MS = ms("MUSE_TIMEOUT_MS", 5 * MINUTE);
/** Cap on a single image model request. */
export const IMAGE_TIMEOUT_MS = ms("IMAGE_TIMEOUT_MS", 20 * MINUTE);

/** Meta Model API (OpenAI-compatible). */
export const META_API_BASE_URL = url("META_API_BASE_URL", "https://api.meta.ai/v1");
export const MUSE_MODEL = process.env.MUSE_MODEL || "muse-spark-1.3";
export const IMAGE_MODEL = process.env.IMAGE_MODEL || "muse-image-1.0";

/** Where the base rigs' files are served from (the frontend serves /spine/… in dev). */
export const ASSET_BASE_URL = url("ASSET_BASE_URL", "http://localhost:5173");
/** This server's public origin, used to build URLs for generated textures. */
export const PUBLIC_URL = url("PUBLIC_URL", `http://localhost:${PORT}`);
/** Where generated atlases and textures are written when R2 isn't configured. */
export const REMIX_OUTPUT_DIR = path.resolve(process.env.REMIX_OUTPUT_DIR || "data/remixes");

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

/** Remixes each plan can start per calendar month (UTC). Failed remixes don't count. */
export const PLAN_LIMITS = {
  free: count("FREE_MONTHLY_REMIXES", 3),
  pro: count("PRO_MONTHLY_REMIXES", 100),
} as const;
