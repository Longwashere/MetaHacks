import { ArrowRight, Bone, Clapperboard, Sparkles } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { SpinePreview } from "~/components/SpinePreview";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs";
import type { AddedAnimation } from "~/lib/showcase-models";
import type { SpineAsset } from "~/lib/types";
import { cn } from "~/lib/utils";

export type AnimationShowcaseRig = Pick<SpineAsset, "id" | "name" | "category" | "accent" | "animations" | "files" | "tint"> & {
  added: AddedAnimation[];
};

interface AnimationShowcaseProps {
  rigs: AnimationShowcaseRig[];
  className?: string;
}

/**
 * Plays rigs that gained new animations from Muse Spark, with the generated clips (and their
 * prompts) listed apart from the ones the rig shipped with.
 */
export function AnimationShowcase({ rigs, className }: AnimationShowcaseProps) {
  const [rigId, setRigId] = useState(rigs[0]?.id ?? "");
  const rig = rigs.find((r) => r.id === rigId) ?? rigs[0];
  const [clip, setClip] = useState(rig?.added[0]?.name ?? "");
  const [showBones, setShowBones] = useState(false);
  if (!rig) return null;

  const addedNames = new Set(rig.added.map((a) => a.name));
  const original = rig.animations.filter((a) => !addedNames.has(a.name));
  const added = rig.added.filter((a) => rig.animations.some((anim) => anim.name === a.name));
  const current = added.find((a) => a.name === clip);

  const selectRig = (id: string) => {
    const next = rigs.find((r) => r.id === id);
    setRigId(id);
    setClip(next?.added[0]?.name ?? "");
  };

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      {rigs.length > 1 && (
        <Tabs value={rig.id} onValueChange={selectRig}>
          <TabsList className="w-full sm:w-fit">
            {rigs.map((r) => (
              <TabsTrigger key={r.id} value={r.id} className="text-xs sm:text-sm">
                {r.name}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      )}

      <Card className="overflow-hidden p-0">
        <div className="grid lg:grid-cols-12">
          <div className="relative lg:col-span-7">
            <SpinePreview asset={rig} animation={clip} showBones={showBones} className="size-full" />
            <div className="pointer-events-none absolute top-3 left-3 right-3 flex items-center justify-between gap-2">
              {current ? (
                <Badge className="gap-1 shadow-sm">
                  <Sparkles className="size-3" /> New: {current.name}
                </Badge>
              ) : (
                <Badge variant="secondary" className="gap-1 shadow-sm">
                  <Clapperboard className="size-3" /> Original: {clip}
                </Badge>
              )}
              <Button
                size="sm"
                variant={showBones ? "default" : "secondary"}
                onClick={() => setShowBones(!showBones)}
                className="pointer-events-auto h-7 gap-1.5 text-xs shadow-sm"
                aria-pressed={showBones}
              >
                <Bone className="size-3.5" /> {showBones ? "Hide bones" : "Show bones"}
              </Button>
            </div>
          </div>

          <div className="flex flex-col gap-5 border-t p-5 sm:p-6 lg:col-span-5 lg:border-t-0 lg:border-l">
            <div className="flex flex-col gap-2">
              <span className="flex items-center gap-1.5 text-xs font-semibold tracking-wider text-primary uppercase">
                <Sparkles className="size-3.5" /> Added by Muse Spark
              </span>
              <ul className="flex flex-col gap-1.5">
                {added.map((a) => (
                  <li key={a.name}>
                    <button
                      type="button"
                      onClick={() => setClip(a.name)}
                      className={cn(
                        "flex w-full flex-col gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors",
                        clip === a.name ? "border-primary bg-primary/10" : "hover:bg-muted/60",
                      )}
                    >
                      <span className="text-sm font-medium text-foreground">{a.name}</span>
                      {a.prompt && (
                        <span className="text-xs text-muted-foreground">Prompt: &ldquo;{a.prompt}&rdquo;</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                Shipped with the rig
              </span>
              <div className="flex flex-wrap gap-1">
                {original.map((a) => (
                  <Button
                    key={a.name}
                    variant={clip === a.name ? "secondary" : "outline"}
                    size="sm"
                    className="h-7 px-2.5 text-xs"
                    onClick={() => setClip(a.name)}
                  >
                    {a.name}
                  </Button>
                ))}
              </div>
            </div>

            <p className="mt-auto text-xs text-muted-foreground">
              New clips are written into the rig&apos;s own skeleton file next to the originals, so they export and play
              like any other animation.
            </p>
            <Button size="sm" asChild className="w-fit gap-1.5 text-xs">
              <Link to={`/assets/${rig.id}`}>
                Open {rig.name} <ArrowRight className="size-3.5" />
              </Link>
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
