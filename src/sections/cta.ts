import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";
import { media, type MotionConditions } from "../motion/tokens";

/**
 * Final CTA: the heading is read into existence — words brighten and settle
 * in step with the scroll position. Reduced motion: a single fade.
 */
export function init() {
  gsap.registerPlugin(ScrollTrigger, SplitText);
  const title = document.querySelector<HTMLElement>(".cta__title");
  if (!title) return () => {};

  const mm = gsap.matchMedia();
  mm.add(media, (ctx) => {
    const { reduced } = ctx.conditions as MotionConditions;

    if (reduced) {
      gsap.fromTo(title, { opacity: 0 }, {
        opacity: 1,
        duration: 0.6,
        scrollTrigger: { trigger: title, start: "top 85%", end: "max", once: true },
      });
      return;
    }

    // Words rise out of per-line masks in step with the scroll. Text stays at
    // full contrast the whole time — the reveal is position, not opacity.
    const split = SplitText.create(title, {
      type: "lines, words",
      linesClass: "line",
      wordsClass: "word",
      tag: "span",
      aria: "none",
      mask: "lines",
      autoSplit: true,
      onSplit(self) {
        return gsap.fromTo(self.words,
          { yPercent: 115, rotate: 4 },
          {
            yPercent: 0,
            rotate: 0,
            ease: "none",
            stagger: 0.1,
            scrollTrigger: { trigger: title, start: "top 85%", end: "bottom 50%", scrub: 0.6 },
          });
      },
    });

    return () => split.revert();
  });

  return () => mm.revert();
}
