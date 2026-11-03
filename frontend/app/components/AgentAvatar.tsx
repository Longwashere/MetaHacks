import { AGENTS, type AgentId } from "~/lib/agents";
import { cn } from "~/lib/utils";

/** An agent's round avatar: their icon in their colour. */
export function AgentAvatar({ agent, className }: { agent: AgentId; className?: string }) {
  const { icon: Icon, className: colors } = AGENTS[agent];
  return (
    <span className={cn("inline-flex size-4 shrink-0 items-center justify-center rounded-full", colors, className)} aria-hidden>
      <Icon className="size-[65%]" />
    </span>
  );
}
