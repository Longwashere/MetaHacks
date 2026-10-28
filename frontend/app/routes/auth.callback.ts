import { redirect } from "react-router";
import type { Route } from "./+types/auth.callback";
import { getSupabase, safeNext } from "~/lib/auth.server";

// Google sends the user back here (via Supabase) with a one-time code. Exchanging it sets the
// session cookies, which the auth middleware writes onto the redirect.
export async function loader({ request, context }: Route.LoaderArgs) {
  const params = new URL(request.url).searchParams;
  const next = safeNext(params.get("next"));
  const code = params.get("code");
  const failed = (message: string) => redirect(`/login?${new URLSearchParams({ next, error: message })}`);

  if (!code) throw failed(params.get("error_description") ?? "Google didn't return a sign-in code. Try again.");
  const { error } = await getSupabase(context).auth.exchangeCodeForSession(code);
  if (error) throw failed(error.message);
  throw redirect(next);
}
