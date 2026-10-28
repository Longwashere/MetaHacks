import { redirect } from "react-router";
import type { Route } from "./+types/logout";
import { getSupabase } from "~/lib/auth.server";

// Sign out: POST only, so a link or prefetch can't sign someone out. Clears the session cookies
// (written by the auth middleware).
export async function action({ context }: Route.ActionArgs) {
  await getSupabase(context).auth.signOut();
  throw redirect("/");
}

export async function loader() {
  throw redirect("/");
}
