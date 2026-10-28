// Supabase Auth (Google sign-in). The root middleware reads the session cookies on every request,
// refreshes them when the access token has expired, and writes any cookie changes onto the response.
// Loaders and actions get the signed-in user from `context` with getSession / requireSession.
import { createServerClient, parseCookieHeader, serializeCookieHeader } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createContext, redirect, type MiddlewareFunction, type RouterContextProvider } from "react-router";

export interface CurrentUser {
  id: string;
  name: string;
  email: string | null;
  avatarUrl: string | null;
  /** app_metadata.role === "admin" (set by `npm run set-admin -w backend`). The backend enforces it; the UI only uses it to show controls. */
  isAdmin: boolean;
}

/** The signed-in user plus the access token the backend checks. Never return this from a loader. */
export interface Session {
  user: CurrentUser;
  accessToken: string;
}

const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/+$/, "");
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

export const authEnabled = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

const supabaseContext = createContext<SupabaseClient | null>(null);
const sessionContext = createContext<Session | null>(null);

export const authMiddleware: MiddlewareFunction<Response> = async ({ request, context }, next) => {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return next();

  const cookieHeaders = new Headers();
  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => parseCookieHeader(request.headers.get("Cookie") ?? "").map(({ name, value }) => ({ name, value: value ?? "" })),
      setAll: (cookies) => {
        for (const { name, value, options } of cookies) {
          cookieHeaders.append("Set-Cookie", serializeCookieHeader(name, value, options));
        }
      },
    },
  });
  context.set(supabaseContext, supabase);
  context.set(sessionContext, await readSession(supabase));

  const response = await next();
  for (const cookie of cookieHeaders.getSetCookie()) response.headers.append("Set-Cookie", cookie);
  return response;
};

async function readSession(supabase: SupabaseClient): Promise<Session | null> {
  // getClaims() verifies the JWT (refreshing it first if it has expired); getSession() alone
  // would trust whatever the cookie says.
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data) return null;
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) return null;

  const { claims } = data;
  const meta: Record<string, unknown> = claims.user_metadata ?? {};
  const appMeta: Record<string, unknown> = claims.app_metadata ?? {};
  const str = (value: unknown) => (typeof value === "string" && value ? value : null);
  const email = str(claims.email);
  return {
    user: {
      id: claims.sub,
      name: str(meta.full_name) ?? str(meta.name) ?? email?.split("@")[0] ?? "You",
      email,
      avatarUrl: str(meta.avatar_url) ?? str(meta.picture),
      isAdmin: appMeta.role === "admin",
    },
    accessToken,
  };
}

/** The signed-in user's session, or null for guests. */
export function getSession(context: Readonly<RouterContextProvider>): Session | null {
  return context.get(sessionContext);
}

/** The signed-in user's session; sends guests to /login and back here afterwards. */
export function requireSession(context: Readonly<RouterContextProvider>, request: Request): Session {
  const session = getSession(context);
  if (session) return session;
  const url = new URL(request.url);
  throw redirect(`/login?${new URLSearchParams({ next: url.pathname + url.search })}`);
}

/** The request's Supabase client, for the sign-in, callback and sign-out routes. */
export function getSupabase(context: Readonly<RouterContextProvider>): SupabaseClient {
  const supabase = context.get(supabaseContext);
  if (!supabase) throw new Response("Sign-in isn't configured: set SUPABASE_URL and SUPABASE_ANON_KEY.", { status: 503 });
  return supabase;
}

/** Only same-site paths, so ?next= can't send people to another website after sign-in. */
export function safeNext(value: string | null): string {
  return value && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\") ? value : "/";
}
