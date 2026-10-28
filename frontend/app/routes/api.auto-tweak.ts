import { data } from "react-router";
import type { Route } from "./+types/api.auto-tweak";
import { autoTweakRemix } from "~/lib/api.server";
import { getSession } from "~/lib/auth.server";
import type { AutoTweakInput } from "~/lib/types";

// Auto-tweak for the remix page. The page renders and measures both rigs in the browser, then
// posts { assetId, animation, images, parts } as a JSON string (text/plain) via useFetcher.
// The backend validates the snapshot fields; this checks only what it needs to route the call.
export async function action({ request, context }: Route.ActionArgs) {
  const session = getSession(context);
  if (!session) return data({ ok: false as const, error: "Sign in to auto-tweak." }, { status: 401 });
  let body: unknown = null;
  try {
    body = JSON.parse(await request.text());
  } catch {
    // Falls through to the field checks below.
  }
  const { assetId, animation, images, parts } = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};

  if (typeof assetId !== "string" || !assetId) {
    return data({ ok: false as const, error: "Missing assetId." }, { status: 400 });
  }
  if (typeof animation !== "string" || !Array.isArray(images) || !Array.isArray(parts)) {
    return data({ ok: false as const, error: "Missing snapshots." }, { status: 400 });
  }

  // Shape-checked by the backend, which rejects anything malformed with a 400.
  const input = { animation, images, parts } as AutoTweakInput;
  return autoTweakRemix(session, assetId, input);
}
