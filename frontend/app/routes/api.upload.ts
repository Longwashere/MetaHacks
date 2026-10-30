import { data } from "react-router";
import type { Route } from "./+types/api.upload";
import { uploadRigs } from "~/lib/api.server";
import { getSession } from "~/lib/auth.server";

// Uploads a batch of rigs. The upload page posts { category, visibility, rigs } as JSON
// and splits big selections into several requests; the backend validates every rig.
export async function action({ request, context }: Route.ActionArgs) {
  const session = getSession(context);
  if (!session) return data({ ok: false as const, error: "Sign in to upload rigs.", rigErrors: {} }, { status: 401 });
  if (!request.body) return data({ ok: false as const, error: "Nothing to upload.", rigErrors: {} }, { status: 400 });
  const result = await uploadRigs(session, request.body);
  return data(result, { status: result.ok ? 201 : 400 });
}
