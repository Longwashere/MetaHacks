import { Bone, Film } from "lucide-react";
import { Link } from "react-router";
import { SpinePreview } from "~/components/SpinePreview";
import { Badge } from "~/components/ui/badge";
import { assetOrigin } from "~/lib/format";
import type { SpineAsset } from "~/lib/types";
import { cn } from "~/lib/utils";

interface RigPickerProps {
  rigs: SpineAsset[];
  /** Builds the link that selects a rig (keeps the choice in the URL). */
  selectHref: (rig: SpineAsset) => string;
  className?: string;
}

/** Grid of selectable rigs for the remix flow. */
export function RigPicker({ rigs, selectHref, className }: RigPickerProps) {
  return (
    <ul className={cn("grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5", className)}>
      {rigs.map((rig) => (
        <li key={rig.id}>
          <Link
            to={selectHref(rig)}
            preventScrollReset
            className="group flex flex-col overflow-hidden rounded-lg border bg-card transition-colors outline-none hover:border-primary focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <SpinePreview asset={rig} origin={assetOrigin(rig)} className="border-b" />
            <div className="flex flex-col gap-1 p-3">
              <span className="truncate text-sm font-medium group-hover:text-primary">{rig.name}</span>
              <span className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Bone className="size-3" /> {rig.boneCount}
                </span>
                <span className="flex items-center gap-1">
                  <Film className="size-3" /> {rig.animations.length}
                </span>
                {rig.remixOf && (
                  <Badge variant="outline" className="ml-auto px-1.5 py-0 text-[10px]">
                    remix
                  </Badge>
                )}
              </span>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
