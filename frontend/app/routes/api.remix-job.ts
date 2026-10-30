import { data } from "react-router";
import type { Route } from "./+types/api.remix-job";
import { getRemixJob } from "~/lib/api.server";
import { getSession } from "~/lib/auth.server";

// A running remix job, polled by the remix page through useFetcher (?id=<jobId>&events=<n>). Polling
// this instead of revalidating the page skips the page loader's other calls every second; `events`
// is how many log events the page has, so only newer ones are sent.
export async function loader({ request, context }: Route.LoaderArgs) {
  const session = getSession(context);
  if (!session) return data({ job: null }, { status: 401 });
  const params = new URL(request.url).searchParams;
  const id = params.get("id");
  if (!id) return data({ job: null }, { status: 400 });
  const events = Number(params.get("events") ?? 0);
  return { job: await getRemixJob(session, id, Number.isSafeInteger(events) && events > 0 ? events : 0) };
}
