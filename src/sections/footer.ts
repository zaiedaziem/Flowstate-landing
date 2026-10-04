import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";
import { media, type MotionConditions } from "../motion/tokens";

/**
 * Footer: the oversized wordmark rises letter by letter out of the bottom
 * edge as the footer scrolls into view.
 */
export function init() {
  gsap.registerPlugin(ScrollTrigger, SplitText);
  const footer = document.querySelector<HTMLElement>(".site-footer");
  const word = footer?.querySelector<HTMLElement>(".footer__word");
  if (!footer || !word) return () => {};

  const mm = gsap.matchMedia();
  mm.add(media, (ctx) => {
    const { reduced } = ctx.conditions as MotionConditions;
    if (reduced) return;

    const split = SplitText.create(word, { type: "chars", charsClass: "char", tag: "span", aria: "none" });
    word.classList.add("is-split");

    gsap.fromTo(split.chars,
      { yPercent: 105 },
      {
        yPercent: 0,
        ease: "power2.out",
        stagger: { each: 0.05, from: "start" },
        scrollTrigger: {
          trigger: word,
          start: "top bottom",
          end: "bottom bottom",
          scrub: 0.8,
        },
      });

    return () => {
      word.classList.remove("is-split");
      split.revert();
    };
  });

  return () => mm.revert();
}
