import type { NextFunction, Request, Response } from "express";
import { db } from "./db.js";

// The frontend forwards the signed-in user's Supabase access token as `Authorization: Bearer <jwt>`.
// getClaims() verifies it (locally with the project's signing keys, or with the Auth server for
// older projects) and gives us the user id. Admins have app_metadata.role = "admin", which only the
// service-role key can set (npm run set-admin); it reaches the token on the user's next sign-in or
// token refresh.

async function verify(req: Request): Promise<{ userId: string; isAdmin: boolean } | null> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const { data, error } = await db().auth.getClaims(header.slice("Bearer ".length));
  if (error || !data) return null;
  const sub: unknown = data.claims.sub;
  if (typeof sub !== "string" || !sub) return null;
  const appMetadata: unknown = data.claims.app_metadata;
  const role = typeof appMetadata === "object" && appMetadata !== null ? (appMetadata as Record<string, unknown>).role : null;
  return { userId: sub, isAdmin: role === "admin" };
}

/** Sets the user for requireUser routes; responds 401 without a valid token. */
export async function requireUser(req: Request, res: Response, next: NextFunction) {
  const user = await verify(req);
  if (!user) {
    res.status(401).json({ error: "Sign in to continue." });
    return;
  }
  res.locals.userId = user.userId;
  res.locals.isAdmin = user.isAdmin;
  next();
}

/** Sets the user when a valid token is sent; anonymous requests pass through. */
export async function optionalUser(req: Request, res: Response, next: NextFunction) {
  const user = await verify(req);
  res.locals.userId = user?.userId ?? null;
  res.locals.isAdmin = user?.isAdmin ?? false;
  next();
}

/** Whether the signed-in user is an admin (unlimited remixes, can see and moderate any asset). */
export function isAdminOf(res: Response): boolean {
  return res.locals.isAdmin === true;
}

/** The signed-in user's id. Only call this behind requireUser. */
export function userIdOf(res: Response): string {
  const userId: unknown = res.locals.userId;
  if (typeof userId !== "string") throw new Error("userIdOf() called without requireUser");
  return userId;
}

/** The signed-in user's id, or null for anonymous requests behind optionalUser. */
export function viewerIdOf(res: Response): string | null {
  const userId: unknown = res.locals.userId;
  return typeof userId === "string" ? userId : null;
}
