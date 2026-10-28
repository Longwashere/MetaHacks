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
3. Each part is one cut-out piece of the character; it becomes the matching piece of the new character and nothing more. A bone segment becomes the same segment of a limb (an upper-arm bone becomes an upper arm, with no hand or foot added); a helmet, boot, greave or other armour piece stays an empty piece with nobody inside it; a head stays one head. Never ask for whole limbs, bodies or heads inside a part that is only a piece of one.
4. Map accessories onto existing parts. If the requested look needs a suit, tie, glasses, or other accessory with no dedicated part, paint it as a pattern or detail inside the closest existing part, for example a tie pattern on the torso, not as a new shape.
5. Keep the character recognizable unless the user explicitly asks to change identity. Keep species features, horns, tusks, ears, and overall silhouette unless the requested look says otherwise.
6. Respect the Change amount and Keep palette flag in the user message. Light = recolor and small details only. Moderate = restyle materials and details, keep silhouette. Heavy = bold restyle, still same outline. If Keep palette is on, keep the original colors and change materials and details only.

How to write editPrompt:
- Translate abstract requests into concrete visuals. Do not repeat vague words like "modern", "cool", or "lawyer". Say what that means in paint: materials, colors, patterns, and surface details, for example charcoal wool suit fabric with subtle pinstripes, white shirt, burgundy tie pattern.
- Cover the major visible parts and explicitly mention thin or small parts, like straps, bones, shafts, and buckles, so the image model does not drop them.
- The Parts list gives each part's page and where it sits, as percentages of that page image (x from the left edge, y from the top). Use it to work out what each part is from its picture; names can mislead (e.g. "head_2" may be a jaw). In editPrompt, name parts by what they are and where they sit (e.g. "the tusked lower jaw at bottom left"), especially small or odd-shaped parts that could pass for something else.
- When the requested look or the Art style line names an art style that differs from the pages (a studio, game, artist or medium, e.g. "Studio Ghibli", "MapleStory", "watercolor"), the style change matters as much as the subject. Start editPrompt with one sentence saying what that style looks like in paint (line weight, colour and shading, amount of texture, lighting), end it with a short reminder of the same, and describe every material in that style's terms. For a soft or clean style, don't ask for grit like fine cracks, scratches, pitting or weathering; for Studio Ghibli, for example: clean thin outlines, soft flat colours with gentle gradients, simple texture, warm light.
- Use specific, paintable language only. No instructions about the model, the rig, or the atlas itself.
- One paragraph, imperative voice, at most 1000 characters.

Reply with JSON only, no markdown, no extra fields: {"name": "...", "editPrompt": "..."}
- name: 2 to 5 words naming the remixed asset, Title Case, based on the new look, not the original asset name.
- editPrompt: one paragraph, at most 1000 characters, as described above.`;

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
  return { name: `${base.name} Remix`, editPrompt: `Repaint the character as: ${input.prompt}.` };
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
  return { name: cleanName, editPrompt: cleanPrompt };
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

const PART_FIX_SYSTEM_PROMPT = `You are the art director for a 2D game character whose sprite parts are being repainted a few at a time. You are given one image: the parts to repaint, cut out of the character's sprite atlas and placed on a plain solid-colour background (the user message names the colour; ignore it). An image-editing model will repaint exactly this image using only your editPrompt.

The user message lists the parts in the image and where each sits (percent of the image, x from the left, y from the top), says whether they show the character's original parts or its current remixed ones, describes how the rest of the character already looks, and gives the art style and the user's request.

Rules:
1. Work out what each part is from the picture and its position; names can mislead (a scarf-wrapped torso can look like a head). In editPrompt, name every part by where it sits and what it is, e.g. "the tall blade on the left".
2. Say what each part becomes, following the request. Turn vague words into paint: shape, materials, colours, patterns, surface detail. If the request is about one part ("the body"), apply it to that part and keep the others what they are, restyled to match.
3. Each part is one cut-out piece of the character and becomes the matching piece and nothing more: a torso piece is a torso with no head or face, a limb segment has no hand or foot, armour stays empty, a head is one head. Never ask for a whole body, a second head, or anything inside armour.
4. Each part stays where it is and no bigger than it is now; it may change shape within that.
5. Match the rest of the character. Start with one sentence describing its art style in paint terms (line weight, shading, colour, amount of texture, lighting), and use its materials and palette unless the request says otherwise. The description of the rest of the character was written for the whole sprite sheet: ignore any positions or part lists in it.
6. Paintable language only, imperative voice, one paragraph, at most 900 characters. Nothing about the model, the rig, the atlas or the background.

Reply with JSON only, no markdown: {"editPrompt": "..."}`;

export interface PartFixPlanInput {
  /** The packed parts as Muse Image will see them. */
  image: string;
  background: string;
  /** One line per part, e.g. "body: x 35–65%, y 30–62%". */
  parts: string[];
  source: "original" | "remix";
  /** How the rest of the character looks: the remix's edit prompt, or the user's remix prompt. */
  look: string | null;
  style: string;
  request: string;
}

/**
 * Asks Muse Spark to expand a part-fix request into the image prompt: the remix's art style in
 * paint terms, and what each chosen part becomes, named by where it sits in the image Muse
 * Image gets. Returns null when the reply is unusable, so the caller can use the request as-is.
 */
export async function planPartFix(input: PartFixPlanInput, signal: AbortSignal): Promise<string | null> {
  const request = [
    `Parts in the image:\n${input.parts.map((p) => `- ${p}`).join("\n")}`,
    input.source === "original"
      ? "They show the character's original parts, from before the remix."
      : "They show the remix's current parts, which need fixing.",
    input.look ? `How the rest of the character looks: ${input.look}` : "",
    `Art style: ${input.style}`,
    `Background: solid ${input.background}`,
    `Request: ${input.request}`,
  ]
    .filter(Boolean)
    .join("\n");
  logPrompt(`chat/completions (${MUSE_MODEL}) part fix + 1 image`, request);
  const res = await aiFetch(`${META_API_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey()}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MUSE_MODEL,
      messages: [
        { role: "system", content: PART_FIX_SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: request },
            { type: "image_url", image_url: { url: input.image } },
          ],
        },
      ],
    }),
    timeoutMs: MUSE_TIMEOUT_MS,
    signal,
  });
  if (!res.ok) {
    console.error(`Muse part-fix plan request failed (${res.status})`, await res.text());
    return null;
  }
  const content = getPath(await res.json(), ["choices", 0, "message", "content"]);
  if (typeof content !== "string") return null;
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  let editPrompt: unknown = null;
  try {
    editPrompt = start >= 0 && end > start ? getPath(JSON.parse(content.slice(start, end + 1)), ["editPrompt"]) : null;
  } catch {
    return null;
  }
  if (typeof editPrompt !== "string") return null;
  const clean = editPrompt.replace(/\s+/g, " ").trim().slice(0, 1200);
  if (clean.length < 20) return null;
  logPrompt(`chat/completions (${MUSE_MODEL}) part fix plan`, clean);
  return clean;
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
