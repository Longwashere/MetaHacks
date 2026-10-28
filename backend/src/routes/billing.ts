import express, { Router } from "express";
import { requireUser, userIdOf } from "../lib/auth.js";
import { billingEnabled, createCheckoutUrl, createPortalUrl, getProfile, handleWebhook, parseWebhook } from "../lib/billing.js";

// Stripe subscription. Mounted before the global JSON parser: the webhook needs the raw body to
// check Stripe's signature.
export const billingRouter = Router();

billingRouter.use((_req, res, next) => {
  if (!billingEnabled()) {
    res.status(503).json({ error: "Payments aren't set up yet." });
    return;
  }
  next();
});

/** POST /billing/checkout → { url } of a Stripe Checkout page, or of the portal if already on Pro */
billingRouter.post("/checkout", requireUser, async (_req, res) => {
  const userId = userIdOf(res);
  // A second checkout would start a second subscription; send subscribers to the portal instead.
  const profile = await getProfile(userId);
  const url = profile.plan === "pro" ? await createPortalUrl(userId) : await createCheckoutUrl(userId);
  res.json({ url });
});

/** POST /billing/portal → { url } of the Stripe customer portal, or 404 if the user never subscribed */
billingRouter.post("/portal", requireUser, async (_req, res) => {
  const url = await createPortalUrl(userIdOf(res));
  if (!url) {
    res.status(404).json({ error: "No subscription to manage yet." });
    return;
  }
  res.json({ url });
});

/** POST /billing/webhook — Stripe events. Signature-checked; 400 on a bad signature. */
billingRouter.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const signature = req.headers["stripe-signature"];
  if (typeof signature !== "string" || !Buffer.isBuffer(req.body)) {
    res.status(400).json({ error: "Missing Stripe signature." });
    return;
  }
  let event;
  try {
    event = parseWebhook(req.body, signature);
  } catch {
    res.status(400).json({ error: "Invalid Stripe signature." });
    return;
  }
  // A 500 here makes Stripe retry the event later.
  await handleWebhook(event);
  res.json({ received: true });
});
