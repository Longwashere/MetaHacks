import { data } from "react-router";
import type { Route } from "./+types/api.remix-job";
import { getRemixJob } from "~/lib/api.server";
import { getSession } from "~/lib/auth.server";

// A running remix job, polled by the remix page through useFetcher (?id=<jobId>). Polling this
// instead of revalidating the page skips the page loader's other calls every second.
export async function loader({ request, context }: Route.LoaderArgs) {
  const session = getSession(context);
  if (!session) return data({ job: null }, { status: 401 });
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return data({ job: null }, { status: 400 });
  return { job: await getRemixJob(session, id) };
}
