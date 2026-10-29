import Stripe from "stripe";
import { APP_URL, PLAN_LIMITS, STRIPE } from "./config.js";
import { PROFILE_COLUMNS, check, db, type Plan, type ProfileRow } from "./db.js";

// Plans, monthly remix allowance and the Stripe subscription. The webhook is the only thing that
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
  /** `limit` is null for unlimited (admins). */
  usage: { used: number; limit: number | null; resetsAt: string };
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

/** Remixes started this month that haven't failed. */
export async function remixesUsed(userId: string): Promise<number> {
  const { count, error } = await db()
    .from("remix_jobs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .neq("status", "failed")
    .gte("created_at", usagePeriod().start.toISOString());
  if (error) throw new Error(`Database error: ${error.message}`);
  return count ?? 0;
}

export async function getAccount(userId: string, isAdmin: boolean): Promise<Account> {
  const [profile, used] = await Promise.all([getProfile(userId), remixesUsed(userId)]);
  return {
    user: { id: profile.id, name: profile.name, avatarUrl: profile.avatar_url },
    plan: profile.plan,
    isAdmin,
    subscription: profile.subscription_status
      ? { status: profile.subscription_status, currentPeriodEnd: profile.current_period_end }
      : null,
    usage: { used, limit: isAdmin ? null : PLAN_LIMITS[profile.plan], resetsAt: usagePeriod().end.toISOString() },
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
