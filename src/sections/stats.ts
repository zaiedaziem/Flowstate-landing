import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { media, type MotionConditions } from "../motion/tokens";

/**
 * Count-up stats. Screen readers get the final value from a sibling
 * .sr-only span; the animated span is aria-hidden. Reduced motion shows the
 * final numbers as authored.
 */
export function init() {
  gsap.registerPlugin(ScrollTrigger);
  const counters = gsap.utils.toArray<HTMLElement>("[data-count]");
  const mm = gsap.matchMedia();

  mm.add(media, (ctx) => {
    const { reduced } = ctx.conditions as MotionConditions;
    if (reduced) return;

    const triggers = counters.map((el) => {
      const target = parseFloat(el.dataset.count ?? "0");
      const decimals = parseInt(el.dataset.decimals ?? "0", 10);
      const suffix = el.dataset.suffix ?? "";
      const original = el.textContent;
      const state = { value: 0 };
      const render = () => { el.textContent = state.value.toFixed(decimals) + suffix; };
      render();

      const tween = gsap.to(state, {
        value: target,
        duration: 2,
        ease: "expo.out",
        paused: true,
        onUpdate: render,
      });

      const st = ScrollTrigger.create({
        trigger: el,
        start: "top 85%",
        end: "max",
        once: true,
        onEnter: () => tween.play(),
      });

      return () => {
        st.kill();
        tween.kill();
        el.textContent = original;
      };
    });

    return () => triggers.forEach((dispose) => dispose());
  });

  return () => mm.revert();
}
