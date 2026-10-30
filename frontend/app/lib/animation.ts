import type { SpineAnimation } from "./types";

/** Clips this long or shorter are usually twitches or poses; prefer something with real motion. */
const MIN_PREFERRED_SEC = 0.9;

/**
 * The clip to show when none is chosen: the first longer than 0.9s, else the first longer than 0s
 * (0s clips are setup poses and never move), else the first.
 */
export function pickDefaultClip<T>(clips: readonly T[], durationSec: (clip: T) => number): T | undefined {
  return (
    clips.find((c) => durationSec(c) > MIN_PREFERRED_SEC) ?? clips.find((c) => durationSec(c) > 0) ?? clips[0]
  );
}

export function defaultAnimation(animations: SpineAnimation[]): SpineAnimation | undefined {
  return pickDefaultClip(animations, (a) => a.durationSec);
}
