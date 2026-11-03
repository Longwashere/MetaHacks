// Tries SAM 3.1 gear masks for slicing (AUTO_RIG_PLAN.md, "Gear masks with SAM 3.1") on fixture
// images: one `POST /responses` call per phrase, all sent at once. Per image it writes, to
// test/output/autorig-sam/: one panel per phrase with every match tinted over the character, and
// logs each call's time and matches (box, confidence, mask pixels). PHRASES="a,b" sets the phrases.
//
//   npx tsx --env-file=.env src/scripts/autorig-sam.ts knight-front orc-front …
//
// A name that isn't a fixture is read as a PNG path. COMBINED=1 also sends every phrase in one
// call, to see what SAM does with a list.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { keyCutout } from "../lib/autorig/cutout.js";
import { segment as samSegment } from "../lib/autorig/gear.js";

const FIXTURES = "test/fixtures/autorig";
const OUT = "test/output/autorig-sam";
const PHRASES = (process.env.PHRASES ?? "red cape,shoulder armor,knee pad,hand,helmet plume").split(",");
const TINTS: [number, number, number][] = [
  [255, 60, 60],
  [60, 200, 255],
  [255, 220, 0],
  [60, 255, 120],
  [200, 80, 255],
  [255, 140, 0],
];
await mkdir(OUT, { recursive: true });

/** One SAM 3.1 call (gear.ts logs its usage), timed. */
async function segment(image: Buffer, width: number, height: number, phrase: string) {
  const t = Date.now();
  const matches = await samSegment(image, width, height, phrase, new AbortController().signal);
  return { phrase, ms: Date.now() - t, matches };
}

async function inputFor(name: string): Promise<{ png: Buffer; rgb: Buffer; width: number; height: number }> {
  const fixture = path.join(FIXTURES, `${name}.png`);
  const file = await readFile(fixture).catch(() => readFile(name));
  // Fixtures go through the same cutout as the app (magenta key, trimmed); the character is
  // shown on white so SAM sees plain art.
  const cut = await readFile(fixture).then(
    (f) => keyCutout(f),
    () => null,
  );
  const base = cut ? sharp(cut.rgba, { raw: { width: cut.width, height: cut.height, channels: 4 } }) : sharp(file);
  const { data, info } = await base.flatten({ background: "#ffffff" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const png = await sharp(data, { raw: { width: info.width, height: info.height, channels: 3 } }).png().toBuffer();
  return { png, rgb: data, width: info.width, height: info.height };
}

for (const name of process.argv.slice(2)) {
  const input = await inputFor(name);
  const label = path.basename(name, ".png");
  console.log(`${label}: ${input.width}×${input.height}, ${PHRASES.length} calls at once`);
  const t = Date.now();
  const calls = await Promise.allSettled(PHRASES.map((p) => segment(input.png, input.width, input.height, p)));
  console.log(`  all calls: ${Date.now() - t} ms`);
  if (process.env.COMBINED) {
    try {
      const combined = await segment(input.png, input.width, input.height, PHRASES.join(", "));
      console.log(`  combined "${combined.phrase}": ${combined.ms} ms, ${combined.matches.length} matches`);
    } catch (e) {
      console.log(`  combined: ${String(e)}`);
    }
  }

  const panels: Buffer[] = [];
  for (const [i, call] of calls.entries()) {
    if (call.status === "rejected") {
      console.log(`  ${PHRASES[i]}: FAILED ${String(call.reason)}`);
      continue;
    }
    const c = call.value;
    console.log(`  "${c.phrase}": ${c.ms} ms, ${c.matches.length} matches`);
    for (const m of c.matches) console.log(`    box ${m.box.join(",")} conf ${m.confidence?.toFixed(2) ?? "-"} pixels ${m.pixels} (${((m.pixels / (input.width * input.height)) * 100).toFixed(1)}% of image)`);

    // Panel: the character dimmed, each match in its own tint.
    const img = Buffer.from(input.rgb);
    for (let p = 0; p < input.width * input.height; p++) for (let k = 0; k < 3; k++) img[p * 3 + k] = Math.round(img[p * 3 + k] * 0.45 + 140);
    c.matches.forEach((m, mi) => {
      const tint = TINTS[mi % TINTS.length];
      for (let p = 0; p < m.mask.length; p++) if (m.mask[p]) for (let k = 0; k < 3; k++) img[p * 3 + k] = Math.round(input.rgb[p * 3 + k] * 0.4 + tint[k] * 0.6);
    });
    const caption = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${input.width}" height="60"><rect width="100%" height="100%" fill="#26282e"/><text x="12" y="42" font-family="sans-serif" font-size="34" fill="#fff">${c.phrase} (${c.matches.length})</text></svg>`,
    );
    panels.push(
      await sharp(
        await sharp(img, { raw: { width: input.width, height: input.height, channels: 3 } })
          .extend({ top: 60, background: "#26282e" })
          .composite([{ input: caption, top: 0, left: 0 }])
          .png()
          .toBuffer(),
      )
        .resize({ height: 480 })
        .png()
        .toBuffer(),
    );
  }
  const metas = await Promise.all(panels.map((p) => sharp(p).metadata()));
  const total = metas.reduce((s, m) => s + (m.width ?? 0), 0);
  await sharp({ create: { width: Math.max(1, total), height: 480, channels: 3, background: "#26282e" } })
    .composite(panels.map((input, i) => ({ input, top: 0, left: metas.slice(0, i).reduce((s, m) => s + (m.width ?? 0), 0) })))
    .png()
    .toFile(path.join(OUT, `${label}.png`));
  console.log(`  wrote ${path.join(OUT, `${label}.png`)}`);
}
