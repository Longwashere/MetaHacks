import { data, redirect } from "react-router";
import type { Route } from "./+types/asset-download";
import { buildPlaceholderSkeleton, getAsset } from "~/lib/api.server";
import { getSession } from "~/lib/auth.server";

// Downloads the skeleton file: a redirect to the stored file, or a placeholder for assets without one.
export async function loader({ params, context }: Route.LoaderArgs) {
  const asset = await getAsset(params.assetId, getSession(context));
  if (!asset) throw data("Asset not found", { status: 404 });
  if (asset.files) throw redirect(asset.files.skeletonUrl);

  return new Response(JSON.stringify(buildPlaceholderSkeleton(asset), null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="${params.assetId}.json"`,
    },
  });
}
