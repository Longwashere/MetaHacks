import { Loader2, Trash2 } from "lucide-react";
import { useState } from "react";
import { useFetcher } from "react-router";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";

interface DeleteAssetButtonProps {
  assetId: string;
  assetName: string;
  /** Where to go once it's deleted, when the current page shows this asset. Omit to stay (e.g. in a list). */
  redirectTo?: string;
  size?: "sm" | "default";
  className?: string;
}

/** Delete one of the user's own remixes (admins: any asset), after a confirmation. */
export function DeleteAssetButton({ assetId, assetName, redirectTo, size = "default", className }: DeleteAssetButtonProps) {
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const [open, setOpen] = useState(false);
  const deleting = fetcher.state !== "idle";
  const error = fetcher.state === "idle" && fetcher.data?.ok === false ? fetcher.data.error : undefined;

  return (
    <AlertDialog open={open} onOpenChange={(next) => !deleting && setOpen(next)}>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size={size} className={className}>
          <Trash2 /> Delete
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{assetName}”?</AlertDialogTitle>
          <AlertDialogDescription>
            It will be removed from Explore and from everyone's library. This can't be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <fetcher.Form method="post" action="/api/asset-delete">
          <input type="hidden" name="assetId" value={assetId} />
          {redirectTo && <input type="hidden" name="redirectTo" value={redirectTo} />}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <Button type="submit" variant="destructive" disabled={deleting}>
              {deleting ? <Loader2 className="animate-spin" /> : <Trash2 />} Delete
            </Button>
          </AlertDialogFooter>
        </fetcher.Form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
