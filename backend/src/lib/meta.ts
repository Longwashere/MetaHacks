import { aiFetch } from "./ai-fetch.js";
import { IMAGE_MODEL, IMAGE_TIMEOUT_MS, META_API_BASE_URL, MUSE_MODEL, MUSE_TIMEOUT_MS } from "./config.js";
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

const PLAN_SYSTEM_PROMPT = `You are the art director for 2D game assets. You are given atlas pages from a rigged Spine character: each page is a sprite sheet of separate body parts (regions) packed on a plain grey background.
An image-editing model will repaint every page into a new look. Write its instructions.
- Describe the new materials, colors, patterns and surface details for the parts you can see.
- Every part must keep exactly the same position, size, outline and pose. Only what is painted inside each part changes.
- Never ask for new parts, text, backgrounds or scenery.
Reply with JSON only, no markdown: {"name": "...", "editPrompt": "..."}
- name: 2 to 5 words naming the remixed asset, Title Case.
- editPrompt: one paragraph, at most 1000 characters.`;

/** Asks Muse Spark to turn the user's prompt into instructions for the image model. */
export async function planRemix(
  input: RemixInput,
  base: { name: string; regions: string[]; pageImages: string[] },
  signal: AbortSignal,
): Promise<RemixPlan> {
  const request = [
    `Asset: ${base.name}`,
    `Parts: ${base.regions.slice(0, 120).join(", ")}`,
    `Requested look: ${input.prompt}`,
    `Art style: ${input.style}`,
    `Change amount: ${strengthHint(input.strength)}`,
    input.keepPalette ? "Keep the original color palette; change details and materials only." : "",
  ].filter(Boolean).join("\n");

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
  if (plan) return plan;
  // Muse's reply is untrusted; if it's unusable, fall back to the user's own words.
  console.warn("Muse returned an unusable plan; using the prompt as-is.");
  return { name: `${base.name} Remix`, editPrompt: `Repaint the character as: ${input.prompt}.` };
}

function strengthHint(strength: number): string {
  if (strength < 0.34) return "subtle — keep the shading, line work and shapes; change colors and materials only";
  if (strength < 0.67) return "moderate — restyle materials and details, keep the overall character recognizable";
  return "bold — reimagine the surface details freely, but keep every part's silhouette";
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
    if (text.includes("content_policy_violation")) {
      throw new Error("The image model declined this prompt. Try describing the look differently.");
    }
    throw new Error("Couldn't paint the new textures. Try again.");
  }
}

function getPath(value: unknown, path: (string | number)[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}
