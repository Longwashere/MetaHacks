import { Bookmark, Film } from "lucide-react";
import { Link } from "react-router";
import { DeleteAssetButton } from "~/components/DeleteAssetButton";
import { SaveButton } from "~/components/SaveButton";
import { SpinePreview } from "~/components/SpinePreview";
import { VisibilityToggle } from "~/components/VisibilityToggle";
import { Badge } from "~/components/ui/badge";
import { Card, CardContent } from "~/components/ui/card";
import type { SpineAsset } from "~/lib/types";
import { formatCount } from "~/lib/format";
import { animationLabel, assetPath } from "~/lib/seo";
import { cn } from "~/lib/utils";

interface AssetCardProps {
  asset: SpineAsset;
  saved: boolean;
  /** Show the public/private toggle and Delete (for the user's own remixes). */
  manage?: boolean;
  className?: string;
}

export function AssetCard({ asset, saved, manage = false, className }: AssetCardProps) {
  return (
    <Card className={cn("group relative gap-0 overflow-hidden py-0 transition-shadow hover:shadow-md", className)}>
      <Link
        to={assetPath(asset)}
        className="block outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <SpinePreview asset={asset} className="border-b" />
        <span className="sr-only">View {asset.name}</span>
      </Link>
      <SaveButton
        assetId={asset.id}
        assetName={asset.name}
        saved={saved}
        size="icon"
        className="absolute top-2 right-2"
      />
      <CardContent className="flex flex-col gap-2 p-4">
        <div className="flex items-start justify-between gap-2">
          <h3 className="truncate font-medium">{asset.name}</h3>
          <Badge variant="outline" className="shrink-0 capitalize">
            {asset.category}
          </Badge>
        </div>
        <p className="line-clamp-2 text-sm text-muted-foreground">{asset.description}</p>
        <p className="truncate text-xs text-muted-foreground">
          {asset.animations.map((a) => animationLabel(a.name)).join(" · ")}
        </p>
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Film className="size-3.5" />
            {asset.animations.length} {asset.animations.length === 1 ? "anim" : "anims"}
          </span>
          <span className="flex items-center gap-1">
            <Bookmark className="size-3.5" />
            {formatCount(asset.saves)}
          </span>
          <span className="ml-auto truncate">by {asset.author.name}</span>
        </div>
        {manage && (
          <div className="flex flex-wrap gap-2">
            <VisibilityToggle assetId={asset.id} assetName={asset.name} visibility={asset.visibility} size="sm" />
            <DeleteAssetButton assetId={asset.id} assetName={asset.name} size="sm" />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
