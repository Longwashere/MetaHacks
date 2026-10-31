// SEO helpers shared by route `meta` exports. Pure functions — safe on client and server.
import type { MetaDescriptor } from "react-router";
import type { AssetCategory, SpineAnimation, SpineAsset } from "~/lib/types";

export const SITE_NAME = "RigForge";

/** Clip names → how people actually search for them ("monk walking", not "monk walk"). */
const ANIMATION_LABELS: Record<string, string> = {
  idle: "Idle",
  walk: "Walking",
  run: "Running",
  jump: "Jumping",
  attack: "Attack",
  hit: "Hit Reaction",
  death: "Death",
  spin: "Spinning",
  open: "Opening",
  burst: "Burst",
  loop: "Loop",
  hover: "Hover",
  press: "Press",
  heal: "Healing",
  collect: "Collect",
  meditate: "Meditating",
  shoot: "Shooting",
  roar: "Roar",
  blink: "Blinking",
  bounce: "Bouncing",
  hoverboard: "Hoverboard",
  portal: "Portal",
  "gun-grab": "Gun Grab",
  animation: "Spinning",
};

export function animationLabel(name: string) {
  const known = ANIMATION_LABELS[name] ?? ANIMATION_LABELS[name.toLowerCase()];
  if (known) return known;
  // Raw clip names from imported rigs: "1_LobbyRun" → "Lobby Run", "Skill_1" → "Skill 1", "2_1Walk" → "Walking".
  const words = name
    .replace(/^[\d_]+/, "")
    .replace(/([a-z])([A-Z\d])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  if (!words) return name;
  return ANIMATION_LABELS[words.toLowerCase()] ?? words.charAt(0).toUpperCase() + words.slice(1);
}

const CATEGORY_LABELS: Record<string, [singular: string, plural: string]> = {
  character: ["Character", "Characters"],
  creature: ["Creature", "Creatures"],
  effect: ["Effect", "Effects"],
  prop: ["Prop", "Props"],
  ui: ["UI", "UI Elements"],
};

export function categoryLabel(category: AssetCategory, plural = false) {
  const known = CATEGORY_LABELS[category];
  if (known) return known[plural ? 1 : 0];
  // Categories Muse added ("vehicle", "sea-creature"): title-cased, with a plain plural.
  const label = category.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  if (!plural) return label;
  return /(s|x|ch|sh)$/.test(label) ? `${label}es` : /[^aeiou]y$/.test(label) ? `${label.slice(0, -1)}ies` : `${label}s`;
}

export function assetPath(asset: Pick<SpineAsset, "id">, animation?: string) {
  return animation ? `/assets/${asset.id}/${encodeURIComponent(animation)}` : `/assets/${asset.id}`;
}

/** One-sentence, keyword-rich description built from asset metadata. */
export function describeAsset(asset: SpineAsset, animation?: SpineAnimation) {
  const kind = `${asset.style} Spine2D ${categoryLabel(asset.category).toLowerCase()}`;
  if (animation) {
    return `${asset.name} ${animationLabel(animation.name).toLowerCase()} animation — a ${
      animation.loop ? "looping" : "one-shot"
    } ${animation.durationSec.toFixed(1)}s clip for this ${kind}. Preview it in the browser and download the Spine ${asset.spineVersion} skeleton, atlas and textures.`;
  }
  const clips = asset.animations.map((a) => animationLabel(a.name).toLowerCase()).join(", ");
  const origin = asset.remixOf ? ` Re-textured remix of ${asset.remixOf.name}.` : " Remixable — re-texture it from a prompt.";
  return `${asset.name}: ${asset.description} A rigged ${kind} with ${asset.animations.length} animations (${clips}).${origin} Free to preview and download for Spine ${asset.spineVersion}.`;
}

interface SeoInput {
  title: string;
  description: string;
  /** Absolute URL. */
  canonical: string;
  /** Set false for private, filtered or search-result pages. */
  index?: boolean;
  image?: string | null;
  type?: "website" | "article";
  jsonLd?: object[];
}

export function seoMeta({ title, description, canonical, index = true, image, type = "website", jsonLd = [] }: SeoInput): MetaDescriptor[] {
  const desc = description.length > 160 ? `${description.slice(0, 157).trimEnd()}…` : description;
  return [
    { title },
    { name: "description", content: desc },
    { name: "robots", content: index ? "index, follow" : "noindex, follow" },
    { tagName: "link", rel: "canonical", href: canonical },
    { property: "og:site_name", content: SITE_NAME },
    { property: "og:type", content: type },
    { property: "og:title", content: title },
    { property: "og:description", content: desc },
    { property: "og:url", content: canonical },
    ...(image ? [{ property: "og:image", content: image }] : []),
    { name: "twitter:card", content: image ? "summary_large_image" : "summary" },
    { name: "twitter:title", content: title },
    { name: "twitter:description", content: desc },
    ...jsonLd.map((data) => ({ "script:ld+json": data })),
  ];
}

export function breadcrumbJsonLd(siteUrl: string, crumbs: { name: string; path: string }[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: c.name,
      item: `${siteUrl}${c.path}`,
    })),
  };
}

export function assetJsonLd(siteUrl: string, asset: SpineAsset, animation?: SpineAnimation) {
  const url = `${siteUrl}${assetPath(asset, animation?.name)}`;
  const name = animation ? `${asset.name} ${animationLabel(animation.name)} Animation` : asset.name;
  return {
    "@context": "https://schema.org",
    "@type": "CreativeWork",
    "@id": url,
    url,
    name,
    headline: `${name} – Spine2D ${categoryLabel(asset.category)}`,
    description: describeAsset(asset, animation),
    keywords: [
      "spine2d",
      "spine animation",
      categoryLabel(asset.category).toLowerCase(),
      asset.style,
      ...asset.tags,
      ...asset.animations.map((a) => animationLabel(a.name).toLowerCase()),
    ].join(", "),
    genre: `2D ${categoryLabel(asset.category).toLowerCase()} animation`,
    encodingFormat: "application/json",
    isAccessibleForFree: true,
    dateCreated: asset.createdAt,
    author: { "@type": "Person", name: asset.author.name },
    ...(asset.thumbnailUrl ? { image: asset.thumbnailUrl } : {}),
    ...(asset.remixOf
      ? { isBasedOn: { "@type": "CreativeWork", name: asset.remixOf.name, url: `${siteUrl}${assetPath(asset.remixOf)}` } }
      : {}),
    ...(animation
      ? { isPartOf: { "@type": "CreativeWork", name: asset.name, url: `${siteUrl}${assetPath(asset)}` } }
      : {
          hasPart: asset.animations.map((a) => ({
            "@type": "CreativeWork",
            name: `${asset.name} ${animationLabel(a.name)} Animation`,
            url: `${siteUrl}${assetPath(asset, a.name)}`,
          })),
        }),
    interactionStatistic: [
      { "@type": "InteractionCounter", interactionType: "https://schema.org/DownloadAction", userInteractionCount: asset.downloads },
      { "@type": "InteractionCounter", interactionType: "https://schema.org/BookmarkAction", userInteractionCount: asset.saves },
    ],
  };
}
