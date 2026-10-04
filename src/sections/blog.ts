import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { media, rem, type MotionConditions } from "../motion/tokens";

/**
 * Blog: hover (thumbnail zoom, arrow hand-off) is pure CSS. Here: a quiet
 * parallax on each gradient thumbnail as the row scrolls through.
 */
export function init() {
  gsap.registerPlugin(ScrollTrigger);
  const mm = gsap.matchMedia();

  mm.add(media, (ctx) => {
    const { reduced } = ctx.conditions as MotionConditions;
    if (reduced) return;

    gsap.utils.toArray<HTMLElement>(".post__thumb").forEach((thumb, i) => {
      const inner = thumb.querySelector<HTMLElement>(".post__thumb-inner");
      if (!inner) return;
      gsap.fromTo(inner,
        { y: () => -rem(1.25) },
        {
          y: () => rem(1.25),
          // Gentle phase offset per card so the row doesn't move as one slab.
          ease: i % 2 ? "sine.inOut" : "none",
          scrollTrigger: { trigger: thumb, start: "top bottom", end: "bottom top", scrub: true },
        });
    });
  });

  return () => mm.revert();
}
