import { data, redirect } from "react-router";
import type { Route } from "./+types/api.asset-delete";
import { deleteAsset } from "~/lib/api.server";
import { getSession } from "~/lib/auth.server";

// Delete one of the user's remixes (admins: any asset). Posted to by <DeleteAssetButton> via useFetcher.
// `redirectTo` is set when the page showing the asset goes away with it (the asset page, the remix workspace).
export async function action({ request, context }: Route.ActionArgs) {
  const session = getSession(context);
  if (!session) return data({ ok: false, error: "Sign in to delete your remixes." }, { status: 401 });
  const form = await request.formData();
  const assetId = form.get("assetId");
  const redirectTo = form.get("redirectTo");

  if (typeof assetId !== "string" || !assetId) {
    return data({ ok: false, error: "Missing assetId" }, { status: 400 });
  }

  const result = await deleteAsset(session, assetId);
  if (!result.ok) return data({ ok: false, error: result.error }, { status: 400 });
  // Only same-site paths, so the form can't send the user elsewhere.
  if (typeof redirectTo === "string" && redirectTo.startsWith("/") && !redirectTo.startsWith("//")) {
    throw redirect(redirectTo);
  }
  return { ok: true };
}
