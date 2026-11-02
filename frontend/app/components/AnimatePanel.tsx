import { CircleCheck, Film, Loader2, Pencil, X } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useFetcher } from "react-router";
import { toast } from "sonner";
import type { action as animateAction } from "~/routes/api.remix-animation";
import { AnimationNameField, type RenameAnimationResult, renameFetcherKey } from "~/components/AnimationNameField";
import { DeleteAnimationButton } from "~/components/DeleteAnimationButton";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Label } from "~/components/ui/label";
import { Slider } from "~/components/ui/slider";
import { Textarea } from "~/components/ui/textarea";
import { ANIMATE_DURATION, type AnimateResult, type SpineAnimation, type SpineAsset } from "~/lib/types";

const IDEAS = [
  { label: "Victory dance", prompt: "victory dance: raise the weapon overhead and bounce side to side" },
  { label: "Taunt", prompt: "taunt: lean forward, beat the chest twice, then shake the head" },
  { label: "Wave hello", prompt: "wave hello with the free hand while shifting weight from foot to foot" },
  { label: "Nervous idle", prompt: "nervous idle: small quick breaths, glancing left and right" },
];

interface AnimatePanelProps {
  /** The finished remix to add the animation to; null until there is one. */
  remix: SpineAsset | null;
  /** The original rig's animation names: the remix's other animations were generated and can be deleted. Null when unknown. */
  baseAnimations: string[] | null;
  /** Called with the new animation's name once it's saved, to play it. */
  onAnimated: (name: string) => void;
  /** Called with a deleted animation's name. */
  onDeleted: (name: string) => void;
  /** Called with a renamed animation's old and new name. */
  onRenamed: (from: string, to: string) => void;
  /** Credits the user has left this month (Infinity for admins); null when unknown. */
  creditsLeft: number | null;
  /** The fewest credits a job costs; it needs at least this many left to start. */
  minCredits: number;
}

const EDIT_IDEAS = [
  { label: "Bigger", prompt: "make every pose bigger and more exaggerated, keep the timing" },
  { label: "Snappier", prompt: "faster, snappier transitions with a longer hold on the final pose" },
  { label: "Heavier", prompt: "make it feel heavier: deeper crouches, slower wind-ups, bigger impacts" },
];

/**
 * Animate tab on the remix page: Muse writes keyframes for a new animation from a prompt, and the
 * backend saves it into the remix's skeleton next to the rig's own animations. Generated
 * animations can be edited with a prompt (Muse reworks the current motion) or deleted.
 */
export function AnimatePanel({ remix, baseAnimations, onAnimated, onDeleted, onRenamed, creditsLeft, minCredits }: AnimatePanelProps) {
  const fetcher = useFetcher<typeof animateAction>();
  const [prompt, setPrompt] = useState("");
  const [durationSec, setDurationSec] = useState(2);
  const [loop, setLoop] = useState(true);
  const [reading, setReading] = useState(false);
  const [result, setResult] = useState<AnimateResult | null>(null);
  /** The generated animation the form is editing, or null to make a new one. */
  const [editing, setEditing] = useState<SpineAnimation | null>(null);
  const [keepOriginal, setKeepOriginal] = useState(false);
  const pending = reading || fetcher.state !== "idle";
  const outOfCredits = creditsLeft !== null && creditsLeft < minCredits;
  const renameFetcher = useFetcher<RenameAnimationResult>({ key: renameFetcherKey(remix?.id ?? "") });

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.ok) {
      const done = fetcher.data.result;
      setResult(done);
      setEditing(null);
      setPrompt("");
      onAnimated(done.animation.name);
      const charged = `${done.credits} credit${done.credits === 1 ? "" : "s"}`;
      toast.success(done.replaced ? `Updated "${done.replaced}" (${charged}).` : `Added "${done.animation.name}" to the remix (${charged}).`);
    } else {
      toast.error(fetcher.data.error);
    }
    // Runs once per finished request; `onAnimated` changes identity every render, so it's left out.
  }, [fetcher.state, fetcher.data]);

  useEffect(() => {
    if (renameFetcher.state !== "idle" || !renameFetcher.data) return;
    if (!renameFetcher.data.ok) {
      toast.error(renameFetcher.data.error);
      return;
    }
    const { from, to } = renameFetcher.data;
    if (to === from) return;
    if (editing?.name === from) setEditing({ ...editing, name: to });
    onRenamed(from, to);
    toast.success(`Renamed to "${to}".`);
    // Runs once per finished request; the rest only matters at that moment.
  }, [renameFetcher.state, renameFetcher.data]);

  if (!remix?.files) {
    return <p className="text-sm text-muted-foreground">Once your remix finishes, you can describe a new animation and Muse keyframes it on the rig's bones.</p>;
  }
  const files = remix.files;
  const generated = baseAnimations ? remix.animations.filter((a) => !baseAnimations.includes(a.name)) : [];

  const startEdit = (animation: SpineAnimation) => {
    setEditing(animation);
    setPrompt("");
    setDurationSec(animation.durationSec);
    setLoop(animation.loop);
    setKeepOriginal(false);
    setResult(null);
    onAnimated(animation.name);
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!prompt.trim()) return;
    setResult(null);
    setReading(true);
    try {
      // The backend reads skeleton JSON itself; a binary .skel is converted here, where the
      // converter already lives, and sent along.
      const binary = files.skeletonUrl.toLowerCase().endsWith(".skel");
      const res = await fetch(files.skeletonUrl);
      if (!res.ok) throw new Error("Couldn't read the rig's skeleton.");
      const json: object = binary ? (await import("~/lib/spine-skel-json")).skelToJson(await res.arrayBuffer()) : await res.json();
      // A labelled picture of the rig, so Muse can see which way it faces and what it holds.
      // Animating still works without it, just less reliably.
      let images: string[] = [];
      try {
        const { captureRigSheet } = await import("~/lib/spine-rig-sheet");
        images = [await captureRigSheet(files, json)];
      } catch (error) {
        console.warn("Couldn't draw the rig sheet", error);
      }
      const edit = editing ? { name: editing.name, keepOriginal } : undefined;
      fetcher.submit(JSON.stringify({ assetId: remix.id, prompt, durationSec, loop, skeleton: binary ? json : undefined, images, edit }), {
        method: "post",
        action: "/api/remix-animation",
        encType: "text/plain",
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't read the rig.");
    } finally {
      setReading(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <form onSubmit={onSubmit} className="flex flex-col gap-5">
        {editing ? (
          <div className="flex items-start justify-between gap-2">
            <div className="flex flex-col gap-1">
              <h3 className="font-semibold">Editing “{editing.name}”</h3>
              <p className="text-sm text-muted-foreground">Say what to change. Muse reads how it moves now and keeps everything you don't mention.</p>
            </div>
            <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0" disabled={pending} onClick={() => setEditing(null)}>
              <X />
              <span className="sr-only">Stop editing</span>
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <h3 className="font-semibold">Make a new animation</h3>
            <p className="text-sm text-muted-foreground">
              Describe a move and Muse keyframes it on this rig's bones. It's saved as a new animation beside the rig's own, in the player and the download.
            </p>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <Label htmlFor="animatePrompt">{editing ? "What should change?" : "What should it do?"}</Label>
          <Textarea
            id="animatePrompt"
            name="prompt"
            rows={3}
            maxLength={500}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={editing ? "e.g. make the laugh bigger and hold the final pose longer" : "e.g. a victory dance: raise the weapon overhead and bounce side to side"}
          />
          <div className="flex flex-wrap gap-1.5">
            {(editing ? EDIT_IDEAS : IDEAS).map((idea) => (
              <Button key={idea.label} type="button" variant="outline" size="sm" onClick={() => setPrompt(idea.prompt)}>
                {idea.label}
              </Button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <Label htmlFor="animateDuration">Length</Label>
            <span className="text-sm tabular-nums text-muted-foreground">{durationSec.toFixed(2)} s</span>
          </div>
          <Slider
            id="animateDuration"
            name="durationSec"
            min={ANIMATE_DURATION.min}
            max={ANIMATE_DURATION.max}
            step={0.25}
            value={[durationSec]}
            onValueChange={([v]) => setDurationSec(v)}
          />
        </div>

        <div className="flex items-center gap-2">
          <Checkbox id="animateLoop" name="loop" checked={loop} onCheckedChange={(v) => setLoop(v === true)} />
          <Label htmlFor="animateLoop" className="font-normal">
            Loop it (ends where it starts)
          </Label>
        </div>

        {editing && (
          <div className="flex items-center gap-2">
            <Checkbox id="animateKeepOriginal" name="keepOriginal" checked={keepOriginal} onCheckedChange={(v) => setKeepOriginal(v === true)} />
            <Label htmlFor="animateKeepOriginal" className="font-normal">
              Keep the original too (save the edit as a new animation)
            </Label>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <Button type="submit" disabled={!prompt.trim() || pending || outOfCredits} className="w-full">
            {pending ? <Loader2 className="animate-spin" /> : <Film />}
            {pending ? "Muse is keyframing…" : editing ? "Edit animation" : "Animate"}
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            {pending
              ? "Muse plans the beats, keys them, then checks its work. This takes a few minutes."
              : outOfCredits
                ? "You're out of credits this month."
                : `Charged by what Muse uses, usually ${minCredits} credit${minCredits === 1 ? "" : "s"}${creditsLeft !== null && Number.isFinite(creditsLeft) ? ` · ${creditsLeft} left this month` : ""}. Failed runs are free.`}
          </p>
        </div>

        {result && (
          <Alert>
            <CircleCheck />
            <AlertTitle>{result.replaced ? `Updated "${result.replaced}"` : `Added "${result.animation.name}"`}</AlertTitle>
            <AlertDescription className="flex flex-col gap-2">
              {result.notes && <p>{result.notes}</p>}
              {result.plan && (
                <details className="text-xs">
                  <summary className="cursor-pointer font-medium text-foreground">Choreography</summary>
                  <p className="mt-1 max-h-48 overflow-y-auto whitespace-pre-line">{result.plan}</p>
                </details>
              )}
              {result.dropped.length > 0 && (
                <div className="flex flex-col gap-1 text-xs">
                  <span className="font-medium text-foreground">Left out</span>
                  <ul className="list-disc pl-4">
                    {result.dropped.map((d) => (
                      <li key={d}>{d}</li>
                    ))}
                  </ul>
                </div>
              )}
              <p>Not right? Edit it from the list below, or delete it.</p>
            </AlertDescription>
          </Alert>
        )}
      </form>

      {/* Outside the form: submits from the delete dialog would bubble through its portal into onSubmit. */}
      {generated.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Your animations</h3>
          <ul className="flex flex-col divide-y rounded-md border">
            {generated.map((a) => (
              <li key={a.name} className="flex items-center justify-between gap-2 py-1 pr-1 pl-3 text-sm">
                <AnimationNameField assetId={remix.id} animation={a.name} index={remix.animations.indexOf(a)} disabled={pending} />
                <span className="flex shrink-0 items-center gap-2 text-xs tabular-nums text-muted-foreground">
                  {a.durationSec.toFixed(2)} s{a.loop ? " · loop" : ""}
                  <Button variant="ghost" size="icon" className="size-7" disabled={pending} onClick={() => startEdit(a)}>
                    <Pencil />
                    <span className="sr-only">Edit {a.name}</span>
                  </Button>
                  <DeleteAnimationButton assetId={remix.id} animation={a.name} onDeleted={(name) => {
                    if (editing?.name === name) setEditing(null);
                    onDeleted(name);
                  }} />
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
