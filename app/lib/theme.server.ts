import { createCookie } from "react-router";

export type Theme = "light" | "dark";

const themeCookie = createCookie("theme", {
  path: "/",
  sameSite: "lax",
  maxAge: 60 * 60 * 24 * 365,
});

export async function getTheme(request: Request): Promise<Theme> {
  const value: unknown = await themeCookie.parse(request.headers.get("Cookie"));
  return value === "light" ? "light" : "dark";
}

export function serializeTheme(theme: Theme) {
  return themeCookie.serialize(theme);
}
