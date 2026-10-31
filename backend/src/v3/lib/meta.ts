import { AsyncLocalStorage } from "node:async_hooks";
import { aiFetch } from "../../lib/ai-fetch.js";
import { IMAGE_MODEL, IMAGE_TIMEOUT_MS, META_API_BASE_URL, MUSE_MODEL, MUSE_TIMEOUT_MS } from "../../lib/config.js";
import type { ArtStyle, RemixInput } from "./types.js";

/**
 * What each preset art style looks like in paint: Spark's starting point when the user picks one,
 * and the image prompt's fallback when Spark doesn't describe the style itself. A bare style name
 * was too weak: asked for "painterly", Muse Image kept an already hand-painted orc's crisp outlines
 * and fine texture (job_72ff8499).
 */
export const STYLE_LOOKS: Record<ArtStyle, string> = {
  cartoon: "bold clean dark outlines, flat bright colours with simple two-tone cel shading, smooth surfaces with almost no texture",
  anime: "clean thin dark outlines, flat cel colours with crisp one- or two-step shading and soft highlights, minimal texture",
  pixel: "crisp pixel art: hard square pixels, a limited palette, 1px dark outlines and stepped shading, no blur, gradients or anti-aliasing",
  painterly:
    "a loose oil painting: visible thick brush strokes and impasto texture, soft blended edges with no hard dark outlines, colours mixed on the surface and rich tonal variation",
  flat: "flat vector art: solid colour shapes with no gradients or texture, minimal or no outlines, simple geometric shading",
};

/**
 * The image prompt's opening for a style change: what the style looks like, and that the current
 * rendering goes. It leads the prompt, since Muse Image weighs the start most and otherwise holds
 * on to the input's rendering.
 */
export function styleInstruction(look: string, background: string): string {
  return `Art style: ${look.replace(/[.\s]+$/, "")}. Repaint every part fully in this style, replacing its current line work, shading and texture; the result must not look like the original rendering. Apply the style to the parts only: the background around and between them stays flat solid ${background}, with no paper, texture, wash, glow, mist or lines on it.`;
}

// Meta Model API: Muse Spark (chat completions) plans the look, Muse Image repaints
// the atlas pages. Both are OpenAI-compatible. Throw Errors with user-facing
// messages; the job runner shows them as `job.error`.

export interface RemixPlan {
  /** Short name for the remix, e.g. "Crimson Ninja Spineboy". */
  name: string;
  /** Instructions for the image model describing the new look. */
  editPrompt: string;
  /**
   * The target art style in paint terms when the remix changes the pages' style, else null.
   * Spark writes it, so a named reference ("Black Clover", "ukiyo-e") becomes concrete traits.
   */
  style: string | null;
  /** The most specific style reference the user named ("Black Clover manga by Yuki Tabata"), or null. */
  reference: string | null;
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
- Decide whether this is a style change: the requested look names or clearly implies an art style, medium or reference (a show, game, studio, artist, era or technique, e.g. "Black Clover", "ukiyo-e", "watercolor", "claymation", "stained glass", "16-bit") that differs from how the pages are rendered now, or the Art style line says it is one. "Same character but in X style" is a style change.
- For a style change, the style is the main change, whatever the Change amount. Write it into "style" (below), and in editPrompt describe every part in the new style's terms rather than as it looks now ("loose watery green wash", not "green skin with brown straps"); keep the part list short so the style isn't drowned out. Don't repeat the style sentence at the start of editPrompt; it's added for you.
- For a soft or clean style, don't ask for grit like fine cracks, scratches, pitting or weathering.
- Use specific, paintable language only. No instructions about the model, the rig, or the atlas itself.
- One paragraph, imperative voice, at most 1000 characters.

Reply with JSON only, no markdown, no extra fields, in this order: {"name": "...", "reference": "..." or null, "style": "..." or null, "editPrompt": "..."}
- name: 2 to 5 words naming the remixed asset, Title Case, based on the new look, not the original asset name.
- reference: null unless this is a style change. Otherwise the most specific style reference in the request, with its creator or origin when known, e.g. "Black Clover manga by Yuki Tabata" (not just "anime"), "Edo-period ukiyo-e woodblock print", "Aardman claymation". For a bare medium or preset ("watercolor"), name the medium.
- style: null unless this is a style change. Otherwise one or two sentences, at most 400 characters, saying exactly what the target style looks like in paint, so a painter who has never heard of the reference could match it: outline (weight, colour, clean or scratchy, or none), colour and shading (flat, cel steps, soft gradients, washes, solid black shadows, hatching, dithering), texture and medium marks (brush strokes, paper grain, pixels, clay, glass leading), palette and lighting. Then name what replaces the current rendering, e.g. "instead of the fine gritty texture and soft airbrushed shading". Describe the parts' own surfaces only: no paper, canvas or background, and no effects around them (speed lines, glows, mist, sparkles). Translate any named show, game or artist into these traits; a name alone means little to the image model. Describe what sets the reference apart from its genre's generic look, as you'd recall it if asked about that reference on its own, not the traits every work in the genre shares (for a manga known for rough heavy inking, cross-hatching and blocky black shadows, say that, not "clean outlines and cel shading"). If the Art style line gives a preset description and the requested look names a more specific reference, describe the reference.
- editPrompt: one paragraph, at most 1000 characters, as described above.`;

/** Asks Muse Spark to turn the user's prompt into instructions for the image model. */
export async function planRemix(
  input: RemixInput,
  base: { name: string; parts: string[]; pageImages: string[]; background: string },
  reference: ReferenceLook | null,
  signal: AbortSignal,
): Promise<RemixPlan> {
  const kept = keptPartProperties(input);
  const request = [
    `Asset: ${base.name}`,
    `Parts:\n${base.parts.slice(0, 120).join("\n")}`,
    `Page background: solid ${base.background}`,
    `Requested look: ${input.prompt}`,
    reference
      ? `Reference image: the user uploaded a reference for the new look. It shows: ${reference.look} Follow it closely: use its colours, materials, patterns and costume details, mapped onto the matching parts of this character. Where the requested look and the reference differ, the requested look wins.`
      : "",
    reference?.style && input.style === "auto"
      ? `Art style: the reference image's style, ${reference.style} This is a style change.`
      : input.style === "auto"
        ? "Art style: keep the original art style of the pages, unless the requested look names a different one"
        : `Art style: ${input.style} (${STYLE_LOOKS[input.style]}). This is a style change, unless the pages already look like this.`,
    `Change amount: ${strengthHint(input.strength, input.keepOutline, input.style !== "auto")}`,
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
    console.error(`Muse request failed (${res.status}) with ${MUSE_MODEL}`, await res.text());
    throw new Error("Couldn't plan the remix. Try again.");
  }

  const plan = parsePlan(await readJson(res, "plan", MUSE_MODEL));
  if (plan) {
    logPrompt(`chat/completions (${MUSE_MODEL}) reply`, JSON.stringify(plan, null, 2));
    return plan;
  }
  // Muse's reply is untrusted; if it's unusable, fall back to the user's own words.
  console.warn("Muse returned an unusable plan; using the prompt as-is.");
  return { name: `${base.name} Remix`, editPrompt: `Repaint the character as: ${input.prompt}.`, style: null, reference: null };
}

function strengthHint(strength: number, keepOutline: boolean, styleChange: boolean): string {
  if (strength < 0.34) {
    // A chosen art style replaces the line work and shading, so Light can only keep the subject.
    return styleChange
      ? "Light — keep the colors, materials and shapes; change only the rendering, to the art style"
      : "Light — keep the shading, line work and shapes; change colors and materials only";
  }
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
  const style = getPath(parsed, ["style"]);
  const cleanStyle = typeof style === "string" ? style.replace(/\s+/g, " ").trim().slice(0, 600) : "";
  const reference = getPath(parsed, ["reference"]);
  const cleanReference = typeof reference === "string" ? reference.replace(/\s+/g, " ").trim().slice(0, 120) : "";
  return {
    name: cleanName,
    editPrompt: cleanPrompt,
    style: cleanStyle.length >= 20 ? cleanStyle : null,
    reference: cleanReference.length >= 3 && cleanStyle.length >= 20 ? cleanReference : null,
  };
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
      const b64 = getPath(await readJson(res, "repaint", IMAGE_MODEL), ["data", 0, "b64_json"]);
      if (typeof b64 !== "string" || !b64) throw new Error("The image model returned no image. Try again.");
      return Buffer.from(b64, "base64");
    }

    const text = await res.text();
    if (res.status === 503 && attempt === 0) continue;
    console.error(`Muse Image request failed (${res.status}) with ${IMAGE_MODEL}`, text);
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

const STYLE_SYSTEM_PROMPT = `You describe an art style so an image model that has never heard of it can paint in it. You are given a style reference: a show, game, artist, era, technique or medium.

Recall what that reference actually looks like, and describe what sets it apart from its genre's generic look, not what every work in the genre shares. Cover: line work (weight, colour, clean or rough, hatching, or none), colour and shading (flat, cel steps, gradients, washes, solid black shadow shapes, dithering), texture and medium marks (brush strokes, paper grain, pixels, clay, glass leading, print grain), palette and lighting.

The description is for painting separate cut-out character parts on a plain background, so:
- Describe only how the subject's own surfaces are rendered. Never mention paper, canvas, a background or anything around the subject, and leave out effects that happen off the subject: speed lines, motion lines, glows, auras, mist, sparkles, splatter.
- Keep it in colour, with the reference's own palette, unless the reference is a medium that has no colour (charcoal, graphite, ink wash) or says black and white. For a comic or manga usually printed in black and white, describe its colour version (its anime adaptation or colour pages).

Write one or two sentences, at most 400 characters, as visual traits only: no names of the reference, its creators or characters, and nothing about subjects or story. Reply with the description only, no quotes or preamble.`;

/**
 * Asks Muse Spark to describe a style reference's look in paint terms, on its own. Inside the
 * remix plan, Spark described "Black Clover" as clean generic anime, the opposite of the pages'
 * gritty rendering; asked about the reference alone, it recalls its rough inking and black
 * shadows. Returns null when the reply is unusable.
 */
export async function describeStyle(reference: string, signal: AbortSignal): Promise<string | null> {
  logPrompt(`chat/completions (${MUSE_MODEL}) describe style`, reference);
  const res = await aiFetch(`${META_API_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey()}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MUSE_MODEL,
      messages: [
        { role: "system", content: STYLE_SYSTEM_PROMPT },
        { role: "user", content: `Style reference: ${reference}` },
      ],
    }),
    timeoutMs: MUSE_TIMEOUT_MS,
    signal,
  });
  if (!res.ok) {
    console.error(`Muse style request failed (${res.status}) with ${MUSE_MODEL}`, await res.text());
    return null;
  }
  const content = getPath(await readJson(res, "describe style", MUSE_MODEL), ["choices", 0, "message", "content"]);
  if (typeof content !== "string") return null;
  const look = content.replace(/^["'`\s]+|["'`\s]+$/g, "").replace(/\s+/g, " ").trim().slice(0, 600);
  if (look.length < 20) return null;
  logPrompt(`chat/completions (${MUSE_MODEL}) style`, look);
  return look;
}

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
    console.error(`Muse reword request failed (${res.status}) with ${MUSE_MODEL}`, await res.text());
    return null;
  }
  const content = getPath(await readJson(res, "reword for content policy", MUSE_MODEL), ["choices", 0, "message", "content"]);
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
5. Keep each part's orientation. Read it from the picture: which end is held or joins the body (a weapon's handle, a limb's joint end) and where the other end points. State it for every part whose shape changes, in picture terms, e.g. "grip and pommel at the bottom left where the handle ends, blade pointing up to the top right". The new part's held or joined end goes where the old one's is; never flip or reverse it.
6. Match the rest of the character. Start with one sentence describing its art style in paint terms (line weight, shading, colour, amount of texture, lighting), and use its materials and palette unless the request says otherwise. The description of the rest of the character was written for the whole sprite sheet: ignore any positions or part lists in it.
7. Paintable language only, imperative voice, one paragraph, at most 900 characters. Nothing about the model, the rig, the atlas or the background.
8. When the user message names an off-limits colour, the flat shapes in that colour are other parts sharing this space, not parts to repaint: never describe or restyle them. Shape each new part to fit the room around them; where the request needs more room (a sword for an axe), bend, angle or shorten the new part rather than cross them, keeping its held end in place (rule 5).

Reply with JSON only, no markdown: {"editPrompt": "..."}`;

export interface PartFixPlanInput {
  /** The packed parts as Muse Image will see them. */
  image: string;
  background: string;
  /** Colour of the flat shapes standing for other parts that share the space, or null when there are none. */
  offLimits: string | null;
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
    input.offLimits ? `Off-limits: flat solid ${input.offLimits} shapes` : "",
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
    console.error(`Muse part-fix plan request failed (${res.status}) with ${MUSE_MODEL}`, await res.text());
    return null;
  }
  const content = getPath(await readJson(res, "part fix plan", MUSE_MODEL), ["choices", 0, "message", "content"]);
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

/** What Muse Spark took from the user's reference image, in paint terms. */
export interface ReferenceLook {
  /** Colours, materials, costume and details to carry over onto the character. */
  look: string;
  /** The reference's art style in paint terms when it differs from the pages' rendering, else null. */
  style: string | null;
}

const REFERENCE_SYSTEM_PROMPT = `You are the art director for 2D game assets. A user wants to repaint a rigged character's sprite parts to look like a reference image they uploaded. You are given two images: first the reference image, then one atlas page of the character as it looks now (separate cut-out body parts on a plain solid-colour background; ignore that background). The user message has the user's request, which may be empty.

Describe what to take from the reference, so an image model that never sees it can repaint the character's parts to match. It only ever paints the character's own parts, which keep their shapes.

- look: the reference subject's colours (named precisely, e.g. "deep teal", "burnt orange", "off-white", with which areas carry them), materials and surfaces (cloth, leather, metal, fur, scales, skin), costume or armour pieces, patterns, trims, emblems and other distinctive motifs. Say where on a body each sits (head, hair, torso, arms, hands, legs, feet, held weapon or prop). Leave out the reference's background, scene, pose, framing, lighting effects and any text or logos. If the request says to take only part of the reference (just its colours, just the outfit, just the style), describe only that. Two to four sentences, at most 700 characters.
- style: compare how the two images are rendered, ignoring subject and colour. Null when they share a rendering family (e.g. both detailed painted fantasy art, both pixel art, both cel-shaded cartoon), even if details differ; also null when the reference is a photo or 3D render, or when the request says to keep the character's style. When unsure, null. Only when the rendering clearly differs (e.g. flat cartoon versus painted, pixel art versus smooth, ink sketch versus full colour), write one or two sentences, at most 400 characters, describing how the reference is rendered so a painter could match it: line work (weight, colour, clean or rough, or none), colour and shading (flat, cel steps, gradients, washes, hatching, dithering), texture and medium marks (brush strokes, pixels, grain), palette and lighting. Describe the subject's own surfaces only, never the background or effects around it.

Name no characters, franchises, artists or brands: visual traits only.

Reply with JSON only, no markdown: {"look": "...", "style": "..." or null}`;

/**
 * Asks Muse Spark what to take from the user's reference image: its look, and its art style if
 * that differs from the rig's. It runs on its own before the plan, like describeStyle, so the
 * reference gets Spark's full attention. Returns null when the reply is unusable.
 */
export async function describeReference(
  referenceImage: string,
  pageImage: string,
  request: string,
  signal: AbortSignal,
): Promise<ReferenceLook | null> {
  logPrompt(`chat/completions (${MUSE_MODEL}) describe reference + 2 images`, request);
  const res = await aiFetch(`${META_API_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey()}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MUSE_MODEL,
      messages: [
        { role: "system", content: REFERENCE_SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: `Request: ${request}` },
            { type: "image_url", image_url: { url: referenceImage } },
            { type: "image_url", image_url: { url: pageImage } },
          ],
        },
      ],
    }),
    timeoutMs: MUSE_TIMEOUT_MS,
    signal,
  });
  if (!res.ok) {
    console.error(`Muse reference request failed (${res.status}) with ${MUSE_MODEL}`, await res.text());
    return null;
  }
  const content = getPath(await readJson(res, "describe reference", MUSE_MODEL), ["choices", 0, "message", "content"]);
  if (typeof content !== "string") return null;
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  let parsed: unknown;
  try {
    parsed = start >= 0 && end > start ? JSON.parse(content.slice(start, end + 1)) : null;
  } catch {
    return null;
  }
  const look = getPath(parsed, ["look"]);
  const style = getPath(parsed, ["style"]);
  const cleanLook = typeof look === "string" ? look.replace(/\s+/g, " ").trim().slice(0, 900) : "";
  if (cleanLook.length < 20) return null;
  const cleanStyle = typeof style === "string" ? style.replace(/\s+/g, " ").trim().slice(0, 600) : "";
  const result = { look: cleanLook, style: cleanStyle.length >= 20 ? cleanStyle : null };
  logPrompt(`chat/completions (${MUSE_MODEL}) reference`, JSON.stringify(result, null, 2));
  return result;
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

/** One problem an inspector found, with the fix in paint terms. */
export interface InspectionIssue {
  /** Atlas region the problem is in, from the list the inspector was given, or null for the whole character. */
  part: string | null;
  problem: string;
  /** What to paint instead, written for the image model. */
  fix: string;
}

/** An inspector's verdict on a painted remix (see inspectStyle and inspectRig). */
export interface Inspection {
  /** score >= SHIP_SCORE. */
  pass: boolean;
  /** 0–1: how well the remix does on this check. Ranks the attempts when none pass. */
  score: number;
  summary: string;
  issues: InspectionIssue[];
}

/**
 * The quality bar: a check passes at this score, and a remix ships without a warning only when
 * every check passed. Pass is worked out from the score, not asked for, so the two can't disagree.
 * On the first eight v3 jobs, every score Spark called a pass was 0.88 or more and every fail 0.65
 * or less; job_5247d4f1 shipped a split head at style 0.6 (2026-10-30).
 */
export const SHIP_SCORE = 0.7;
const MAX_ISSUES = 8;
/** Tries per inspection; a failed or unusable reply is asked again once before the check counts as unchecked. */
const INSPECT_ATTEMPTS = 2;

const INSPECTION_REPLY = `Reply with JSON only, no markdown: {"score": 0.0 to 1.0, "summary": "...", "issues": [{"part": "..." or null, "problem": "...", "fix": "..."}]}
- score: 1.0 is exactly right. ${SHIP_SCORE} is good enough to ship: nothing in the issues list would bother a player, though small nitpicks may remain. Below 0.5 is clearly wrong.
- summary: one sentence.
- issues: at most ${MAX_ISSUES}, most important first, empty when there is nothing to fix. problem says what is wrong and where; fix says what to paint instead in concrete visual terms (colours, materials, surfaces), at most 200 characters, written as an instruction to a painter.
- Every part is a fixed cut-out: the painter can only repaint inside its original shape (as in the before image), filling it fully. A fix may say what the piece is and how to paint it ("paint this shin piece as wrapped green goblin skin, filling its whole shape"), never ask to add a piece that isn't there (a foot on a shin, a hand on an arm), move a part, or change its outline.`;

const STYLE_INSPECT_SYSTEM_PROMPT = `You are the art director checking a repainted 2D game character before it ships. The character is a Spine rig: separate cut-out parts assembled on a plain solid-colour background (ignore the background). An image model repainted its parts to a new look the user asked for.

You are given: first the character as it looked before, then the repainted character, and, when the user uploaded one, their reference image last. The user message has the request and the look that was planned for it.

Judge the look only, not how the parts join (another check does that):
- Does the repainted character match the requested look: the colours, materials, costume and details asked for?
- If a target art style is given, is every part rendered in it (line work, shading, texture), with none of the old rendering left? Parts still in the old style are a failure.
- If Keep palette is on, are the original colours kept?
- Is it still recognisably the same character (silhouette, species features), unless the request changes identity?
- Do all parts look like one consistent character, not a mix of styles or colour schemes?
- With a reference image: does it carry the reference's colours, materials and motifs?
- Is it free of painting artifacts? Look closely for thin stray lines or streaks, hard seams or dividing lines painted across a part (e.g. a straight line drawn where a "half fire, half water" split meets, instead of the two blending or meeting naturally), smudges, noise, blotches of flat colour, and text. An effect the request asks for (flames, smoke) is fine; a line that only marks where two looks meet is an artifact. Name the part each artifact is on; artifacts are a failure even when the look is right.

Give a part only when the problem is in one place, naming it from the Parts list; otherwise null.

${INSPECTION_REPLY}`;

const RIG_INSPECT_SYSTEM_PROMPT = `You are the rigging lead checking a repainted 2D game character before it ships. The character is a Spine rig: separate cut-out parts (atlas regions) assembled into one character on a plain solid-colour background (ignore the background). An image model repainted each part on its own, so parts can come out wrong once they are put together.

You are given: first the character as it looked before, then the repainted character, both assembled in the same pose. The user message lists the parts and the requested look.

Judge how the assembled character holds together, not whether the look is right (another check does that):
- Every part reads as the right piece where it sits: no face painted inside a helmet or on a torso, no hand or foot painted onto a limb segment, no extra eyes, limbs or heads.
- Neighbouring parts match where they join: the same material and colour across a joint, matching left and right sides, no seams that change colour or style abruptly.
- Nothing is missing, blank, left in its old look, or covered in a flat key colour (magenta, green, blue) fringe or blotch.
- Nothing is cut off, drawn in the wrong place, or clearly the wrong size compared with the before image.

Name the part for every issue you can pin down, using the exact name from the Parts list; use null only when the whole character is wrong.

${INSPECTION_REPLY}`;

/** What the inspectors are told about the remix. */
export interface InspectionContext {
  prompt: string;
  /**
   * The original plan's edit prompt, not a revised one, so every round is judged against the same
   * brief and their scores compare.
   */
  editPrompt: string;
  /** The target art style in paint terms, or null when the remix keeps the pages' style. */
  styleLook: string | null;
  /** What to take from the user's reference image, when there is one. */
  referenceLook: string | null;
  keepPalette: boolean;
  /** Atlas region names the inspectors may blame. */
  parts: string[];
  /** Parts the model drew bigger than their slot, scaled down to fit (rig check only). */
  shrunk?: { part: string; scale: number }[];
}

/**
 * Asks Muse Spark whether the repainted rig has the look the user asked for. `before` and `after`
 * are the assembled character before and after (see render.ts) as data URLs. Returns null when the
 * reply is unusable.
 */
export async function inspectStyle(
  context: InspectionContext,
  before: string,
  after: string,
  referenceImage: string | null,
  signal: AbortSignal,
): Promise<Inspection | null> {
  const request = [
    `Requested look: ${context.prompt}`,
    `Planned look: ${context.editPrompt}`,
    context.styleLook ? `Target art style: ${context.styleLook}` : "Target art style: keep the original art style",
    context.referenceLook ? `From the reference image: ${context.referenceLook}` : "",
    `Keep palette: ${context.keepPalette ? "on" : "off"}`,
    `Parts: ${context.parts.slice(0, 150).join(", ")}`,
  ]
    .filter(Boolean)
    .join("\n");
  return inspect("style", STYLE_INSPECT_SYSTEM_PROMPT, request, [before, after, ...(referenceImage ? [referenceImage] : [])], context.parts, signal);
}

/** Asks Muse Spark whether the repainted parts hold together as one character. See inspectStyle. */
export async function inspectRig(context: InspectionContext, before: string, after: string, signal: AbortSignal): Promise<Inspection | null> {
  const shrunk = context.shrunk ?? [];
  const request = [
    `Requested look: ${context.prompt}`,
    `Parts:\n${context.parts.slice(0, 150).join("\n")}`,
    shrunk.length
      ? `These parts came out bigger than their slot and were scaled down to fit: ${shrunk.map((s) => `${s.part} (${Math.round(s.scale * 100)}%)`).join(", ")}. Check they still look the right size next to their neighbours.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  return inspect("rig", RIG_INSPECT_SYSTEM_PROMPT, request, [before, after], context.parts, signal);
}

async function inspect(
  kind: string,
  system: string,
  request: string,
  images: string[],
  parts: string[],
  signal: AbortSignal,
): Promise<Inspection | null> {
  logPrompt(`chat/completions (${MUSE_MODEL}) inspect ${kind} + ${images.length} image(s)`, request);
  const body = JSON.stringify({
    model: MUSE_MODEL,
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: [{ type: "text", text: request }, ...images.map((url) => ({ type: "image_url", image_url: { url } }))],
      },
    ],
  });
  for (let attempt = 1; attempt <= INSPECT_ATTEMPTS; attempt++) {
    try {
      const res = await aiFetch(`${META_API_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey()}`, "content-type": "application/json" },
        body,
        timeoutMs: MUSE_TIMEOUT_MS,
        signal,
      });
      if (!res.ok) {
        console.error(`Muse ${kind} inspection failed (${res.status}) with ${MUSE_MODEL}, attempt ${attempt}`, await res.text());
        continue;
      }
      const content = getPath(await readJson(res, `inspect ${kind}`, MUSE_MODEL), ["choices", 0, "message", "content"]);
      const inspection = typeof content === "string" ? parseInspection(content, parts) : null;
      if (inspection) {
        logPrompt(`chat/completions (${MUSE_MODEL}) ${kind} inspection`, JSON.stringify(inspection, null, 2));
        return inspection;
      }
      console.warn(`Muse returned an unusable ${kind} inspection, attempt ${attempt}`);
    } catch (error) {
      // The job's deadline ends the job; a timeout or network error on this call is tried again.
      signal.throwIfAborted();
      console.warn(`Muse ${kind} inspection errored, attempt ${attempt}`, error);
    }
  }
  return null;
}

/** Spark's reply as an Inspection, or null when it isn't one. Part names it made up become null. */
function parseInspection(content: string, parts: string[]): Inspection | null {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  let parsed: unknown;
  try {
    parsed = start >= 0 && end > start ? JSON.parse(content.slice(start, end + 1)) : null;
  } catch {
    return null;
  }
  const score = getPath(parsed, ["score"]);
  const summary = getPath(parsed, ["summary"]);
  const rawIssues = getPath(parsed, ["issues"]);
  if (typeof score !== "number" || !Number.isFinite(score)) return null;
  const known = new Set(parts);
  const clean = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
  const issues = (Array.isArray(rawIssues) ? rawIssues : []).slice(0, MAX_ISSUES).flatMap((issue): InspectionIssue[] => {
    const part = getPath(issue, ["part"]);
    const problem = clean(getPath(issue, ["problem"]), 300);
    const fix = clean(getPath(issue, ["fix"]), 300);
    if (!problem || !fix) return [];
    return [{ part: typeof part === "string" && known.has(part) ? part : null, problem, fix }];
  });
  const clamped = Math.min(1, Math.max(0, score));
  return { pass: clamped >= SHIP_SCORE, score: clamped, summary: clean(summary, 300), issues };
}

const REVISE_SYSTEM_PROMPT = `You are the art director for 2D game assets. You wrote instructions (the editPrompt) for an image-editing model that repaints the sprite sheet of a rigged Spine character: separate cut-out body parts packed on a plain solid-colour background (ignore the background). The repainted character was put together and rejected by a reviewer.

You are given: the atlas page(s) the model repaints, then the rejected character assembled from its repainted parts. The user message has the request, your editPrompt, the Parts list (each part's page and position as percentages of the page image, x from the left, y from the top), the reviewer's issues and, after more than one rejection, your earlier editPrompts with the issues each was rejected for.

Rewrite the editPrompt so the next repaint fixes the issues:
- Work out from the Parts list and the images which piece on the page each issue is about, and name it in the editPrompt by what it is and where it sits on the page (e.g. "the long shin piece at top left"). Most problems come from a piece being mistaken for something else (a leg piece painted as part of a helmet); say clearly what each such piece is.
- Keep everything the reviewer didn't flag as it was asked for before.
- Don't bring back wording from an earlier editPrompt that was rejected for the problem it caused; an issue fixed before must stay fixed.
- Every part keeps its shape and position. Only describe paint inside each part, filling it fully; never ask for new pieces, extra limbs, feet or hands, or changed outlines, even if a reviewer note asks for one.
- Same form as before: one paragraph, imperative voice, specific paintable language, at most 1000 characters. Don't include the art style sentence; it's added for you.

Reply with JSON only, no markdown: {"editPrompt": "..."}`;

/** An edit prompt an inspector rejected, with its issues, for revisePlan. */
export interface RejectedPrompt {
  editPrompt: string;
  issues: InspectionIssue[];
}

/**
 * Asks Muse Spark to rewrite its edit prompt after an inspector rejected the result, so the next
 * repaint changes what the image model is told rather than repeating it. `pageImages` are the
 * atlas pages as the planner saw them, `rejected` the assembled character (see render.ts), and
 * `input.earlier` the edit prompts rejected before this one, oldest first. Returns null when the
 * reply is unusable.
 */
export async function revisePlan(
  input: { prompt: string; editPrompt: string; parts: string[]; issues: InspectionIssue[]; earlier: RejectedPrompt[] },
  pageImages: string[],
  rejected: string,
  signal: AbortSignal,
): Promise<string | null> {
  const issueLines = (issues: InspectionIssue[]) => issues.map((i) => `- ${i.part ? `${i.part}: ` : ""}${i.problem} Fix: ${i.fix}`).join("\n");
  const request = [
    `Requested look: ${input.prompt}`,
    `Your editPrompt: ${input.editPrompt}`,
    `Parts:\n${input.parts.slice(0, 120).join("\n")}`,
    `Reviewer's issues:\n${issueLines(input.issues)}`,
    ...input.earlier.map((e, n) => `Earlier editPrompt ${n + 1}, also rejected: ${e.editPrompt}\nIts issues:\n${issueLines(e.issues)}`),
  ].join("\n");
  logPrompt(`chat/completions (${MUSE_MODEL}) revise plan + ${pageImages.length + 1} image(s)`, request);
  const res = await aiFetch(`${META_API_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey()}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MUSE_MODEL,
      messages: [
        { role: "system", content: REVISE_SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: request },
            ...[...pageImages, rejected].map((url) => ({ type: "image_url", image_url: { url } })),
          ],
        },
      ],
    }),
    timeoutMs: MUSE_TIMEOUT_MS,
    signal,
  });
  if (!res.ok) {
    console.error(`Muse plan revision failed (${res.status}) with ${MUSE_MODEL}`, await res.text());
    return null;
  }
  const content = getPath(await readJson(res, "revise plan", MUSE_MODEL), ["choices", 0, "message", "content"]);
  if (typeof content !== "string") return null;
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  let parsed: unknown;
  try {
    parsed = start >= 0 && end > start ? JSON.parse(content.slice(start, end + 1)) : null;
  } catch {
    return null;
  }
  const editPrompt = getPath(parsed, ["editPrompt"]);
  const clean = typeof editPrompt === "string" ? editPrompt.replace(/\s+/g, " ").trim().slice(0, 1200) : "";
  if (clean.length < 20) return null;
  logPrompt(`chat/completions (${MUSE_MODEL}) revised plan`, clean);
  return clean;
}

/** One Meta API call's token use, from the response's `usage` (absent fields are 0). */
export interface ModelCall {
  call: string;
  model: string;
  /** When the response arrived, ISO 8601. */
  at: string;
  promptTokens: number;
  completionTokens: number;
  /** Part of completionTokens: Spark's thinking before it answers. */
  reasoningTokens: number;
  cachedTokens: number;
  totalTokens: number;
  /** False when the response had no `usage`, so the counts are unknown rather than 0. */
  reported: boolean;
}

/** The calls of the job whose async context this runs in (see recordModelCalls). */
const modelCalls = new AsyncLocalStorage<ModelCall[]>();

/** Runs `task`, recording every Meta API call it makes, even from nested helpers like part fixes, into `calls`. */
export function recordModelCalls<T>(calls: ModelCall[], task: () => Promise<T>): Promise<T> {
  return modelCalls.run(calls, task);
}

/** The current job's calls so far, or null outside recordModelCalls. */
export function currentModelCalls(): ModelCall[] | null {
  return modelCalls.getStore() ?? null;
}

/** Token totals over `calls`. */
export function totalUsage(calls: ModelCall[]) {
  const sum = (key: "promptTokens" | "completionTokens" | "reasoningTokens" | "cachedTokens" | "totalTokens") =>
    calls.reduce((n, c) => n + c[key], 0);
  return {
    calls: calls.length,
    unreported: calls.filter((c) => !c.reported).length,
    promptTokens: sum("promptTokens"),
    completionTokens: sum("completionTokens"),
    reasoningTokens: sum("reasoningTokens"),
    cachedTokens: sum("cachedTokens"),
    totalTokens: sum("totalTokens"),
  };
}

/** Reads a Meta API response body and records its token use for the current job. */
async function readJson(res: { json(): Promise<unknown> }, call: string, model: string): Promise<unknown> {
  const body: unknown = await res.json();
  const num = (path: string[]) => {
    const v = getPath(body, ["usage", ...path]);
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  };
  const entry: ModelCall = {
    call,
    model,
    at: new Date().toISOString(),
    promptTokens: num(["prompt_tokens"]),
    completionTokens: num(["completion_tokens"]),
    reasoningTokens: num(["completion_tokens_details", "reasoning_tokens"]),
    cachedTokens: num(["prompt_tokens_details", "cached_tokens"]),
    totalTokens: num(["total_tokens"]),
    reported: typeof getPath(body, ["usage"]) === "object" && getPath(body, ["usage"]) !== null,
  };
  currentModelCalls()?.push(entry);
  console.log(`[meta] ${call} (${model}) tokens: ${entry.reported ? `${entry.promptTokens} in, ${entry.completionTokens} out (${entry.reasoningTokens} reasoning)` : "not reported"}`);
  return body;
}

/** A part the tweak reviewer may change, as numbered on the images. */
export interface TweakPart {
  id: number;
  slot: string;
  /** Atlas region it shows. */
  region: string;
  /** How its fix was found (see tweak.ts measureFixes). */
  status: "measured" | "shrunk" | "reshaped" | "aligned" | "unmeasured";
  /** The measured fix, for "measured" and "shrunk" parts. */
  fix: { x: number; y: number; scale: number; rotate: number } | null;
}

export interface TweakReview {
  /** Each part's final tweak; parts left out keep no tweak. */
  changes: { slot: string; x: number; y: number; scale: number; rotate: number; reason: string }[];
  notes: string;
}

/** Limits on tweaks to parts without a measured fix: small nudges judged by eye. */
const NUDGE_LIMITS = { move: 4, scaleMin: 0.9, scaleMax: 1.1, rotate: 10 };

const TWEAK_SYSTEM_PROMPT = `You are a 2D animation rigger finishing a Spine character whose textures were repainted by an image model. The skeleton is unchanged; only the pixels inside each part were repainted, and the image model sometimes shifts or resizes what it paints, so parts no longer meet the way they did.

You get three images of the same pose, with a numbered tag on each part; orange tags are parts with a measured fix:
1. ORIGINAL: the rig as the artist made it. This is the target for how parts fit together.
2. REMIX NOW: the repainted rig, untweaked.
3. REMIX + MEASURED FIXES: the repainted rig with every measured fix applied.
The user message maps numbers to part names and gives each part's status and fix.

Statuses:
- measured: same shape as the original; the fix moves and scales it back to where the original's pixels were. These numbers are exact; prefer them.
- shrunk: the part came out too big for its slot in the texture and was shrunk to fit; the fix scales it back up, keeping its middle in place.
- reshaped: the remix gave it a new shape on purpose (a new helmet, a different head), so nothing could be measured.
- aligned: it already matches the original.
- unmeasured: too small to measure.

Your job: decide each part's final tweak so the remix fits together like the original: joints meet, nothing floats or leaves a gap, a head sits on its neck and under its helmet, held items sit in the hand, sizes look right next to the neighbours.
- Accept a fix by copying its numbers. You may adjust a fixed part a little if image 3 shows it's slightly off (e.g. a shrunk head that should sit a bit lower on its neck).
- Drop a fix by leaving the part out, if image 3 looks worse than image 2 for that part.
- For a part without a fix, only add a small nudge (move at most ${NUDGE_LIMITS.move}, scale ${NUDGE_LIMITS.scaleMin} to ${NUDGE_LIMITS.scaleMax}, rotate at most ${NUDGE_LIMITS.rotate}) when image 2 shows a clear misfit.
- Leave out every part that should stay untweaked. Don't restyle anything.

Units: x and y are percent of the character's size as seen in the image (+x right, +y up). scale is a multiplier (1 = unchanged). rotate is degrees counter-clockwise. Values are each part's total tweak from the untweaked remix.

Reply with JSON only, no markdown: {"changes": [{"part": <number>, "x": 0, "y": 0, "scale": 1, "rotate": 0, "reason": "<at most 12 words>"}], "notes": "<one sentence on what you kept, dropped or nudged>"}`;

/**
 * Asks Muse Spark which measured fixes to keep, and for any small nudges it can see: one call, as
 * auto-tweak does in the app. The images are tagged drawings (see render.ts drawRig) as data URLs:
 * the original, the untweaked remix, and the remix with the measured fixes. Returns null when the
 * reply is unusable.
 */
export async function reviewTweaks(
  parts: TweakPart[],
  images: { original: string; remix: string; fixed: string },
  signal: AbortSignal,
): Promise<TweakReview | null> {
  const fmt = (t: NonNullable<TweakPart["fix"]>) => `x ${t.x}, y ${t.y}, scale ${t.scale}, rotate ${t.rotate}`;
  const request = [
    "Parts (number: slot, atlas region; status; fix):",
    ...parts.map((p) => [`${p.id}: ${p.slot}, ${p.region}`, p.status, p.fix ? `fix ${fmt(p.fix)}` : null].filter(Boolean).join("; ")),
  ].join("\n");
  logPrompt(`chat/completions (${MUSE_MODEL}) review tweaks + 3 images`, request);
  const res = await aiFetch(`${META_API_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey()}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MUSE_MODEL,
      messages: [
        { role: "system", content: TWEAK_SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: request },
            ...[images.original, images.remix, images.fixed].map((url) => ({ type: "image_url", image_url: { url } })),
          ],
        },
      ],
    }),
    timeoutMs: MUSE_TIMEOUT_MS,
    signal,
  });
  if (!res.ok) {
    console.error(`Muse tweak review failed (${res.status}) with ${MUSE_MODEL}`, await res.text());
    return null;
  }
  const content = getPath(await readJson(res, "review tweaks", MUSE_MODEL), ["choices", 0, "message", "content"]);
  const review = typeof content === "string" ? parseTweakReview(content, parts) : null;
  if (review) logPrompt(`chat/completions (${MUSE_MODEL}) tweak review`, JSON.stringify(review, null, 2));
  else console.warn("Muse returned an unusable tweak review");
  return review;
}

/**
 * Spark's reply is untrusted: keep only known parts and clamp every value. A part with a fix may
 * move up to 2 points past it either way; others only by NUDGE_LIMITS.
 */
function parseTweakReview(content: string, parts: TweakPart[]): TweakReview | null {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  let parsed: unknown;
  try {
    parsed = start >= 0 && end > start ? JSON.parse(content.slice(start, end + 1)) : null;
  } catch {
    return null;
  }
  const changes = getPath(parsed, ["changes"]);
  if (!Array.isArray(changes)) return null;
  const byId = new Map(parts.map((p) => [p.id, p]));
  const seen = new Set<number>();
  const clamp = (v: number, min: number, max: number) => Math.round(Math.min(Math.max(v, min), max) * 100) / 100;
  const out: TweakReview["changes"] = [];
  for (const c of changes) {
    const id = getPath(c, ["part"]);
    const part = typeof id === "number" ? byId.get(id) : undefined;
    if (!part || seen.has(part.id)) continue;
    seen.add(part.id);
    const num = (key: string, fallback: number) => {
      const v = getPath(c, [key]);
      return typeof v === "number" && Number.isFinite(v) ? v : fallback;
    };
    const f = part.fix;
    const L = NUDGE_LIMITS;
    const reason = getPath(c, ["reason"]);
    out.push({
      slot: part.slot,
      x: f ? clamp(num("x", f.x), f.x - 2, f.x + 2) : clamp(num("x", 0), -L.move, L.move),
      y: f ? clamp(num("y", f.y), f.y - 2, f.y + 2) : clamp(num("y", 0), -L.move, L.move),
      scale: f ? clamp(num("scale", f.scale), f.scale * 0.9, f.scale * 1.1) : clamp(num("scale", 1), L.scaleMin, L.scaleMax),
      rotate: clamp(num("rotate", 0), -L.rotate, L.rotate),
      reason: typeof reason === "string" ? reason.replace(/\s+/g, " ").trim().slice(0, 120) : "",
    });
  }
  const notes = getPath(parsed, ["notes"]);
  return { changes: out, notes: typeof notes === "string" ? notes.replace(/\s+/g, " ").trim().slice(0, 400) : "" };
}
