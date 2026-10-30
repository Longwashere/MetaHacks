import { ChevronRight, CircleAlert, MessageSquareText, CircleCheck, Loader2, Move, Paintbrush, PenLine, ShieldAlert, Sparkles, Trophy, Undo2, Wrench } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { SpinePreview } from "~/components/SpinePreview";
import { Badge } from "~/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { type AtlasPage, parseAtlas } from "~/lib/atlas";
import type { RemixActivity, RemixEvent, RemixIssue, RemixJob } from "~/lib/types";
import { cn } from "~/lib/utils";

// The live view of a running v2 or v3 remix (RemixJob.live): the rig redrawn as each page is painted,
// the sprite sheet with what's being worked on and what the checks flagged, and a timeline.

/** Activities that show the scanning band: something is being painted or looked at. */
const SCANNING: RemixActivity["kind"][] = ["planning", "painting", "checking-style", "checking-rig", "fixing", "revising", "tweaking"];

export function activityLabel(activity: RemixActivity): string {
  const attempt = activity.round > 1 ? ` (attempt ${activity.round})` : "";
  switch (activity.kind) {
    case "reading":
      return "Reading the rig and its atlas";
    case "reference":
      return "Muse Spark is studying your reference image";
    case "planning":
      return "Muse Spark is planning the new look";
    case "painting":
      return `Muse Image is painting ${activity.page ?? "the atlas"}${attempt}`;
    case "checking-style":
      return `Muse Spark is checking the style${attempt}`;
    case "checking-rig":
      return `Muse Spark is checking how the parts fit${attempt}`;
    case "fixing":
      return `Repainting ${activity.regions?.join(", ") || "parts"}`;
    case "revising":
      return "Muse Spark is rewriting the plan from the feedback";
    case "tweaking":
      return "Lining the parts back up";
    case "packing":
      return "Packing the atlas";
  }
}

/** The rig with the newest painted pages swapped in, so the user watches it change. */
export function RemixLivePlayer({ job, className }: { job: RemixJob; className?: string }) {
  const preview = job.live?.preview ?? null;
  const activity = job.live?.activity ?? null;
  const files = job.base.files && { ...job.base.files, skeletonUrl: preview?.skeletonUrl ?? job.base.files.skeletonUrl };
  const painted = preview !== null && Object.keys(preview.pages).length > 0;
  // Changes whenever new art lands, which replays the reveal flash.
  const revealKey = preview ? JSON.stringify(preview) : "";

  return (
    <div className={cn("relative overflow-hidden rounded-lg", className)}>
      <SpinePreview asset={{ ...job.base, files }} pageUrls={preview?.pages} showBones className={cn(!painted && "opacity-60")} />
      {activity && SCANNING.includes(activity.kind) && (
        <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
          <div className="absolute inset-x-0 h-1/3 animate-remix-scan bg-linear-to-b from-transparent via-primary/15 to-transparent" />
        </div>
      )}
      {painted && <div key={revealKey} className="pointer-events-none absolute inset-0 animate-remix-reveal bg-primary/25" aria-hidden />}
      <div className="pointer-events-none absolute top-3 left-3 flex flex-col items-start gap-1.5">
        <Badge variant="secondary" className="bg-background/85 backdrop-blur-xs">
          {painted ? versionLabel(preview.round) : "Original"}
        </Badge>
      </div>
      {activity && (
        <div className="pointer-events-none absolute inset-x-3 bottom-3 flex">
          <span className="flex min-w-0 items-center gap-1.5 rounded-full border bg-background/85 px-2.5 py-1 text-xs font-medium shadow-xs backdrop-blur-xs">
            <Loader2 className="size-3 shrink-0 animate-spin text-primary" />
            <span className="truncate">{activityLabel(activity)}</span>
          </span>
        </div>
      )}
    </div>
  );
}

/** What the version on screen is: v2 and a first v3 attempt are just "Repainted". */
function versionLabel(round: number) {
  return round > 1 ? `Attempt ${round}` : "Repainted";
}

type RegionState = "working" | "flagged" | "fixed" | "shrunk" | "idle";

const REGION_CLASS: Record<RegionState, string> = {
  working: "z-[3] border-2 border-primary bg-primary/20 animate-pulse",
  flagged: "z-[4] border-2 border-destructive bg-destructive/20",
  fixed: "z-[2] border-2 border-primary bg-primary/10",
  shrunk: "z-[1] border border-dashed border-foreground/70",
  idle: "border border-primary/30",
};

const LABEL_CLASS: Record<RegionState, string> = {
  working: "bg-primary text-primary-foreground",
  flagged: "bg-destructive text-white",
  fixed: "bg-primary text-primary-foreground",
  shrunk: "bg-background/85 text-foreground",
  idle: "",
};

/**
 * What the checks flagged: the issues of the last check, unless new art has replaced the sheet
 * since. Parts repainted by a later part fix count as fixed.
 */
function flaggedParts(events: RemixEvent[]) {
  const issues = new Map<string, RemixIssue>();
  const fixed = new Set<string>();
  for (const event of events) {
    if (event.type === "painted") {
      issues.clear();
      fixed.clear();
    } else if (event.type === "checked") {
      issues.clear();
      fixed.clear();
      for (const issue of event.issues) if (issue.part) issues.set(issue.part, issue);
    } else if (event.type === "fixed" && !event.error) {
      for (const region of event.regions) {
        issues.delete(region);
        fixed.add(region);
      }
    }
  }
  return { issues, fixed };
}

/** The atlas page as it's painted, with the parts being worked on, flagged, fixed or shrunk marked. */
export function RemixLiveSheet({ job, className }: { job: RemixJob; className?: string }) {
  const atlasUrl = job.base.files?.atlasUrl;
  const [atlas, setAtlas] = useState<{ url: string; pages: AtlasPage[] } | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const [size, setSize] = useState<{ url: string; w: number; h: number } | null>(null);

  // Region rects come from the base atlas, which every remix version keeps.
  useEffect(() => {
    if (!atlasUrl) return;
    const controller = new AbortController();
    fetch(atlasUrl, { signal: controller.signal })
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error(`${res.status}`))))
      .then((text) => setAtlas({ url: atlasUrl, pages: parseAtlas(text) }))
      .catch(() => {});
    return () => controller.abort();
  }, [atlasUrl]);

  const pages = atlas && atlas.url === atlasUrl ? atlas.pages : [];
  if (!atlasUrl || pages.length === 0) return null;

  const live = job.live;
  const events = live?.events ?? [];
  const activity = live?.activity ?? null;
  const lastPainted = lastPaint(events);
  // Follow the page being painted unless the user picked one.
  const following = activity?.page ?? lastPainted?.page ?? null;
  const page = pages.find((p) => p.name === (pinned ?? following)) ?? pages[0];
  const atlasDir = atlasUrl.slice(0, atlasUrl.lastIndexOf("/") + 1);
  const url = live?.preview?.pages[page.name] ?? atlasDir + page.name;
  const dims = size?.url === url ? size : null;
  const pageW = page.width ?? dims?.w;
  const pageH = page.height ?? dims?.h;

  const { issues, fixed } = flaggedParts(events);
  const paintingPage = activity?.kind === "painting" && activity.page === page.name;
  const working = new Set(activity?.kind === "fixing" ? activity.regions : []);
  const shrunk = new Map(lastPaint(events, page.name)?.shrunk.map((s) => [s.part, s.scale]));
  const stateOf = (region: string): RegionState =>
    working.has(region) ? "working" : issues.has(region) ? "flagged" : fixed.has(region) ? "fixed" : shrunk.has(region) ? "shrunk" : "idle";
  const titleOf = (region: string) => {
    const issue = issues.get(region);
    if (issue) return `${region}: ${issue.problem}`;
    const scale = shrunk.get(region);
    return scale ? `${region}: drawn too big, shrunk to ${Math.round(scale * 100)}% to fit` : region;
  };
  const pageIssues = page.regions.flatMap((r) => (issues.has(r.name) ? [issues.get(r.name) as RemixIssue] : []));

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>Sprite sheet</CardTitle>
        <CardDescription>
          {live?.preview?.pages[page.name] ? `${page.name}, ${versionLabel(live.preview.round).toLowerCase()}` : `${page.name}, not repainted yet`}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {pages.length > 1 && (
          <Tabs value={page.name} onValueChange={setPinned}>
            <TabsList>
              {pages.map((p, i) => (
                <TabsTrigger key={p.name} value={p.name}>
                  Page {i + 1}
                  {activity?.kind === "painting" && activity.page === p.name && <Loader2 className="animate-spin" />}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        )}
        <div className="max-h-[70vh] overflow-auto rounded-lg border bg-[repeating-conic-gradient(var(--muted)_0%_25%,var(--background)_0%_50%)] bg-size-[16px_16px]">
          <div className="relative mx-auto w-fit overflow-hidden">
            <img
              key={url}
              src={url}
              // Same CORS mode as the Spine runtime, so both share the cached response.
              crossOrigin="anonymous"
              alt={`${page.name}, ${live?.preview?.pages[page.name] ? "repainted" : "original"}`}
              onLoad={(e) => setSize({ url, w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
              className={cn("block h-auto max-w-full transition-opacity", !live?.preview?.pages[page.name] && "opacity-60")}
            />
            {paintingPage && (
              <div className="pointer-events-none absolute inset-0" aria-hidden>
                <div className="absolute inset-x-0 h-1/3 animate-remix-scan bg-linear-to-b from-transparent via-primary/25 to-transparent" />
              </div>
            )}
            {live?.preview?.pages[page.name] && <div key={url} className="pointer-events-none absolute inset-0 animate-remix-reveal bg-primary/25" aria-hidden />}
            {pageW && pageH && (
              <div className="absolute inset-0">
                {page.regions.map((r, i) => {
                  const state = paintingPage ? "working" : stateOf(r.name);
                  return (
                    <div
                      key={`${r.name}:${i}`}
                      title={titleOf(r.name)}
                      className={cn("absolute", REGION_CLASS[state])}
                      style={{
                        left: `${(r.x / pageW) * 100}%`,
                        top: `${(r.y / pageH) * 100}%`,
                        width: `${(r.width / pageW) * 100}%`,
                        height: `${(r.height / pageH) * 100}%`,
                      }}
                    >
                      {state !== "idle" && !paintingPage && (
                        <span className={cn("block w-max max-w-none px-0.5 text-[10px] leading-tight", LABEL_CLASS[state])}>{r.name}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <Legend className="border-2 border-primary bg-primary/20">Being painted</Legend>
          {/* Only v3 checks, fixes and shrinks parts. */}
          {job.apiVersion === "v3" && (
            <>
              <Legend className="border-2 border-destructive bg-destructive/20">Flagged by a check</Legend>
              <Legend className="border-2 border-primary bg-primary/10">Fixed</Legend>
              <Legend className="border border-dashed border-foreground/70">Shrunk to fit its box</Legend>
            </>
          )}
        </ul>
        {pageIssues.length > 0 && (
          <ul className="flex flex-col gap-1.5 text-sm">
            {pageIssues.map((issue) => (
              <li key={issue.part} className="flex gap-2">
                <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
                <span>
                  <span className="font-medium">{issue.part}:</span> <span className="text-muted-foreground">{issue.problem}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** The newest "painted" event, of `page` when given. */
function lastPaint(events: RemixEvent[], page?: string) {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === "painted" && (page === undefined || event.page === page)) return event;
  }
  return null;
}

function Legend({ className, children }: { className: string; children: ReactNode }) {
  return (
    <li className="flex items-center gap-1.5">
      <span className={cn("size-3 rounded-xs", className)} aria-hidden />
      {children}
    </li>
  );
}

/**
 * Everything the remix has done so far, newest first, with what it's doing now on top. Renders a
 * card's header and content, for a card (or card tab) the caller provides.
 */
export function RemixTimeline({ job }: { job: RemixJob }) {
  const events = job.live?.events ?? [];
  const activity = job.live?.activity ?? null;
  const started = new Date(job.createdAt).getTime();

  return (
    <>
      <CardHeader>
        <CardTitle>What Muse is doing</CardTitle>
        <CardDescription>
          {job.apiVersion === "v3"
            ? "Muse Spark plans the look, Muse Image paints each page, then Muse Spark checks it."
            : "Muse Spark plans the look, then Muse Image paints each page."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto pr-1">
          {activity && (
            <li className="flex gap-3 text-sm font-medium">
              <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-primary" />
              <span>{activityLabel(activity)}</span>
            </li>
          )}
          {[...events].reverse().map((event) => (
            <TimelineItem key={`${event.at}:${event.type}`} event={event} offset={(new Date(event.at).getTime() - started) / 1000} />
          ))}
          {events.length === 0 && !activity && <li className="text-sm text-muted-foreground">Waiting for a free slot…</li>}
          <RequestItem job={job} />
        </ol>
      </CardContent>
    </>
  );
}

function TimelineItem({ event, offset }: { event: RemixEvent; offset: number }) {
  const attempt = "round" in event && event.round > 1 ? ` (attempt ${event.round})` : "";
  let icon: ReactNode;
  let title: ReactNode;
  let body: ReactNode = null;
  let image: string | null = null;
  switch (event.type) {
    case "planned":
      icon = <Sparkles className="text-primary" />;
      title = `Planned “${event.name}”`;
      body = (
        <>
          {event.style && <p className="line-clamp-3">{event.style}</p>}
          {event.referenceLook && <PromptBlock label="Look taken from your reference" text={event.referenceLook} />}
          <PromptBlock label="Expanded prompt" text={event.editPrompt} />
        </>
      );
      break;
    case "painted":
      icon = <Paintbrush className="text-primary" />;
      title = `Painted ${event.page}${attempt}`;
      body = (
        <>
          {event.shrunk.length > 0 && (
            <p>
              Shrunk {event.shrunk.length} {event.shrunk.length === 1 ? "part" : "parts"} that were drawn too big:{" "}
              {event.shrunk.map((s) => `${s.part} ${Math.round(s.scale * 100)}%`).join(", ")}
            </p>
          )}
          {event.prompt && <PromptBlock label="Sent to Muse Image" text={event.prompt} />}
        </>
      );
      image = event.url;
      break;
    case "rejected":
      icon = <Undo2 className="text-destructive" />;
      title = `Threw out a paint of ${event.page}`;
      body = (
        <>
          <p>Muse Image moved the parts: only {Math.round(event.insideBoxes * 100)}% landed in their boxes. Painting it again.</p>
          {event.prompt && <PromptBlock label="Sent to Muse Image" text={event.prompt} />}
        </>
      );
      image = event.url;
      break;
    case "checked":
      icon = event.pass ? <CircleCheck className="text-primary" /> : <CircleAlert className="text-destructive" />;
      title = `${event.check === "style" ? "Style" : "Fit"} check ${event.pass ? "passed" : "failed"} · ${Math.round(event.score * 100)}%${attempt}`;
      body = (
        <>
          <p>{event.summary}</p>
          {event.issues.length > 0 && (
            <ul className="mt-1 list-disc pl-4">
              {event.issues.slice(0, 4).map((issue, i) => (
                <li key={`${issue.part}:${i}`}>
                  {issue.part && <span className="font-medium text-foreground">{issue.part}: </span>}
                  {issue.problem}
                </li>
              ))}
            </ul>
          )}
        </>
      );
      image = event.renderUrl;
      break;
    case "fixed":
      icon = <Wrench className={event.error ? "text-destructive" : "text-primary"} />;
      title = event.error ? `Couldn't fix ${event.regions.join(", ")}` : `Repainted ${event.regions.join(", ")}`;
      body = (
        <>
          {event.error && <p>{event.error}</p>}
          <PromptBlock label="What the check asked for" text={event.prompt} />
          {event.plan && <PromptBlock label="Expanded fix" text={event.plan} />}
          {event.imagePrompts?.map((prompt, i) => (
            <PromptBlock key={i} label={event.imagePrompts.length > 1 ? `Sent to Muse Image · page ${i + 1}` : "Sent to Muse Image"} text={prompt} />
          ))}
        </>
      );
      break;
    case "revised":
      icon = <PenLine className="text-primary" />;
      title = "Rewrote the plan for the next attempt";
      body = event.editPrompt ? <PromptBlock label="New expanded prompt" text={event.editPrompt} /> : <p>Added the checks' fixes to the image prompt.</p>;
      break;
    case "reworded":
      icon = <ShieldAlert className="text-destructive" />;
      title = "Re-worded the prompt for Muse Image's content policy";
      body = <PromptBlock label="Re-worded expanded prompt" text={event.editPrompt} />;
      break;
    case "chosen":
      icon = event.quality === "passed" ? <Trophy className="text-primary" /> : <CircleAlert className="text-destructive" />;
      title = `Keeping attempt ${event.round}${event.quality === "below-bar" ? " · below the quality bar" : event.quality === "unchecked" ? " · not fully checked" : ""}`;
      body = (
        <p>
          Best score of all attempts: {Math.round(event.score * 100)}%.
          {event.quality === "below-bar" && " It didn't pass every check, so look it over before using it, or try again."}
          {event.quality === "unchecked" && " A check couldn't run, so look it over before using it."}
        </p>
      );
      break;
    case "tweaked":
      icon = <Move className="text-primary" />;
      title = event.parts > 0 ? `Lined up ${event.parts} ${event.parts === 1 ? "part" : "parts"}` : "Parts already line up";
      break;
  }
  return (
    <li className="flex gap-3 text-sm">
      <span className="mt-0.5 shrink-0 [&_svg]:size-4">{icon}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-medium">{title}</span>
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatOffset(offset)}</span>
        </div>
        {body && <div className="text-xs text-muted-foreground">{body}</div>}
        {image && (
          <a href={image} target="_blank" rel="noreferrer" className="w-fit">
            {/* CORS mode as in the runtime: a plain request would cache a response WebGL then rejects. */}
            <img src={image} crossOrigin="anonymous" alt="" loading="lazy" className="h-20 w-auto rounded-md border bg-muted object-contain" />
          </a>
        )}
      </div>
    </li>
  );
}

/** Where every remix starts: what the user asked for, with their settings and reference image. */
function RequestItem({ job }: { job: RemixJob }) {
  const { input } = job;
  const kept = [input.keepPalette && "palette", input.keepPosition && "position", input.keepSize && "size", input.keepOutline && "outline"].filter(Boolean);
  return (
    <li className="flex gap-3 text-sm">
      <MessageSquareText className="mt-0.5 size-4 shrink-0 text-primary" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-medium">Your request</span>
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatOffset(0)}</span>
        </div>
        <div className="text-xs text-muted-foreground">
          <p className="whitespace-pre-wrap text-foreground">{input.prompt ? `“${input.prompt}”` : "No prompt: match the reference image."}</p>
          <p className="mt-1">
            Style {input.style} · strength {Math.round(input.strength * 100)}%{kept.length > 0 && ` · keep ${kept.join(", ")}`}
          </p>
        </div>
        {job.referenceUrl && (
          <a href={job.referenceUrl} target="_blank" rel="noreferrer" className="w-fit">
            <img src={job.referenceUrl} alt="Reference image" loading="lazy" className="h-20 w-auto rounded-md border bg-muted object-contain" />
          </a>
        )}
      </div>
    </li>
  );
}

/** A prompt as sent, folded so the timeline stays scannable. */
function PromptBlock({ label, text }: { label: string; text: string }) {
  return (
    <details className="group mt-1 rounded-md border bg-muted/40">
      <summary className="flex cursor-pointer list-none items-center gap-1 px-2 py-1 font-medium text-foreground select-none [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3 shrink-0 transition-transform group-open:rotate-90" />
        {label}
      </summary>
      <p className="max-h-64 overflow-y-auto border-t px-2 py-1.5 whitespace-pre-wrap">{text}</p>
    </details>
  );
}

function formatOffset(seconds: number) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
