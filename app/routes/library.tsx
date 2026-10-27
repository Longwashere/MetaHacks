import { Bookmark, Compass, Sparkles, Wand2 } from "lucide-react";
import { Link, useSearchParams } from "react-router";
import type { Route } from "./+types/library";
import { AssetGrid } from "~/components/AssetGrid";
import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { getLibrary, getMyRemixes } from "~/lib/api.server";
import { getCurrentUser } from "~/lib/auth.server";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "My Library · RigForge" },
    { name: "description", content: "Your saved rigs and remixes." },
    // Per-user page: keep it out of search results (also disallowed in robots.txt).
    { name: "robots", content: "noindex, nofollow" },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  const user = await getCurrentUser(request);
  const tab = new URL(request.url).searchParams.get("tab") === "remixes" ? "remixes" : "saved";
  const [saved, remixes] = await Promise.all([
    getLibrary(user.id),
    getMyRemixes(user.id),
  ]);
  return { tab, saved, remixes, savedIds: saved.map((a) => a.id) };
}

export default function Library({ loaderData }: Route.ComponentProps) {
  const { tab, saved, remixes, savedIds } = loaderData;
  const [, setSearchParams] = useSearchParams();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-3xl font-bold tracking-tight">My Library</h1>
        <p className="text-muted-foreground">Rigs you've saved from the community — ready to remix — and every remix you've made.</p>
      </div>

      <Tabs
        value={tab}
        onValueChange={(value) =>
          setSearchParams(value === "remixes" ? { tab: value } : {}, { replace: true, preventScrollReset: true })
        }
        className="gap-6"
      >
        <TabsList>
          <TabsTrigger value="saved">
            <Bookmark /> Saved <span className="text-muted-foreground tabular-nums">{saved.length}</span>
          </TabsTrigger>
          <TabsTrigger value="remixes">
            <Sparkles /> Remixes <span className="text-muted-foreground tabular-nums">{remixes.length}</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="saved">
          {saved.length > 0 ? (
            <AssetGrid assets={saved} savedIds={savedIds} />
          ) : (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Bookmark />
                </EmptyMedia>
                <EmptyTitle>Nothing saved yet</EmptyTitle>
                <EmptyDescription>Browse the community library and hit save on anything you want to keep.</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button asChild>
                  <Link to="/explore">
                    <Compass /> Explore assets
                  </Link>
                </Button>
              </EmptyContent>
            </Empty>
          )}
        </TabsContent>

        <TabsContent value="remixes">
          {remixes.length > 0 ? (
            <AssetGrid assets={remixes} savedIds={savedIds} />
          ) : (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Sparkles />
                </EmptyMedia>
                <EmptyTitle>No remixes yet</EmptyTitle>
                <EmptyDescription>Pick any rig, describe a new look, and your remix will show up here.</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button asChild>
                  <Link to="/remix">
                    <Wand2 /> Remix a rig
                  </Link>
                </Button>
              </EmptyContent>
            </Empty>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
