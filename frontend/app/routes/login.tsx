import { AlertCircle, Bone } from "lucide-react";
import { Form, data, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/login";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Separator } from "~/components/ui/separator";
import { SITE_NAME } from "~/lib/seo";
import { authEnabled, getSession, getSupabase, safeNext } from "~/lib/auth.server";
import { getSiteUrl } from "~/lib/site.server";

export function meta({}: Route.MetaArgs) {
  return [{ title: `Sign in · ${SITE_NAME}` }, { name: "robots", content: "noindex, nofollow" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const params = new URL(request.url).searchParams;
  const next = safeNext(params.get("next"));
  if (getSession(context)) throw redirect(next);
  return { next, error: params.get("error"), authEnabled };
}

/**
 * Usernames (no "@") sign in as <username>@rigforge.test. The .test domain can never receive mail,
 * so nobody can take one of these accounts over with a password-reset email.
 */
const USERNAME_DOMAIN = "rigforge.test";
export async function action({ request, context }: Route.ActionArgs) {
  const form = await request.formData();
  const next = safeNext(String(form.get("next") ?? ""));

  // Username/email + password: for accounts made with `npm run create-judge -w backend` (hackathon judges).
  if (form.get("intent") === "password") {
    const login = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    if (!login || !password || login.length > 320 || password.length > 200) {
      return data({ error: "Enter your username and password.", email: login }, { status: 400 });
    }
    const email = login.includes("@") ? login : `${login.toLowerCase()}@${USERNAME_DOMAIN}`;
    const { error } = await getSupabase(context).auth.signInWithPassword({ email, password });
    // Same message for a wrong username or password, so the form doesn't reveal which accounts exist.
    if (error) return data({ error: "That username and password don't match.", email: login }, { status: 400 });
    throw redirect(next);
  }

  const callback = new URL("/auth/callback", getSiteUrl(request));
  callback.searchParams.set("next", next);

  // Stores the PKCE verifier in a cookie (written by the auth middleware) and returns Google's URL.
  const { data: oauth, error } = await getSupabase(context).auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: callback.toString() },
  });
  if (error || !oauth.url) return data({ error: error?.message ?? "Couldn't start Google sign-in.", email: "" }, { status: 500 });
  throw redirect(oauth.url);
}

export default function Login({ loaderData, actionData }: Route.ComponentProps) {
  const { next, authEnabled } = loaderData;
  const error = actionData?.error ?? loaderData.error;
  const navigation = useNavigation();
  const pendingIntent = navigation.state !== "idle" && navigation.formMethod === "POST" ? navigation.formData?.get("intent") : null;

  return (
    <div className="mx-auto flex max-w-sm flex-col gap-6 py-12">
      <Card>
        <CardHeader className="items-center text-center">
          <span className="mx-auto flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Bone className="size-5" />
          </span>
          <CardTitle className="text-xl">Sign in to {SITE_NAME}</CardTitle>
          <CardDescription>Save rigs to your library, remix them, and publish your remixes.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {error && (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertTitle>Sign-in failed</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {authEnabled ? (
            <>
              <Form method="post">
                <input type="hidden" name="next" value={next} />
                <Button type="submit" name="intent" value="google" size="lg" variant="outline" className="w-full" disabled={pendingIntent != null}>
                  <GoogleIcon />
                  {pendingIntent === "google" ? "Redirecting…" : "Continue with Google"}
                </Button>
              </Form>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <Separator className="flex-1" />
                Hackathon judges
                <Separator className="flex-1" />
              </div>
              <p className="text-center text-sm text-muted-foreground">
                Judges: the test username and password are at the top of the GitHub repo's README.
              </p>
              <Form method="post" className="flex flex-col gap-3">
                <input type="hidden" name="next" value={next} />
                <div className="flex flex-col gap-2">
                  <Label htmlFor="email">Username</Label>
                  <Input id="email" name="email" autoComplete="username" autoCapitalize="none" spellCheck={false} defaultValue={actionData?.email ?? ""} required />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="password">Password</Label>
                  <Input id="password" name="password" type="password" autoComplete="current-password" required />
                </div>
                <Button type="submit" name="intent" value="password" className="w-full" disabled={pendingIntent != null}>
                  {pendingIntent === "password" ? "Signing in…" : "Sign in"}
                </Button>
              </Form>
            </>
          ) : (
            <p className="text-center text-sm text-muted-foreground">
              Sign-in isn't configured yet. Set SUPABASE_URL and SUPABASE_ANON_KEY for the frontend.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15A11 11 0 0 0 2.18 7.06L5.84 9.9C6.71 7.3 9.14 5.38 12 5.38z" />
    </svg>
  );
}
