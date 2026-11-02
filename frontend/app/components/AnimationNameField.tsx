import { Check, Loader2, Type, X } from "lucide-react";
import { useState } from "react";
import { useFetcher } from "react-router";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";

/** What the remix page's `rename-animation` action returns. */
export type RenameAnimationResult = { ok: true; from: string; to: string } | { ok: false; error: string };

/** The fetcher key renames go through, so the panel sees the result after the renamed row remounts under its new name. */
export const renameFetcherKey = (assetId: string) => `rename-animation:${assetId}`;

interface AnimationNameFieldProps {
  assetId: string;
  animation: string;
  /** Its place in the remix's `animations`, which a rename keeps. */
  index: number;
  disabled?: boolean;
}

/**
 * A generated animation's name in the Animate tab's list, with a button that turns it into a field
 * to rename it through the remix page's `rename-animation` action. AnimatePanel handles the result.
 */
export function AnimationNameField({ assetId, animation, index, disabled }: AnimationNameFieldProps) {
  const fetcher = useFetcher<RenameAnimationResult>({ key: renameFetcherKey(assetId) });
  const [editing, setEditing] = useState(false);
  const saving = fetcher.state !== "idle";

  if (!editing) {
    return (
      <span className="flex min-w-0 items-center gap-1">
        <span className="truncate">{animation}</span>
        <Button variant="ghost" size="icon" className="size-7 shrink-0" disabled={disabled} onClick={() => setEditing(true)}>
          <Type />
          <span className="sr-only">Rename {animation}</span>
        </Button>
      </span>
    );
  }

  return (
    <fetcher.Form
      method="post"
      className="flex min-w-0 flex-1 items-center gap-1"
      onSubmit={(e) => {
        // Nothing to save; a real rename remounts the row under its new name, which closes the field.
        if (String(new FormData(e.currentTarget).get("name") ?? "").trim() !== animation) return;
        e.preventDefault();
        setEditing(false);
      }}
    >
      <input type="hidden" name="intent" value="rename-animation" />
      <input type="hidden" name="assetId" value={assetId} />
      <input type="hidden" name="animation" value={animation} />
      <input type="hidden" name="index" value={index} />
      <Input
        name="name"
        aria-label={`New name for ${animation}`}
        defaultValue={animation}
        maxLength={40}
        autoFocus
        required
        className="h-7 min-w-0 flex-1"
        onKeyDown={(e) => e.key === "Escape" && setEditing(false)}
      />
      <Button type="submit" variant="ghost" size="icon" className="size-7 shrink-0" disabled={saving}>
        {saving ? <Loader2 className="animate-spin" /> : <Check />}
        <span className="sr-only">Save name</span>
      </Button>
      <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0" disabled={saving} onClick={() => setEditing(false)}>
        <X />
        <span className="sr-only">Cancel renaming</span>
      </Button>
    </fetcher.Form>
  );
}
