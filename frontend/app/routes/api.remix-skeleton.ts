import { data } from "react-router";
import type { Route } from "./+types/api.remix-skeleton";
import { saveRemixSkeleton } from "~/lib/api.server";
import { getCurrentUser } from "~/lib/auth.server";

// Saves a remix's skeleton with the tweak panel's edits baked in. The remix page posts
// { assetId, skeleton, skin } as a JSON string (text/plain) via useFetcher.
export async function action({ request }: Route.ActionArgs) {
  const user = await getCurrentUser(request);
  let body: unknown = null;
  try {
    body = JSON.parse(await request.text());
  } catch {
    // Falls through to the field checks below.
  }
  const { assetId, skeleton, skin } = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};

  if (typeof assetId !== "string" || !assetId) {
    return data({ ok: false as const, error: "Missing assetId." }, { status: 400 });
  }
  if (typeof skeleton !== "object" || skeleton === null || Array.isArray(skeleton)) {
    return data({ ok: false as const, error: "Missing skeleton." }, { status: 400 });
  }
  if (skin !== null && (typeof skin !== "string" || skin.length > 200)) {
    return data({ ok: false as const, error: "Invalid skin." }, { status: 400 });
  }

  const asset = await saveRemixSkeleton(user.id, assetId, skeleton, skin);
  if (!asset) return data({ ok: false as const, error: "You can only save edits to your own remixes." }, { status: 403 });
  return { ok: true as const, assetId: asset.id };
}
