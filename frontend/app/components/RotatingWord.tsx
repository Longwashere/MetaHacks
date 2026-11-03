import { useEffect, useRef, useState } from "react";
import { cn } from "~/lib/utils";

const INTERVAL_MS = 2500;

/**
 * Cycles through `words` like a slot-machine reel, inline and one line tall. The first word is
 * repeated at the end so the reel can wrap back to it without scrolling backwards, and the reel's
 * width eases to each word so the text after it doesn't leave a gap.
 * Decorative: pair it with a static sentence for screen readers and crawlers.
 */
export function RotatingWord({ words, className }: { words: string[]; className?: string }) {
  const reel = [...words, words[0]];
  const [index, setIndex] = useState(0);
  const [instant, setInstant] = useState(false);
  const [widths, setWidths] = useState<number[] | null>(null);
  const itemRefs = useRef<(HTMLSpanElement | null)[]>([]);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = setInterval(() => {
      setInstant(false);
      setIndex((i) => i + 1);
    }, INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  // Re-measure when the font loads or the breakpoint changes the font size.
  useEffect(() => {
    const items = itemRefs.current.filter((el) => el !== null);
    const measure = () => setWidths(items.map((el) => el.getBoundingClientRect().width));
    const observer = new ResizeObserver(measure);
    items.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  // Landed on the repeated first word: jump back to the real one with no transition.
  function handleTransitionEnd(event: React.TransitionEvent) {
    if (event.propertyName === "transform" && index === reel.length - 1) {
      setInstant(true);
      setIndex(0);
    }
  }

  return (
    <span
      aria-hidden
      className={cn(
        "inline-block h-[1lh] overflow-hidden align-bottom transition-[width] duration-500 ease-out motion-reduce:transition-none",
        instant && "transition-none",
        className,
      )}
      style={{ width: widths ? widths[index] : undefined }}
    >
      <span
        className={cn(
          "flex flex-col transition-transform duration-500 ease-[cubic-bezier(0.22,1.2,0.36,1)] motion-reduce:transition-none",
          instant && "transition-none",
        )}
        style={{ transform: `translateY(-${(index * 100) / reel.length}%)` }}
        onTransitionEnd={handleTransitionEnd}
      >
        {reel.map((word, i) => (
          <span
            key={`${word}-${i}`}
            ref={(el) => {
              itemRefs.current[i] = el;
            }}
            className="block h-[1lh] w-max"
          >
            {word}
          </span>
        ))}
      </span>
    </span>
  );
}
