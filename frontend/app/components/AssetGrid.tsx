import { AssetCard } from "~/components/AssetCard";
import type { SpineAsset } from "~/lib/types";
import { cn } from "~/lib/utils";

interface AssetGridProps {
  assets: SpineAsset[];
  savedIds: string[];
  className?: string;
}

export function AssetGrid({ assets, savedIds, className }: AssetGridProps) {
  return (
    <div className={cn("grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4", className)}>
      {assets.map((asset) => (
        <AssetCard key={asset.id} asset={asset} saved={savedIds.includes(asset.id)} />
      ))}
    </div>
  );
}
