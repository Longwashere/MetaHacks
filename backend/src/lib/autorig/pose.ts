import sharp from "sharp";
import { aiFetch } from "../ai-fetch.js";
import { IMAGE_MODEL, IMAGE_TIMEOUT_MS, META_API_BASE_URL } from "../config.js";
import { apiKey, getPath, logPrompt } from "../meta.js";
import type { RigTrace, TraceStep } from "./trace.js";
import type { AutoRigView } from "./types.js";

// The pose step: Muse Image redraws the uploaded character in a rig-ready pose on flat magenta
// (AUTO_RIG_PLAN.md, "What we tested"). It treats angles and framing as rough hints and replies
// with a 1600×1600 WebP whatever size is asked for, so the reply is decoded by content and the
// cutout step trims and pads it.

const SIDE = 1024;

const VIEWS: Record<AutoRigView, string> = {
  front:
    "Pose: neutral A-pose, front view facing the viewer straight on, standing upright. " +
    "Arms straight and held out away from the body, about 45 degrees down from horizontal, with a clear gap between each arm and the torso. " +
    "Hands open and empty. Legs straight and slightly apart with a gap between them, feet flat. ",
  right:
    "View: three-quarter view, with the character's body and face turned toward the right side of the image (the character faces right), standing upright. " +
    "Both arms fully visible: arms straight and held out away from the body, about 45 degrees down from horizontal, the near arm in front of the body and the far arm clearly visible behind it, each with a clear gap between the arm and the torso. " +
    "Hands open and empty. Legs straight and apart in a wide stance, both legs fully visible with a clear gap between them, feet flat. ",
};

function posePrompt(view: AutoRigView): string {
  return (
    "Redraw this exact same character as a full-body character sheet pose for 2D rigging. " +
    VIEWS[view] +
    "Remove any weapons, shields and held props, and anything floating around the character. " +
    "Keep the character's identity exactly: same face, head, body proportions, outfit, armour, colours, materials and art style. " +
    "The whole body is visible and centered, filling about 80% of the image height, nothing cropped. " +
    "No ground, no shadow, no text. Background: one solid flat pure magenta colour (#FF00FF) everywhere, with no gradient or texture."
  );
}

/** Asks Muse Image for the character in the rig pose; returns the redraw (any format sharp reads). */
export async function poseCharacter(image: Buffer, view: AutoRigView, signal: AbortSignal, trace?: RigTrace): Promise<Buffer> {
  return imageEdit(await squareInput(image), posePrompt(view), `pose ${view}`, signal, trace, "pose");
}

/** One Muse Image edit of a square PNG; returns the reply image (a WebP, whatever size is asked for). */
export async function imageEdit(input: Buffer, prompt: string, label: string, signal: AbortSignal, trace?: RigTrace, step: TraceStep = "pose"): Promise<Buffer> {
  if (trace) return trace.call(step, IMAGE_MODEL, label, (record) => editOnce(input, prompt, label, signal, record));
  return editOnce(input, prompt, label, signal, {});
}

async function editOnce(input: Buffer, prompt: string, label: string, signal: AbortSignal, record: { usage?: unknown; detail?: Record<string, unknown> }): Promise<Buffer> {
  logPrompt(`images/edits (${IMAGE_MODEL}) auto-rig ${label}`, prompt);
  record.detail = { prompt, attempts: 0 };
  const body = JSON.stringify({
    model: IMAGE_MODEL,
    prompt,
    images: [{ image_url: `data:image/png;base64,${input.toString("base64")}` }],
    size: `${SIDE}x${SIDE}`,
    n: 1,
  });
  // One retry for the API's retryable errors (503), as in repaintPage.
  for (let attempt = 0; ; attempt++) {
    record.detail.attempts = attempt + 1;
    const res = await aiFetch(`${META_API_BASE_URL}/images/edits`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey()}`, "content-type": "application/json" },
      body,
      timeoutMs: IMAGE_TIMEOUT_MS,
      signal,
    });
    if (res.ok) {
      const json: unknown = await res.json();
      const usage = getPath(json, ["usage"]);
      record.usage = usage;
      console.log(`[meta] auto-rig ${label} (${IMAGE_MODEL}) usage: ${JSON.stringify(usage)}`);
      const b64 = getPath(json, ["data", 0, "b64_json"]);
      if (typeof b64 !== "string" || !b64) throw new Error("The image model returned no image. Try again.");
      return Buffer.from(b64, "base64");
    }
    const text = await res.text();
    if (res.status === 503 && attempt === 0) continue;
    console.error(`[meta] auto-rig ${label} failed (${res.status})`, text.slice(0, 500));
    throw new Error(res.status === 400 ? "The image model couldn't use this image. Try another one." : "The image model is unavailable right now. Try again in a minute.");
  }
}

/** The upload as a square PNG, padded with its own corner colour (transparency flattened onto white). */
async function squareInput(image: Buffer): Promise<Buffer> {
  const flat = sharp(image).rotate().flatten({ background: "#ffffff" });
  const { data } = await flat.clone().raw().toBuffer({ resolveWithObject: true });
  const corner = { r: data[0], g: data[1], b: data[2] };
  return flat.resize(SIDE, SIDE, { fit: "contain", background: corner }).png().toBuffer();
}
