import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";
import { duration, ease, media, rem, type MotionConditions } from "./tokens";

/**
 * Shared scroll reveal for every `[data-reveal]` element.
 *
 *  - Blocks fade up, batched and staggered as they enter together.
 *  - Section titles (`.title` inside a revealed block) get more weight: their
 *    lines rise out of masks, so headings lead and body copy follows.
 *  - Reduced motion: plain fade, no split.
 *
 * Uses opacity (not autoAlpha) so unrevealed content stays in the
 * accessibility tree, and an open-ended range so landing anywhere past a
 * trigger (deep link, restored scroll, inside a pin) still reveals it.
 */
export function initReveals(root: ParentNode = document) {
  gsap.registerPlugin(ScrollTrigger, SplitText);
  const items = gsap.utils.toArray<HTMLElement>(root.querySelectorAll("[data-reveal]"));
  const mm = gsap.matchMedia();

  mm.add(media, (ctx) => {
    const { reduced } = ctx.conditions as MotionConditions;
    const fromY = reduced ? 0 : rem(1.75);
    const revealed = new WeakSet<HTMLElement>();
    const titleLines = new Map<HTMLElement, HTMLElement[]>();
    const splits: SplitText[] = [];

    // Titles are split lazily, at the moment their block reveals (the block is
    // still at opacity 0 then), so no split work competes with the hero.
    const splitTitle = (item: HTMLElement) => {
      const title = item.querySelector<HTMLElement>(".title");
      if (!title || reduced) return;
      splits.push(SplitText.create(title, {
        type: "lines",
        linesClass: "line",
        tag: "span",
        aria: "none",
        mask: "lines",
        autoSplit: true,
        onSplit(self) {
          const lines = self.lines as HTMLElement[];
          titleLines.set(item, lines);
          // Re-splits (resize, font swap) keep whatever state we were in.
          gsap.set(lines, { yPercent: revealed.has(item) ? 0 : 110 });
        },
      }));
    };

    gsap.set(items, { opacity: 0, y: fromY });
    document.documentElement.classList.add("reveal-ready");

    const batches = ScrollTrigger.batch(items, {
      start: "top 88%",
      end: "max",
      once: true,
      onEnter: (batch) => {
        const els = batch as HTMLElement[];
        els.forEach(splitTitle);
        els.forEach((el) => revealed.add(el));
        gsap.to(els, {
          opacity: 1,
          y: 0,
          duration: reduced ? 0.5 : duration.base * 1.3,
          ease: ease.entrance,
          stagger: reduced ? 0 : 0.08,
          overwrite: "auto",
        });
        els.forEach((el, i) => {
          const lines = titleLines.get(el);
          if (!lines) return;
          gsap.to(lines, {
            yPercent: 0,
            duration: duration.slow,
            ease: ease.entrance,
            stagger: 0.09,
            delay: i * 0.08,
            overwrite: "auto",
          });
        });
      },
    });

    return () => {
      batches.forEach((st) => st.kill());
      splits.forEach((split) => split.revert());
    };
  });

  return () => mm.revert();
}
