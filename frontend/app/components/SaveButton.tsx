import { Bookmark, BookmarkCheck } from "lucide-react";
import { useFetcher } from "react-router";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

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
  // Optimistic: reflect the in-flight intent until the action + revalidation finish.
  const pendingIntent = fetcher.formData?.get("intent");
  const isSaved = pendingIntent ? pendingIntent === "save" : saved;
  const label = isSaved ? `Remove ${assetName} from library` : `Save ${assetName} to library`;

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
