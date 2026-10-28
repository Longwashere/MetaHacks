import { CircleCheck, Film, Loader2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useFetcher } from "react-router";
import { toast } from "sonner";
import type { action as animateAction } from "~/routes/api.remix-animation";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Label } from "~/components/ui/label";
import { Slider } from "~/components/ui/slider";
import { Textarea } from "~/components/ui/textarea";
import { ANIMATE_DURATION, type AnimateResult, type SpineAsset } from "~/lib/types";

const IDEAS = [
  { label: "Victory dance", prompt: "victory dance: raise the weapon overhead and bounce side to side" },
  { label: "Taunt", prompt: "taunt: lean forward, beat the chest twice, then shake the head" },
  { label: "Wave hello", prompt: "wave hello with the free hand while shifting weight from foot to foot" },
  { label: "Nervous idle", prompt: "nervous idle: small quick breaths, glancing left and right" },
];

interface AnimatePanelProps {
  /** The finished remix to add the animation to; null until there is one. */
  remix: SpineAsset | null;
  /** Called with the new animation's name once it's saved, to play it. */
  onAnimated: (name: string) => void;
}

/**
 * Animate tab on the remix page: Muse writes keyframes for a new animation from a prompt, and the
 * backend saves it into the remix's skeleton next to the rig's own animations.
 */
export function AnimatePanel({ remix, onAnimated }: AnimatePanelProps) {
  const fetcher = useFetcher<typeof animateAction>();
  const [prompt, setPrompt] = useState("");
  const [durationSec, setDurationSec] = useState(2);
  const [loop, setLoop] = useState(true);
  const [reading, setReading] = useState(false);
  const [result, setResult] = useState<AnimateResult | null>(null);
  const pending = reading || fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.ok) {
      setResult(fetcher.data.result);
      onAnimated(fetcher.data.result.animation.name);
      toast.success(`Added "${fetcher.data.result.animation.name}" to the remix.`);
    } else {
      toast.error(fetcher.data.error);
    }
    // Runs once per finished request; `onAnimated` changes identity every render, so it's left out.
  }, [fetcher.state, fetcher.data]);

  if (!remix?.files) {
    return <p className="text-sm text-muted-foreground">Once your remix finishes, you can describe a new animation and Muse keyframes it on the rig's bones.</p>;
  }
  const files = remix.files;

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!prompt.trim()) return;
    setResult(null);
    setReading(true);
    try {
      // The backend reads skeleton JSON itself; a binary .skel is converted here, where the
      // converter already lives, and sent along.
      let skeleton: object | undefined;
      if (files.skeletonUrl.toLowerCase().endsWith(".skel")) {
        const { skelToJson } = await import("~/lib/spine-skel-json");
        const res = await fetch(files.skeletonUrl);
        if (!res.ok) throw new Error("Couldn't read the rig's skeleton.");
        skeleton = skelToJson(await res.arrayBuffer());
      }
      fetcher.submit(JSON.stringify({ assetId: remix.id, prompt, durationSec, loop, skeleton }), {
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
    <form onSubmit={onSubmit} className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h3 className="font-semibold">Make a new animation</h3>
        <p className="text-sm text-muted-foreground">
          Describe a move and Muse keyframes it on this rig's bones. It's saved as a new animation beside the rig's own, in the player and the download.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="animatePrompt">What should it do?</Label>
        <Textarea
          id="animatePrompt"
          name="prompt"
          rows={3}
          maxLength={500}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="e.g. a victory dance: raise the weapon overhead and bounce side to side"
        />
        <div className="flex flex-wrap gap-1.5">
          {IDEAS.map((idea) => (
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

      <div className="flex flex-col gap-2">
        <Button type="submit" disabled={!prompt.trim() || pending} className="w-full">
          {pending ? <Loader2 className="animate-spin" /> : <Film />}
          {pending ? "Muse is keyframing…" : "Animate"}
        </Button>
        <p className="text-center text-xs text-muted-foreground">
          {pending ? "This usually takes under a minute." : "One Muse Spark call. Doesn't use your monthly remixes."}
        </p>
      </div>

      {result && (
        <Alert>
          <CircleCheck />
          <AlertTitle>Added "{result.animation.name}"</AlertTitle>
          <AlertDescription className="flex flex-col gap-2">
            {result.notes && <p>{result.notes}</p>}
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
            <p>Not right? Change the prompt and try again; each try is saved as its own animation.</p>
          </AlertDescription>
        </Alert>
      )}
    </form>
  );
}
