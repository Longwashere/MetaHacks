import { data } from "react-router";
import type { Route } from "./+types/api.remix-visibility";
import { setRemixVisibility } from "~/lib/api.server";
import { getSession } from "~/lib/auth.server";

// Publish / unpublish one of the user's remixes. Posted to by <VisibilityToggle> via useFetcher.
export async function action({ request, context }: Route.ActionArgs) {
  const session = getSession(context);
  if (!session) return data({ ok: false, error: "Sign in to change your remixes." }, { status: 401 });
  const form = await request.formData();
  const assetId = form.get("assetId");
  const visibility = form.get("visibility");

  if (typeof assetId !== "string" || !assetId) {
    return data({ ok: false, error: "Missing assetId" }, { status: 400 });
  }
  if (visibility !== "public" && visibility !== "private") {
    return data({ ok: false, error: "Visibility must be public or private" }, { status: 400 });
  }

  const asset = await setRemixVisibility(session, assetId, visibility);
  if (!asset) return data({ ok: false, error: "You can only change your own remixes." }, { status: 403 });
  return { ok: true, visibility: asset.visibility };
}
