import { data, redirect } from "react-router";
import type { Route } from "./+types/asset-download";
import { getAsset, getSkeletonExport } from "~/lib/api.server";

// Downloads the skeleton file. BACKEND: proxy the real file or redirect to a signed URL.
export async function loader({ params }: Route.LoaderArgs) {
  const asset = await getAsset(params.assetId);
  if (asset?.files) throw redirect(asset.files.skeletonUrl);

  const skeleton = await getSkeletonExport(params.assetId);
  if (!skeleton) throw data("Asset not found", { status: 404 });
  return new Response(JSON.stringify(skeleton, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="${params.assetId}.json"`,
    },
  });
}
