import express, { type NextFunction, type Request, type Response } from "express";
import { PORT, REMIX_OUTPUT_DIR, STRIPE, SUPABASE } from "./lib/config.js";
import { markStaleJobsFailed } from "./lib/remix-jobs.js";
import { STORAGE_BACKEND } from "./lib/storage.js";
import { assetsRouter } from "./routes/assets.js";
import { billingRouter } from "./routes/billing.js";
import { meRouter } from "./routes/me.js";

const app = express();

// Mounted before the global JSON parser: billing needs the raw body for Stripe's webhook, and
// /me has its own, larger body limit for skeleton files.
app.use("/billing", billingRouter);
app.use("/me", meRouter);

app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/assets", assetsRouter);

// Generated atlases and textures stored locally (when R2 isn't configured). The Spine viewer
// loads them with WebGL from the frontend's origin, which needs CORS.
app.use(
  "/files/remixes",
  (_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    next();
  },
  express.static(REMIX_OUTPUT_DIR, { immutable: true, maxAge: "1y", fallthrough: false }),
);

app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) return next(error);
  console.error(error);
  const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : 500;
  res.status(status).json({ error: status < 500 && error instanceof Error ? error.message : "Something went wrong." });
});

app.listen(PORT, () => {
  console.log(`Backend listening on http://localhost:${PORT} (storage: ${STORAGE_BACKEND})`);
  if (!SUPABASE) console.warn("Supabase isn't configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. Asset and account routes will fail.");
  if (!STRIPE) console.warn("Stripe isn't configured: billing routes return 503.");
});

if (SUPABASE) {
  markStaleJobsFailed().catch((error: unknown) => console.error("Couldn't clean up stale remix jobs", error));
}
