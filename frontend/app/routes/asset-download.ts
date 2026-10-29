import { zipSync, type Zippable } from "fflate";
import { data, redirect } from "react-router";
import type { Route } from "./+types/asset-download";
import { buildPlaceholderSkeleton, getAsset, recordDownload } from "~/lib/api.server";
import { parseAtlas } from "~/lib/atlas";
import { getSession } from "~/lib/auth.server";

// Downloads the rig as a zip of its skeleton, atlas and page images, or a placeholder skeleton for assets without files.
// Real files need a signed-in user and count against the monthly download allowance (free plan only).
export async function loader({ params, context }: Route.LoaderArgs) {
  const session = getSession(context);
  const asset = await getAsset(params.assetId, session);
  if (!asset) throw data("Asset not found", { status: 404 });
  // Back to the asset page, not this route: a file response would leave the browser on the login page.
  // ?public=1 keeps owners on the public page instead of the remix workspace.
  const assetPage = `/assets/${encodeURIComponent(asset.id)}?public=1`;
  const baseName = fileSafe(asset.name) || asset.id;

  if (!asset.files) {
    return new Response(JSON.stringify(buildPlaceholderSkeleton(asset), null, 2), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="${baseName}.json"`,
      },
    });
  }

  if (!session) throw redirect(`/login?${new URLSearchParams({ next: assetPage })}`);

  const { skeletonUrl, atlasUrl, textureUrls } = asset.files;
  const [skeleton, atlas] = await Promise.all([fetchFile(skeletonUrl), fetchFile(atlasUrl)]);
  const atlasText = new TextDecoder().decode(atlas);

  // Page images keep the names the atlas gives them, so Spine finds them beside the .atlas.
  const pageNames = parseAtlas(atlasText).map((p) => p.name);
  const pages = pageNames.length
    ? pageNames.map((name) => ({ name, url: new URL(name, atlasUrl).href }))
    : textureUrls.map((url) => ({ name: fileName(url), url }));
  const images = await Promise.all(pages.map((p) => fetchFile(p.url)));

  const files: Zippable = {
    [fileName(skeletonUrl)]: skeleton,
    [fileName(atlasUrl)]: atlas,
  };
  // PNGs are already compressed; storing them skips wasted work.
  pages.forEach((p, i) => (files[p.name] = [images[i], { level: 0 }]));
  const zip = zipSync(files);

  // Counted only once the zip is built, so a failed fetch doesn't use up a download.
  const recorded = await recordDownload(session, asset.id);
  if (!recorded.ok) {
    if (recorded.limitReached) throw redirect(`${assetPage}&download=limit`);
    throw data("Asset not found", { status: 404 });
  }

  return new Response(zip, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${baseName}.zip"`,
    },
  });
}

async function fetchFile(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw data(`Couldn't fetch ${fileName(url)} (${res.status})`, { status: 502 });
  return new Uint8Array(await res.arrayBuffer());
}

function fileName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.split("/").pop() || "file");
}

function fileSafe(name: string): string {
  return name.trim().replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "");
}
