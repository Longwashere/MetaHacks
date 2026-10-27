import { data } from "react-router";
import type { Route } from "./+types/api.theme";
import { serializeTheme } from "~/lib/theme.server";

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const theme = form.get("theme");
  if (theme !== "light" && theme !== "dark") {
    return data({ ok: false }, { status: 400 });
  }
  return data(
    { ok: true },
    { headers: { "Set-Cookie": await serializeTheme(theme) } },
  );
}
