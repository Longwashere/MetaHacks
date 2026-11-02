import Stripe from "stripe";
import { APP_URL, CREDIT_USD, CREDITS_PER_PAGE, DEFAULT_MUSE_RATE, DOWNLOAD_LIMITS, MIN_METERED_CREDITS, MUSE_RATES, PART_FIX_CREDITS, PLAN_CREDITS, STRIPE } from "./config.js";
import type { ModelCall } from "../v3/lib/meta.js";
import { PROFILE_COLUMNS, check, db, type Plan, type ProfileRow, type RemixJobRow } from "./db.js";

// Plans, monthly credits and the Stripe subscription. The webhook is the only thing that
// changes a profile's plan; checkout and the portal just send the user to Stripe.

let stripeClient: Stripe | null = null;

export function billingEnabled(): boolean {
  return STRIPE !== null;
}

function stripe(): Stripe {
  if (!STRIPE) throw new Error("Stripe isn't configured; set STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and STRIPE_PRICE_ID.");
  stripeClient ??= new Stripe(STRIPE.secretKey);
  return stripeClient;
}

export interface Account {
  user: { id: string; name: string; avatarUrl: string | null };
  plan: Plan;
  /** Admins have no remix limit and can see and moderate any asset. */
  isAdmin: boolean;
  subscription: { status: string; currentPeriodEnd: string | null } | null;
  /** Credits spent this month; `limit` is null for unlimited (admins). */
  usage: { used: number; limit: number | null; resetsAt: string };
  /** What things cost, so the UI can price a remix before it starts. */
  credits: CreditRules;
  /** Distinct assets downloaded this month. `limit` is null for unlimited (Pro and admins). */
  downloads: { used: number; limit: number | null; resetsAt: string };
  billingEnabled: boolean;
}

export async function getProfile(userId: string): Promise<ProfileRow> {
  const profile = check(
    await db().from("profiles").select(PROFILE_COLUMNS).eq("id", userId).maybeSingle().overrideTypes<ProfileRow | null, { merge: false }>(),
  );
  // The auth trigger creates the profile at sign-up; a missing one means the user was deleted.
  if (!profile) throw new Error(`No profile for user ${userId}`);
  return profile;
}

/** Start of this calendar month and of the next one, in UTC. */
function usagePeriod(now = new Date()): { start: Date; end: Date } {
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}

export interface CreditRules {
  /** Credits per atlas page, by remix API version. */
  perPage: typeof CREDITS_PER_PAGE;
  partFix: number;
  /** Generated animations and edits are metered: their Muse cost over `creditUsd`, rounded up, at least `min`. */
  animation: { creditUsd: number; min: number };
  /** Each plan's credits per month. */
  monthly: typeof PLAN_CREDITS;
}

export const CREDIT_RULES: CreditRules = {
  perPage: CREDITS_PER_PAGE,
  partFix: PART_FIX_CREDITS,
  animation: { creditUsd: CREDIT_USD, min: MIN_METERED_CREDITS },
  monthly: PLAN_CREDITS,
};

/** What `calls` cost in USD at MUSE_RATES. */
export function museCostUsd(calls: Pick<ModelCall, "model" | "promptTokens" | "completionTokens">[]): number {
  return calls.reduce((sum, c) => {
    const rate = MUSE_RATES[c.model] ?? DEFAULT_MUSE_RATE;
    return sum + (c.promptTokens * rate.inPerM + c.completionTokens * rate.outPerM) / 1e6 + (rate.perCall ?? 0);
  }, 0);
}

/** Credits a metered job costs: its Muse cost in credits, rounded up, at least MIN_METERED_CREDITS. */
export function meteredCredits(costUsd: number): number {
  // The epsilon keeps float noise (0.0250000001 / 0.0125) from rounding up a whole extra credit.
  return Math.max(MIN_METERED_CREDITS, Math.ceil(costUsd / CREDIT_USD - 1e-9));
}

/** Credits a remix of a rig with `pages` atlas pages costs. */
export function remixCredits(apiVersion: keyof typeof CREDITS_PER_PAGE, pages: number): number {
  return CREDITS_PER_PAGE[apiVersion] * Math.max(pages, 1);
}

/** One remix, part fix or animation job this month and what it cost, for the account page. */
export interface CreditHistoryEntry {
  jobId: string;
  createdAt: string;
  kind: "remix" | "part-fix" | "animation" | "animation-edit";
  /** Null for animation jobs. */
  apiVersion: keyof typeof CREDITS_PER_PAGE | null;
  status: "queued" | "running" | "succeeded" | "failed";
  /** The rig remixed, or the remix whose parts were fixed; null once deleted. */
  rigName: string | null;
  /** The remix it made or fixed, for a link; null until it's saved, or if it failed or was deleted. */
  assetId: string | null;
  /** Atlas pages repainted; null for part fixes and animation jobs. */
  pages: number | null;
  /** The animation an animation job made or edited; null for remixes and part fixes. */
  animation: string | null;
  /** What it costs; a failed job's cost is refunded (left out of usage). */
  credits: number;
}

/** An animation_jobs row; see supabase/migrations/20261102000000_animation_jobs.sql. */
interface AnimationJobRow {
  id: string;
  created_at: string;
  kind: "new" | "edit";
  status: "running" | "succeeded" | "failed";
  asset_id: string | null;
  animation: string | null;
  credits: number;
}

/** This month's remixes, part fixes and animation jobs, newest first. */
export async function creditHistory(userId: string): Promise<CreditHistoryEntry[]> {
  const [remixes, animations] = await Promise.all([remixHistory(userId), animationHistory(userId)]);
  return [...remixes, ...animations].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function animationHistory(userId: string): Promise<CreditHistoryEntry[]> {
  const jobs = check(
    await db()
      .from("animation_jobs")
      .select("id, created_at, kind, status, asset_id, animation, credits")
      .eq("user_id", userId)
      .gte("created_at", usagePeriod().start.toISOString())
      .overrideTypes<AnimationJobRow[], { merge: false }>(),
  );
  const ids = [...new Set(jobs.flatMap((j) => (j.asset_id ? [j.asset_id] : [])))];
  const names = await assetNames(ids);
  return jobs.map((j) => ({
    jobId: j.id,
    createdAt: j.created_at,
    kind: j.kind === "edit" ? "animation-edit" : "animation",
    apiVersion: null,
    status: j.status,
    rigName: (j.asset_id && names.get(j.asset_id)) ?? null,
    assetId: j.asset_id,
    pages: null,
    animation: j.animation,
    credits: j.credits,
  }));
}

async function assetNames(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = check(await db().from("assets").select("id, name").in("id", ids).overrideTypes<{ id: string; name: string }[], { merge: false }>());
  return new Map(rows.map((a) => [a.id, a.name] as const));
}

async function remixHistory(userId: string): Promise<CreditHistoryEntry[]> {
  const jobs = check(
    await db()
      .from("remix_jobs")
      .select("id, created_at, api_version, input, status, base_asset_id, asset_id, credits")
      .eq("user_id", userId)
      .gte("created_at", usagePeriod().start.toISOString())
      .order("created_at", { ascending: false })
      .overrideTypes<
        Pick<RemixJobRow, "id" | "created_at" | "api_version" | "input" | "status" | "base_asset_id" | "asset_id" | "credits">[],
        { merge: false }
      >(),
  );
  const names = await assetNames([...new Set(jobs.flatMap((j) => (j.base_asset_id ? [j.base_asset_id] : [])))]);
  return jobs.map((j): CreditHistoryEntry => {
    const partFix = j.input.kind === "parts";
    return {
      jobId: j.id,
      createdAt: j.created_at,
      kind: partFix ? "part-fix" : "remix",
      apiVersion: j.api_version,
      status: j.status,
      rigName: (j.base_asset_id && names.get(j.base_asset_id)) ?? null,
      assetId: j.status === "failed" ? null : j.asset_id,
      pages: partFix ? null : Math.max(Math.round(j.credits / CREDITS_PER_PAGE[j.api_version]), 1),
      animation: null,
      credits: j.credits,
    };
  });
}

/** Credits spent this month on remix and animation jobs that haven't failed. */
export async function creditsUsed(userId: string): Promise<number> {
  const spent = async (table: "remix_jobs" | "animation_jobs") =>
    check(
      await db()
        .from(table)
        .select("credits")
        .eq("user_id", userId)
        .neq("status", "failed")
        .gte("created_at", usagePeriod().start.toISOString())
        .overrideTypes<{ credits: number }[], { merge: false }>(),
    ).reduce((sum, row) => sum + row.credits, 0);
  const [remixes, animations] = await Promise.all([spent("remix_jobs"), spent("animation_jobs")]);
  return remixes + animations;
}

/** Distinct assets downloaded this month. */
export async function downloadsUsed(userId: string): Promise<number> {
  const { count, error } = await db()
    .from("downloads")
    .select("asset_id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("period", usagePeriod().start.toISOString().slice(0, 10));
  if (error) throw new Error(`Database error: ${error.message}`);
  return count ?? 0;
}

export function downloadLimit(plan: Plan, isAdmin: boolean): number | null {
  return isAdmin ? null : DOWNLOAD_LIMITS[plan];
}

export type DownloadResult = { allowed: boolean; used: number; limit: number | null; resetsAt: string };

/** Records a download against this month's allowance, unless it's used up. Re-downloading an asset this month is free. */
export async function recordDownload(userId: string, assetId: string, isAdmin: boolean): Promise<DownloadResult> {
  const limit = downloadLimit((await getProfile(userId)).plan, isAdmin);
  const rows = check(await db().rpc("record_download", { p_user_id: userId, p_asset_id: assetId, p_limit: limit })) as
    | { allowed: boolean; used: number }[]
    | null;
  const row = rows?.[0];
  if (!row) throw new Error("record_download returned no row");
  return { allowed: row.allowed, used: row.used, limit, resetsAt: usagePeriod().end.toISOString() };
}

export async function getAccount(userId: string, isAdmin: boolean): Promise<Account> {
  const [profile, used, downloads] = await Promise.all([getProfile(userId), creditsUsed(userId), downloadsUsed(userId)]);
  return {
    user: { id: profile.id, name: profile.name, avatarUrl: profile.avatar_url },
    plan: profile.plan,
    isAdmin,
    subscription: profile.subscription_status
      ? { status: profile.subscription_status, currentPeriodEnd: profile.current_period_end }
      : null,
    usage: { used, limit: isAdmin ? null : PLAN_CREDITS[profile.plan], resetsAt: usagePeriod().end.toISOString() },
    credits: CREDIT_RULES,
    downloads: { used: downloads, limit: downloadLimit(profile.plan, isAdmin), resetsAt: usagePeriod().end.toISOString() },
    billingEnabled: billingEnabled(),
  };
}

/** Sets the user's display name and renames them on every asset they authored (assets copy the name when made). */
export async function setDisplayName(userId: string, name: string): Promise<void> {
  check(await db().from("profiles").update({ name }).eq("id", userId));
  check(await db().from("assets").update({ author_name: name }).eq("author_id", userId));
}

/** The user's Stripe customer, created on first checkout. */
async function customerFor(profile: ProfileRow): Promise<string> {
  if (profile.stripe_customer_id) return profile.stripe_customer_id;
  const { data } = await db().auth.admin.getUserById(profile.id);
  const customer = await stripe().customers.create({
    email: data.user?.email,
    name: profile.name || undefined,
    metadata: { userId: profile.id },
  });
  check(await db().from("profiles").update({ stripe_customer_id: customer.id }).eq("id", profile.id));
  return customer.id;
}

/** A Stripe Checkout URL for the Pro subscription. */
export async function createCheckoutUrl(userId: string): Promise<string> {
  const profile = await getProfile(userId);
  const session = await stripe().checkout.sessions.create({
    mode: "subscription",
    customer: await customerFor(profile),
    client_reference_id: userId,
    line_items: [{ price: STRIPE!.priceId, quantity: 1 }],
    subscription_data: { metadata: { userId } },
    allow_promotion_codes: true,
    success_url: `${APP_URL}/account?checkout=success`,
    cancel_url: `${APP_URL}/account?checkout=cancelled`,
  });
  if (!session.url) throw new Error("Stripe didn't return a checkout URL.");
  return session.url;
}

/** A Stripe customer portal URL (change card, cancel), or null if the user never subscribed. */
export async function createPortalUrl(userId: string): Promise<string | null> {
  const profile = await getProfile(userId);
  if (!profile.stripe_customer_id) return null;
  const session = await stripe().billingPortal.sessions.create({
    customer: profile.stripe_customer_id,
    return_url: `${APP_URL}/account`,
  });
  return session.url;
}

/** Verifies a webhook payload's signature and returns the event. Throws on a bad signature. */
export function parseWebhook(rawBody: Buffer, signature: string): Stripe.Event {
  return stripe().webhooks.constructEvent(rawBody, signature, STRIPE!.webhookSecret);
}

const PRO_STATUSES = new Set(["active", "trialing", "past_due"]);

/** Applies subscription changes to the matching profile. Other events are ignored. */
export async function handleWebhook(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      if (session.mode !== "subscription" || typeof session.subscription !== "string") return;
      await syncSubscription(await stripe().subscriptions.retrieve(session.subscription));
      return;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      // Re-fetch so out-of-order events can't leave a stale state behind.
      await syncSubscription(await stripe().subscriptions.retrieve(event.data.object.id));
      return;
  }
}

async function syncSubscription(subscription: Stripe.Subscription): Promise<void> {
  const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
  const periodEnd = subscription.items.data[0]?.current_period_end;
  const pro = PRO_STATUSES.has(subscription.status);
  const update = {
    plan: pro ? "pro" : "free",
    subscription_id: subscription.id,
    subscription_status: subscription.status,
    current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
  };
  // Customers are created by customerFor(), so they always map to a profile; fall back to the
  // metadata for subscriptions made some other way (e.g. in the Stripe dashboard).
  const updated = check(await db().from("profiles").update(update).eq("stripe_customer_id", customerId).select("id"));
  if ((updated ?? []).length > 0) return;
  const userId = subscription.metadata.userId;
  if (!userId) {
    console.warn(`Stripe subscription ${subscription.id} has no matching profile (customer ${customerId})`);
    return;
  }
  check(await db().from("profiles").update({ ...update, stripe_customer_id: customerId }).eq("id", userId));
}
