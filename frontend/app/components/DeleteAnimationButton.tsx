import { Loader2, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import { toast } from "sonner";
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

interface DeleteAnimationButtonProps {
  assetId: string;
  animation: string;
  /** Called once it's deleted, e.g. to stop playing it. */
  onDeleted: (name: string) => void;
}

/**
 * Deletes a generated animation from a remix after a confirmation, through the remix page's
 * `delete-animation` action. The page's loader revalidates with the remix's new animation list.
 */
export function DeleteAnimationButton({ assetId, animation, onDeleted }: DeleteAnimationButtonProps) {
  const fetcher = useFetcher<{ ok: true; deleted: string } | { ok: false; error: string }>();
  const [open, setOpen] = useState(false);
  const deleting = fetcher.state !== "idle";
  const error = fetcher.state === "idle" && fetcher.data?.ok === false ? fetcher.data.error : undefined;

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data?.ok) return;
    setOpen(false);
    onDeleted(fetcher.data.deleted);
    toast.success(`Deleted "${fetcher.data.deleted}".`);
    // Runs once per finished request; `onDeleted` changes identity every render, so it's left out.
  }, [fetcher.state, fetcher.data]);

  return (
    <AlertDialog open={open} onOpenChange={(next) => !deleting && setOpen(next)}>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="icon" className="size-7">
          <Trash2 />
          <span className="sr-only">Delete {animation}</span>
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{animation}”?</AlertDialogTitle>
          <AlertDialogDescription>It's removed from the remix's skeleton, the player and the download. This can't be undone.</AlertDialogDescription>
        </AlertDialogHeader>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="delete-animation" />
          <input type="hidden" name="assetId" value={assetId} />
          <input type="hidden" name="animation" value={animation} />
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
