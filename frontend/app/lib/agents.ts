import { Bone, Brush, Clapperboard, Film, Library, type LucideIcon, Palette, PersonStanding } from "lucide-react";
import type { RemixActivity, RemixEvent } from "~/lib/types";

// The agents behind each Muse step: remixes (RemixJob.live), auto-rig, animations, auto-tweak and
// uploads. Each step is credited to one of them, with the Muse model it calls; steps done in code
// alone (reading the rig, the box check, packing) have no model. UI only: no prompt uses the names.

export type AgentId = "director" | "designer" | "stylist" | "rigger" | "animator" | "poser" | "librarian";

export interface Agent {
  name: string;
  /** What the agent does, for tooltips. */
  role: string;
  /** Avatar icon; Director Dirk and Designer Dani share an initial, so avatars use icons. */
  icon: LucideIcon;
  /** Avatar colours, as full class strings. */
  className: string;
}

export const AGENTS: Record<AgentId, Agent> = {
  director: { name: "Director Dirk", role: "plans the look, rewrites it from feedback and picks the winner", icon: Clapperboard, className: "bg-chart-1 text-white" },
  designer: { name: "Designer Dani", role: "paints each page and repaints flagged or hidden parts", icon: Brush, className: "bg-chart-2 text-white" },
  stylist: { name: "Stylist Stella", role: "checks the paint matches the style", icon: Palette, className: "bg-chart-4 text-white" },
  rigger: { name: "Rigger Rick", role: "places the joints, checks the parts fit the rig and lines them back up", icon: Bone, className: "bg-chart-3 text-white" },
  animator: { name: "Animator Annie", role: "plans and keys new animations, then checks them", icon: Film, className: "bg-chart-5 text-white" },
  poser: { name: "Poser Penny", role: "redraws an uploaded character in a rig-ready pose", icon: PersonStanding, className: "bg-chart-2 text-white" },
  librarian: { name: "Librarian Lou", role: "names, styles and tags each upload", icon: Library, className: "bg-chart-4 text-white" },
};

export type MuseModel = "Muse Spark" | "Muse Image";

/** Who does a step, and the Muse model(s) it calls. */
export interface AgentStep {
  agent: AgentId;
  models: MuseModel[];
}

export function activityAgent(kind: RemixActivity["kind"]): AgentStep {
  switch (kind) {
    case "reading":
      return { agent: "rigger", models: [] };
    case "reference":
    case "planning":
    case "revising":
      return { agent: "director", models: ["Muse Spark"] };
    case "painting":
      return { agent: "designer", models: ["Muse Image"] };
    case "fixing":
      return { agent: "designer", models: ["Muse Spark", "Muse Image"] };
    case "checking-style":
      return { agent: "stylist", models: ["Muse Spark"] };
    case "checking-rig":
    case "tweaking":
      return { agent: "rigger", models: ["Muse Spark"] };
    case "packing":
      return { agent: "rigger", models: [] };
  }
}

export function eventAgent(event: RemixEvent): AgentStep {
  switch (event.type) {
    case "planned":
    case "revised":
    case "reworded":
      return { agent: "director", models: ["Muse Spark"] };
    case "chosen":
      return { agent: "director", models: [] };
    case "painted":
      return { agent: "designer", models: ["Muse Image"] };
    case "fixed":
      return { agent: "designer", models: ["Muse Spark", "Muse Image"] };
    case "checked":
      return event.check === "style" ? { agent: "stylist", models: ["Muse Spark"] } : { agent: "rigger", models: ["Muse Spark"] };
    // The box check runs in code, on Designer Dani's paint.
    case "rejected":
      return { agent: "rigger", models: [] };
    case "tweaked":
      return { agent: "rigger", models: ["Muse Spark"] };
  }
}
