// Locale/timezone are pinned so server and client render identical strings.
const dateFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

export function formatDate(iso: string) {
  return dateFormat.format(new Date(iso));
}

const dateTimeFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
});

/** e.g. "Oct 29, 10:56 AM UTC". */
export function formatDateTime(iso: string) {
  return dateTimeFormat.format(new Date(iso));
}

export function formatCount(n: number) {
  return n.toLocaleString("en-US");
}

/** Where an asset came from, for the badge on its preview: the model a remix was made with, or an original upload. */
export type AssetOrigin = { kind: "remix"; model: string } | { kind: "upload" };

export function assetOrigin(asset: { remixOf: unknown }): AssetOrigin {
  // Muse is the only model for now; read it from the asset once there's more than one.
  return asset.remixOf ? { kind: "remix", model: "Muse AI" } : { kind: "upload" };
}
