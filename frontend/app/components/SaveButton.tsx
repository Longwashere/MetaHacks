import { Bookmark, BookmarkCheck } from "lucide-react";
import { Link, useFetcher, useLocation, useRouteLoaderData } from "react-router";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import type { loader as rootLoader } from "~/root";

interface SaveButtonProps {
  assetId: string;
  assetName: string;
  saved: boolean;
  /** "icon" for cards, "full" for detail pages. */
  size?: "icon" | "full";
  className?: string;
}

export function SaveButton({ assetId, assetName, saved, size = "full", className }: SaveButtonProps) {
  const fetcher = useFetcher();
  const signedIn = Boolean(useRouteLoaderData<typeof rootLoader>("root")?.user);
  const location = useLocation();
  // Optimistic: reflect the in-flight intent until the action + revalidation finish.
  const pendingIntent = fetcher.formData?.get("intent");
  const isSaved = pendingIntent ? pendingIntent === "save" : saved;
  const label = isSaved ? `Remove ${assetName} from library` : `Save ${assetName} to library`;

  if (!signedIn) {
    return (
      <Button
        asChild
        variant={size === "icon" ? "secondary" : "default"}
        size={size === "icon" ? "icon" : "default"}
        className={className}
      >
        <Link
          to={`/login?${new URLSearchParams({ next: location.pathname + location.search })}`}
          aria-label={size === "icon" ? `Sign in to save ${assetName}` : undefined}
          rel="nofollow"
        >
          <Bookmark />
          {size === "full" && "Save to library"}
        </Link>
      </Button>
    );
  }

  return (
    <fetcher.Form
      method="post"
      action="/api/library"
      className={className}
      onSubmit={() => toast(isSaved ? `Removed “${assetName}” from your library` : `Saved “${assetName}” to your library`)}
    >
      <input type="hidden" name="assetId" value={assetId} />
      <Button
        type="submit"
        name="intent"
        value={isSaved ? "remove" : "save"}
        variant={isSaved ? "secondary" : size === "icon" ? "secondary" : "default"}
        size={size === "icon" ? "icon" : "default"}
        aria-label={size === "icon" ? label : undefined}
        aria-pressed={isSaved}
      >
        {isSaved ? (
          <BookmarkCheck className={cn(size === "icon" && "text-primary")} />
        ) : (
          <Bookmark />
        )}
        {size === "full" && (isSaved ? "Saved" : "Save to library")}
      </Button>
    </fetcher.Form>
  );
}
