import { data } from "react-router";
import type { Route } from "./+types/api.library";
import { removeFromLibrary, saveToLibrary } from "~/lib/api.server";
import { getCurrentUser } from "~/lib/auth.server";

// Save / unsave an asset. Posted to by <SaveButton> via useFetcher from any page.
export async function action({ request }: Route.ActionArgs) {
  const user = await getCurrentUser(request);
  const form = await request.formData();
  const intent = form.get("intent");
  const assetId = form.get("assetId");

  if (typeof assetId !== "string" || !assetId) {
    return data({ ok: false, error: "Missing assetId" }, { status: 400 });
  }

  switch (intent) {
    case "save":
      await saveToLibrary(user.id, assetId);
      return { ok: true, saved: true };
    case "remove":
      await removeFromLibrary(user.id, assetId);
      return { ok: true, saved: false };
    default:
      return data({ ok: false, error: "Unknown intent" }, { status: 400 });
  }
}
