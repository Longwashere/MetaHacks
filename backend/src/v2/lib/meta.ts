import { aiFetch } from "../../lib/ai-fetch.js";
import { IMAGE_MODEL, IMAGE_TIMEOUT_MS, META_API_BASE_URL, MUSE_MODEL, MUSE_TIMEOUT_MS } from "../../lib/config.js";
import type { RemixInput } from "./types.js";

// Meta Model API: Muse Spark (chat completions) plans the look, Muse Image repaints
// the atlas pages. Both are OpenAI-compatible. Throw Errors with user-facing
// messages; the job runner shows them as `job.error`.

export interface RemixPlan {
  /** Short name for the remix, e.g. "Crimson Ninja Spineboy". */
  name: string;
  /** Instructions for the image model describing the new look. */
  editPrompt: string;
  /** What each part is in the original art, by region name, e.g. head_2 → "tusked lower jaw". May be incomplete. */
  parts: Record<string, string>;
}

function apiKey(): string {
  const key = process.env.META_API_KEY || process.env.MODEL_API_KEY;
  if (!key) throw new Error("The remix service isn't configured yet.");
  return key;
}

const PLAN_SYSTEM_PROMPT = `You are the art director for 2D game assets. You are given atlas pages from a rigged Spine character: each page is a sprite sheet of separate body parts (regions) packed on a plain solid-colour background (the user message names the colour). That background colour is not part of the character; ignore it completely.

An image-editing model will repaint every page into a new look using only your editPrompt. That prompt will be reused, unchanged, for every page, so it must work for all pages, not just the first one.

Hard rules, in priority order:
1. Preserve geometry over novelty. Every part must keep exactly the same position, size, outline, and pose. Only what is painted inside each part changes. If a requested look conflicts with this, preserve the geometry and adapt the look to fit inside the existing parts.
2. Only use parts you can see in the images and in the Parts list in the user message. Never invent, rename, merge, split, move, or resize a part, and never ask for text, backgrounds, scenery, shadows, or a new background colour.
3. Map accessories onto existing parts. If the requested look needs a suit, tie, glasses, or other accessory with no dedicated part, paint it as a pattern or detail inside the closest existing part, for example a tie pattern on the torso, not as a new shape.
4. Keep the character recognizable unless the user explicitly asks to change identity. Keep species features, horns, tusks, ears, and overall silhouette unless the requested look says otherwise.
5. Respect the Change amount and Keep palette flag in the user message. Light = recolor and small details only. Moderate = restyle materials and details, keep silhouette. Heavy = bold restyle, still same outline. If Keep palette is on, keep the original colors and change materials and details only.

How to write editPrompt:
- Translate abstract requests into concrete visuals. Do not repeat vague words like "modern", "cool", or "lawyer". Say what that means in paint: materials, colors, patterns, and surface details, for example charcoal wool suit fabric with subtle pinstripes, white shirt, burgundy tie pattern.
- Cover the major visible parts and explicitly mention thin or small parts, like straps, bones, shafts, and buckles, so the image model does not drop them.
- The Parts list gives each part's page and where it sits, as percentages of that page image (x from the left edge, y from the top). Use it to work out what each part is from its picture; names can mislead (e.g. "head_2" may be a jaw). In editPrompt, name parts by what they are and where they sit (e.g. "the tusked lower jaw at bottom left"), especially small or odd-shaped parts that could pass for something else.
- When the requested look or the Art style line names an art style that differs from the pages (a studio, game, artist or medium, e.g. "Studio Ghibli", "MapleStory", "watercolor"), the style change matters as much as the subject. Start editPrompt with one sentence saying what that style looks like in paint (line weight, colour and shading, amount of texture, lighting), end it with a short reminder of the same, and describe every material in that style's terms. For a soft or clean style, don't ask for grit like fine cracks, scratches, pitting or weathering; for Studio Ghibli, for example: clean thin outlines, soft flat colours with gentle gradients, simple texture, warm light.
- Use specific, paintable language only. No instructions about the model, the rig, or the atlas itself.
- One paragraph, imperative voice, at most 1000 characters.

Reply with JSON only, no markdown, no extra fields: {"name": "...", "editPrompt": "...", "parts": {...}}
- name: 2 to 5 words naming the remixed asset, Title Case, based on the new look, not the original asset name.
- editPrompt: one paragraph, at most 1000 characters, as described above.
- parts: an object with one entry per part in the Parts list, keyed by its exact name: 1 to 5 words saying what that shape is in the original art, judged from the picture, not the name, e.g. {"head_2": "tusked lower jaw", "legL": "left foot with fur cuff"}. The image model gets these labels with each part's position.`;

/** Asks Muse Spark to turn the user's prompt into instructions for the image model. */
export async function planRemix(
  input: RemixInput,
  base: { name: string; parts: string[]; pageImages: string[]; background: string },
  signal: AbortSignal,
): Promise<RemixPlan> {
  const kept = keptPartProperties(input);
  const request = [
    `Asset: ${base.name}`,
    `Parts:\n${base.parts.slice(0, 120).join("\n")}`,
    `Page background: solid ${base.background}`,
    `Requested look: ${input.prompt}`,
    input.style === "auto"
      ? "Art style: keep the original art style of the pages, unless the requested look names a different one"
      : `Art style: ${input.style}`,
    `Change amount: ${strengthHint(input.strength, input.keepOutline)}`,
    `Keep palette: ${input.keepPalette ? "on" : "off"}`,
    kept ? `Every part must keep exactly the same ${kept}.` : "",
    input.keepOutline ? "Only what is painted inside each part changes." : "",
  ].filter(Boolean).join("\n");
  logPrompt(`chat/completions (${MUSE_MODEL}) system`, PLAN_SYSTEM_PROMPT);
  logPrompt(`chat/completions (${MUSE_MODEL}) user + ${base.pageImages.length} page image(s)`, request);

  const res = await aiFetch(`${META_API_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey()}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MUSE_MODEL,
      messages: [
        { role: "system", content: PLAN_SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: request },
            ...base.pageImages.map((url) => ({ type: "image_url", image_url: { url } })),
          ],
        },
      ],
    }),
    timeoutMs: MUSE_TIMEOUT_MS,
    signal,
  });
  if (!res.ok) {
    console.error(`Muse request failed (${res.status})`, await res.text());
    throw new Error("Couldn't plan the remix. Try again.");
  }

  const plan = parsePlan(await res.json());
  if (plan) {
    logPrompt(`chat/completions (${MUSE_MODEL}) reply`, JSON.stringify(plan, null, 2));
    return plan;
  }
  // Muse's reply is untrusted; if it's unusable, fall back to the user's own words.
  console.warn("Muse returned an unusable plan; using the prompt as-is.");
  return { name: `${base.name} Remix`, editPrompt: `Repaint the character as: ${input.prompt}.`, parts: {} };
}

function strengthHint(strength: number, keepOutline: boolean): string {
  if (strength < 0.34) return "Light — keep the shading, line work and shapes; change colors and materials only";
  if (strength < 0.67) return "Moderate — restyle materials and details, keep the overall character recognizable";
  return keepOutline ? "Heavy — reimagine the surface details freely, but keep every part's silhouette" : "Heavy — reimagine the surface details freely";
}

/**
 * The part properties the user asked the models to keep, as prompt wording, e.g.
 * "position, size and outline". Empty when none were ticked.
 */
export function keptPartProperties(input: RemixInput): string {
  const kept = [input.keepPosition && "position", input.keepSize && "size", input.keepOutline && "outline"].filter(
    (p): p is string => typeof p === "string",
  );
  return kept.length > 1 ? `${kept.slice(0, -1).join(", ")} and ${kept.at(-1)}` : (kept[0] ?? "");
}

function parsePlan(body: unknown): RemixPlan | null {
  const content = getPath(body, ["choices", 0, "message", "content"]);
  if (typeof content !== "string") return null;
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    return null;
  }
  const name = getPath(parsed, ["name"]);
  const editPrompt = getPath(parsed, ["editPrompt"]);
  if (typeof name !== "string" || typeof editPrompt !== "string") return null;

  const cleanName = name.replace(/[^\p{L}\p{N} '\-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 60);
  const cleanPrompt = editPrompt.replace(/\s+/g, " ").trim().slice(0, 1500);
  if (!cleanName || cleanPrompt.length < 20) return null;
  return { name: cleanName, editPrompt: cleanPrompt, parts: parsePartLabels(getPath(parsed, ["parts"])) };
}

/** Keeps short plain-text labels only; they go into the image prompt as-is. */
function parsePartLabels(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const labels: Record<string, string> = {};
  for (const [name, label] of Object.entries(value).slice(0, 120)) {
    if (typeof label !== "string") continue;
    const clean = label.replace(/[^\p{L}\p{N} '\-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 40);
    if (clean) labels[name] = clean;
  }
  return labels;
}

/**
 * Repaints one atlas page with Muse Image. `reference` is an already-repainted page
 * of the same rig, so multi-page rigs stay consistent. Returns the encoded image.
 */
export async function repaintPage(
  page: { dataUrl: string; side: number },
  prompt: string,
  reference: string | null,
  signal: AbortSignal,
): Promise<Buffer> {
  logPrompt(`images/edits (${IMAGE_MODEL}) ${page.side}x${page.side}${reference ? " + reference page" : ""}`, prompt);
  const body = JSON.stringify({
    model: IMAGE_MODEL,
    prompt,
    images: [{ image_url: page.dataUrl }, ...(reference ? [{ image_url: reference }] : [])],
    size: `${page.side}x${page.side}`,
    n: 1,
  });

  // One retry for the API's retryable errors (503).
  for (let attempt = 0; ; attempt++) {
    const res = await aiFetch(`${META_API_BASE_URL}/images/edits`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey()}`, "content-type": "application/json" },
      body,
      timeoutMs: IMAGE_TIMEOUT_MS,
      signal,
    });
    if (res.ok) {
      const b64 = getPath(await res.json(), ["data", 0, "b64_json"]);
      if (typeof b64 !== "string" || !b64) throw new Error("The image model returned no image. Try again.");
      return Buffer.from(b64, "base64");
    }

    const text = await res.text();
    if (res.status === 503 && attempt === 0) continue;
    console.error(`Muse Image request failed (${res.status})`, text);
    if (text.includes("content_policy_violation")) throw new ContentPolicyError();
    throw new Error("Couldn't paint the new textures. Try again.");
  }
}

/** Muse Image refused the prompt under its content policy. The message is user-facing. */
export class ContentPolicyError extends Error {
  constructor() {
    super("The image model declined this prompt. Try describing the look differently.");
    this.name = "ContentPolicyError";
  }
}

const REWORD_SYSTEM_PROMPT = `You rewrite prompts for an image-editing model that repaints 2D game sprite sheets.
The prompt you are given was rejected by the Muse Image content policy. Re-word this prompt so it does not get rejected by the Muse Image generation content policy, while keeping the same look: materials, colors, patterns and art style. Soften or drop anything violent, gory, sexual, hateful, or naming real people, brands or copyrighted characters; describe the look in neutral visual terms instead.
Reply with the new prompt only: one paragraph, at most 1000 characters, no quotes or markdown.`;

/**
 * Asks Muse Spark to re-word an edit prompt that Muse Image rejected under its content
 * policy. Returns null when the reply is unusable.
 */
export async function rewordForContentPolicy(editPrompt: string, signal: AbortSignal): Promise<string | null> {
  logPrompt(`chat/completions (${MUSE_MODEL}) reword for content policy`, editPrompt);
  const res = await aiFetch(`${META_API_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey()}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MUSE_MODEL,
      messages: [
        { role: "system", content: REWORD_SYSTEM_PROMPT },
        { role: "user", content: editPrompt },
      ],
    }),
    timeoutMs: MUSE_TIMEOUT_MS,
    signal,
  });
  if (!res.ok) {
    console.error(`Muse reword request failed (${res.status})`, await res.text());
    return null;
  }
  const content = getPath(await res.json(), ["choices", 0, "message", "content"]);
  if (typeof content !== "string") return null;
  const reworded = content.replace(/^["'`\s]+|["'`\s]+$/g, "").replace(/\s+/g, " ").trim().slice(0, 1500);
  if (reworded.length < 20) return null;
  logPrompt(`chat/completions (${MUSE_MODEL}) reworded`, reworded);
  return reworded;
}

/** Logs a prompt sent to (or plan returned by) the Meta API. Images are never logged. */
function logPrompt(label: string, text: string) {
  console.log(`[meta] ${label}:\n${text}\n`);
}

function getPath(value: unknown, path: (string | number)[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}
