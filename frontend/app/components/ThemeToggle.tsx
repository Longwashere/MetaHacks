import { Moon, Sun } from "lucide-react";
import { useFetcher, useRouteLoaderData } from "react-router";
import { Button } from "~/components/ui/button";
import type { loader as rootLoader } from "~/root";

export function ThemeToggle() {
  // Shares its key with the optimistic read in root.tsx's Layout.
  const fetcher = useFetcher({ key: "theme" });
  const rootData = useRouteLoaderData<typeof rootLoader>("root");
  const pending = fetcher.formData?.get("theme");
  const current = pending === "light" || pending === "dark" ? pending : (rootData?.theme ?? "dark");
  const next = current === "dark" ? "light" : "dark";

  return (
    <fetcher.Form method="post" action="/api/theme">
      <Button type="submit" name="theme" value={next} variant="ghost" size="icon" aria-label={`Switch to ${next} mode`}>
        {current === "dark" ? <Sun /> : <Moon />}
      </Button>
    </fetcher.Form>
  );
}
