import { data } from "react-router";
import type { Route } from "./+types/api.remix-animation";
import { animateRemix } from "~/lib/api.server";
import { getSession } from "~/lib/auth.server";
import type { AnimateEdit, AnimateInput } from "~/lib/types";

// Generated animations for the remix page. The page posts { assetId, prompt, durationSec, loop,
// skeleton?, images?, edit? } as a JSON string (text/plain) via useFetcher; `skeleton` only for binary
// .skel rigs, `images` the rig sheet from lib/spine-rig-sheet, `edit` ({ name, keepOriginal }) to
// rework an existing generated animation instead of adding one.
// The backend validates the fields; this checks only what it needs to route the call.
export async function action({ request, context }: Route.ActionArgs) {
  const session = getSession(context);
  if (!session) return data({ ok: false as const, error: "Sign in to animate." }, { status: 401 });
  let body: unknown = null;
  try {
    body = JSON.parse(await request.text());
  } catch {
    // Falls through to the field checks below.
  }
  const { assetId, prompt, durationSec, loop, skeleton, images, edit } = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};

  if (typeof assetId !== "string" || !assetId) {
    return data({ ok: false as const, error: "Missing assetId." }, { status: 400 });
  }
  if (typeof prompt !== "string" || typeof durationSec !== "number" || typeof loop !== "boolean") {
    return data({ ok: false as const, error: "Describe the animation." }, { status: 400 });
  }
  if (skeleton !== undefined && (typeof skeleton !== "object" || skeleton === null || Array.isArray(skeleton))) {
    return data({ ok: false as const, error: "Invalid skeleton." }, { status: 400 });
  }

  if (images !== undefined && (!Array.isArray(images) || !images.every((i) => typeof i === "string"))) {
    return data({ ok: false as const, error: "Invalid rig pictures." }, { status: 400 });
  }
  const { name, keepOriginal } = typeof edit === "object" && edit !== null ? (edit as Record<string, unknown>) : {};
  if (edit !== undefined && (typeof name !== "string" || !name || typeof keepOriginal !== "boolean")) {
    return data({ ok: false as const, error: "Invalid animation to edit." }, { status: 400 });
  }
  const animateEdit: AnimateEdit | null = typeof name === "string" && typeof keepOriginal === "boolean" ? { name, keepOriginal } : null;
  const input: AnimateInput = { prompt, durationSec, loop, ...(skeleton ? { skeleton } : {}), ...(images ? { images: images as string[] } : {}) };
  const result = await animateRemix(session, assetId, input, animateEdit);
  return result.ok ? result : data(result, { status: 400 });
}
