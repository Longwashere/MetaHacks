// The live view of a running remix (v2 and v3): what it's doing, what it has done, and the
// version to draw. Mirrors RemixLive in frontend/app/lib/types.ts. Keep the two in sync.

/** What the remix is working on right now, for the live view. */
export interface RemixActivity {
  kind: "reading" | "reference" | "planning" | "painting" | "checking-style" | "checking-rig" | "fixing" | "revising" | "tweaking" | "packing";
  /** Paint round, from 1; 0 outside the paint loop. */
  round: number;
  /** Atlas page being painted. */
  page?: string;
  /** Atlas regions being repainted by a part fix. */
  regions?: string[];
}

/**
 * The version the live view draws. Every version keeps the base atlas's regions and page names,
 * so the base atlas loads it with these page images swapped in.
 */
export interface RemixPreview {
  /** Paint round it came from. */
  round: number;
  /** Page image URL by atlas page name; pages not listed are still the base rig's. */
  pages: Record<string, string>;
  /** URL of the skeleton to draw it with (boxed meshes or tweaks), or null for the base rig's. */
  skeletonUrl: string | null;
}

export interface RemixIssue {
  /** Atlas region the problem is in, or null for the whole character. */
  part: string | null;
  problem: string;
  fix: string;
}

/**
 * How the shipped version did against the quality bar: every check passed, a check failed, or a
 * check couldn't run (no drawing of the character, or Spark gave no usable verdict).
 */
export type RemixQuality = "passed" | "below-bar" | "unchecked";

/** Something that happened in a remix, for the live view's timeline. */
export type RemixEventData =
  | { type: "planned"; name: string; editPrompt: string; style: string | null; referenceLook: string | null }
  /** `prompt` is the exact text Muse Image got for the kept paint. */
  | { type: "painted"; round: number; page: string; url: string; shrunk: { part: string; scale: number }[]; prompt: string }
  /** Muse Image moved the parts on a page; `url` is its raw output. */
  | { type: "rejected"; round: number; page: string; attempt: number; insideBoxes: number; url: string; prompt: string }
  /** Muse Image declined the edit prompt under its content policy, and Spark re-worded it. */
  | { type: "reworded"; round: number; editPrompt: string }
  | { type: "checked"; round: number; check: "style" | "rig"; pass: boolean; score: number; summary: string; issues: RemixIssue[]; renderUrl: string | null }
  /**
   * `prompt` is the check's request, `plan` Spark's expansion of it (null when unusable or not
   * reached), and `imagePrompts` the text Muse Image got for each page, without retry notes.
   */
  | { type: "fixed"; round: number; regions: string[]; prompt: string; plan: string | null; imagePrompts: string[]; error: string | null }
  /** The plan was rewritten for the next round, or (null) the issues were added to its prompt instead. */
  | { type: "revised"; round: number; editPrompt: string | null }
  /** The version that ships, and whether it cleared the quality bar (see RemixQuality). */
  | { type: "chosen"; round: number; score: number; quality: RemixQuality }
  /** The tweak step moved or scaled this many parts back into place. */
  | { type: "tweaked"; parts: number };
export type RemixEvent = RemixEventData & { at: string };

/** Live progress beyond the stage line, reported by runRemix. */
export interface RemixLive {
  activity: RemixActivity | null;
  events: RemixEvent[];
  preview: RemixPreview | null;
}

/** Reports what the remix is doing, for the live view. */
export interface RemixReporter {
  activity(activity: RemixActivity): void;
  event(event: RemixEventData): void;
  preview(preview: RemixPreview): void;
}

export function emptyLive(): RemixLive {
  return { activity: null, events: [], preview: null };
}

/** A reporter that keeps everything in `live`, stamping events with the time. */
export function liveReporter(live: RemixLive): RemixReporter {
  return {
    activity: (activity) => (live.activity = activity),
    event: (event) => live.events.push({ ...event, at: new Date().toISOString() }),
    preview: (preview) => (live.preview = preview),
  };
}
