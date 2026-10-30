import type { SpineAnimation } from "./types";

/** The clip to show when none is chosen: the first with a real duration, since 0s clips (setup poses) never move. */
export function defaultAnimation(animations: SpineAnimation[]): SpineAnimation | undefined {
  return animations.find((a) => a.durationSec > 0) ?? animations[0];
}
