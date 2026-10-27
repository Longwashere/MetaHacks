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

export function formatCount(n: number) {
  return n.toLocaleString("en-US");
}
