import { AssetCard } from "~/components/AssetCard";
import type { SpineAsset } from "~/lib/types";
import { cn } from "~/lib/utils";

interface AssetGridProps {
  assets: SpineAsset[];
  savedIds: string[];
  /** Show each card's public/private toggle (for the user's own remixes). */
  manage?: boolean;
  className?: string;
}

export function AssetGrid({ assets, savedIds, manage = false, className }: AssetGridProps) {
  return (
    <div className={cn("grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4", className)}>
      {assets.map((asset) => (
        <AssetCard key={asset.id} asset={asset} saved={savedIds.includes(asset.id)} manage={manage} />
      ))}
    </div>
  );
}
