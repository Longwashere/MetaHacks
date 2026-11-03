import { ArrowRight, Bone, Brush, Scissors, Sparkles, Wand2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { JointEditor } from "~/components/JointEditor";
import { SpinePreview } from "~/components/SpinePreview";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { AUTO_RIG_SHOWCASE } from "~/lib/showcase-models";
import type { SpineAsset } from "~/lib/types";
import { cn } from "~/lib/utils";

export type AutoRigShowcaseRig = Pick<SpineAsset, "id" | "name" | "category" | "accent" | "animations" | "files" | "tint" | "prompt">;

interface AutoRigShowcaseProps {
  /** The auto-rigged knight first, then its remixes. */
  rigs: AutoRigShowcaseRig[];
  className?: string;
}

const CHECKER = "bg-[repeating-conic-gradient(var(--muted)_0_25%,transparent_0_50%)] bg-[length:24px_24px]";

/**
 * One image through /autoRig, step by step (pose, joints, parts), then the live rig with the
 * remixes made from it.
 */
export function AutoRigShowcase({ rigs, className }: AutoRigShowcaseProps) {
  const demo = AUTO_RIG_SHOWCASE;
  const [joints, setJoints] = useState(demo.joints);
  const [rigId, setRigId] = useState(rigs[0]?.id ?? "");
  const [showBones, setShowBones] = useState(true);
  const rig = rigs.find((r) => r.id === rigId) ?? rigs[0];

  return (
    <div className={cn("flex flex-col gap-6", className)}>
      <ol className="grid gap-4 md:grid-cols-3">
        <Step n={1} icon={Sparkles} model="Muse Image" title="Poses the character">
          <img src={demo.poseUrl} alt="The knight redrawn by Muse Image standing with its arms and legs spread, on magenta" className="aspect-square w-full rounded-lg border object-contain" loading="lazy" />
          A screenshot of a knight, redrawn standing with its limbs apart on a flat key colour, then cut out.
        </Step>
        <Step n={2} icon={Bone} model="Muse Spark · SAM 3.1" title="Places 19 joints, finds the gear">
          <JointEditor image={demo.cutout.url} width={demo.cutout.width} height={demo.cutout.height} joints={joints} onChange={setJoints} />
          Spark placed these joints and named the gear; SAM 3.1 masked each piece ({demo.gear.join(", ")}) so it stays whole. Drag a joint: on /autoRig, that&apos;s how you fix one.
        </Step>
        <Step n={3} icon={Scissors} model="RigForge · Muse Image" title="Cuts it into parts">
          <img src={demo.partsUrl} alt="The knight's atlas page: head, torso, cape and each limb segment as separate pieces" className={cn("aspect-square w-full rounded-lg border object-contain", CHECKER)} loading="lazy" />
          Fifteen pieces on one atlas page, like a hand-cut Spine project. Muse Image paints in what was hidden behind each joint.
        </Step>
      </ol>

      {rig && (
        <Card className="overflow-hidden p-0">
          <div className="grid lg:grid-cols-12">
            <div className="relative lg:col-span-7">
              <SpinePreview asset={rig} showBones={showBones} className="size-full" />
              <div className="pointer-events-none absolute top-3 right-3 left-3 flex items-center justify-between gap-2">
                <Badge className="gap-1 shadow-sm">
                  {rig.prompt ? <Brush className="size-3" /> : <Wand2 className="size-3" />}
                  {rig.prompt ? `Remix: ${rig.name}` : demo.rig.label}
                </Badge>
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
                <span className="text-xs font-semibold tracking-wider text-primary uppercase">4 · A real Spine 4.2 rig</span>
                <p className="text-sm text-muted-foreground">
                  20 bones with IK on the legs, weighted meshes and an idle loop, live in the player. It&apos;s a normal rig from here: remix it, animate it with Muse Spark or download it.
                </p>
              </div>
              <ul className="flex flex-col gap-1.5">
                {rigs.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => setRigId(r.id)}
                      className={cn(
                        "flex w-full flex-col gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors",
                        rig.id === r.id ? "border-primary bg-primary/10" : "hover:bg-muted/60",
                      )}
                    >
                      <span className="text-sm font-medium text-foreground">{r.prompt ? r.name : demo.rig.label}</span>
                      <span className="line-clamp-2 text-xs text-muted-foreground">
                        {r.prompt ? <>Remix prompt: &ldquo;{r.prompt}&rdquo;</> : "Built from the image above, no artist or animator."}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <div className="mt-auto flex flex-wrap gap-2">
                <Button size="sm" asChild className="gap-1.5 text-xs">
                  <Link to="/autoRig">
                    <Wand2 className="size-3.5" /> Auto-rig a character
                  </Link>
                </Button>
                <Button size="sm" variant="outline" asChild className="gap-1.5 text-xs">
                  <Link to={`/assets/${rig.id}`}>
                    Open {rig.prompt ? rig.name : "the rig"} <ArrowRight className="size-3.5" />
                  </Link>
                </Button>
              </div>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}

function Step({ n, icon: Icon, model, title, children }: { n: number; icon: typeof Bone; model: string; title: string; children: ReactNode }) {
  return (
    <li className="flex flex-col gap-3 rounded-xl border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="size-4" />
        </div>
        <span className="font-mono text-xs text-muted-foreground">
          {n} · {model}
        </span>
      </div>
      <h3 className="font-semibold text-foreground">{title}</h3>
      <div className="flex flex-col gap-3 text-sm leading-relaxed text-muted-foreground">{children}</div>
    </li>
  );
}
