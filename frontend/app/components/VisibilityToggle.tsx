import { Globe, Lock } from "lucide-react";
import { useEffect } from "react";
import { useFetcher } from "react-router";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import type { SpineAsset } from "~/lib/types";

interface VisibilityToggleProps {
  assetId: string;
  assetName: string;
  visibility: SpineAsset["visibility"];
  size?: "sm" | "default";
  className?: string;
}

/** Publish or unpublish one of the user's own remixes. Public remixes appear in Explore and search. */
export function VisibilityToggle({ assetId, assetName, visibility, size = "default", className }: VisibilityToggleProps) {
  const fetcher = useFetcher<{ ok: true; visibility: SpineAsset["visibility"] } | { ok: false; error: string }>();
  // Optimistic: show the requested visibility while the action runs.
  const pending = fetcher.formData?.get("visibility");
  const current = pending === "public" || pending === "private" ? pending : visibility;
  const next = current === "public" ? "private" : "public";

  // Toast the outcome: publishing can be refused (an upload reusing someone else's art stays private).
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.ok) toast(fetcher.data.visibility === "public" ? `“${assetName}” is now public` : `“${assetName}” is now private`);
    else toast.error(fetcher.data.error);
  }, [fetcher.state, fetcher.data, assetName]);

  return (
    <fetcher.Form method="post" action="/api/remix-visibility" className={className}>
      <input type="hidden" name="assetId" value={assetId} />
      <Button
        type="submit"
        name="visibility"
        value={next}
        variant="outline"
        size={size}
        title={current === "public" ? "Anyone can find this remix. Click to make it private." : "Only you can see this remix. Click to publish it."}
      >
        {current === "public" ? <Globe /> : <Lock />}
        {current === "public" ? "Public" : "Private"}
      </Button>
    </fetcher.Form>
  );
}
