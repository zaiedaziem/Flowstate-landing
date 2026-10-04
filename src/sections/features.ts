import { gsap } from "gsap";
import { duration, ease, hasFinePointer, prefersReducedMotion } from "../motion/tokens";

const MAX_TILT = 6; // degrees

/**
 * Features bento: a soft spotlight follows the pointer inside each card and
 * the card tilts in 3D toward it. Fine pointer + motion allowed only; the
 * entrance itself is handled by the shared [data-reveal] system.
 */
export function init() {
  if (!hasFinePointer() || prefersReducedMotion()) return () => {};

  const disposers: Array<() => void> = [];
  let scrollGeneration = 0;

  document.querySelectorAll<HTMLElement>(".feature[data-tilt]").forEach((card) => {
    const spot = card.querySelector<HTMLElement>(".feature__spot");
    gsap.set(card, { transformPerspective: 1100 });

    const rx = gsap.quickTo(card, "rotationX", { duration: 0.6, ease: "power3.out" });
    const ry = gsap.quickTo(card, "rotationY", { duration: 0.6, ease: "power3.out" });
    const sx = spot ? gsap.quickTo(spot, "x", { duration: 0.35, ease: "power3.out" }) : null;
    const sy = spot ? gsap.quickTo(spot, "y", { duration: 0.35, ease: "power3.out" }) : null;
    let rect: DOMRect | null = null;
    let rectGeneration = -1;
    const measure = () => {
      rect = card.getBoundingClientRect();
      rectGeneration = scrollGeneration;
      return rect;
    };

    const onEnter = (e: PointerEvent) => {
      const rect = measure();
      if (spot) {
        // Jump the light to the entry point instead of sliding in from a corner.
        gsap.set(spot, { x: e.clientX - rect.left, y: e.clientY - rect.top });
        gsap.to(spot, { opacity: 1, duration: duration.hover, ease: ease.entrance, overwrite: "auto" });
      }
    };

    const currentRect = () => (rect && rectGeneration === scrollGeneration ? rect : measure());

    const onMove = (e: PointerEvent) => {
      const rect = currentRect();
      const px = (e.clientX - rect.left) / rect.width;  // 0..1
      const py = (e.clientY - rect.top) / rect.height; // 0..1
      rx((0.5 - py) * MAX_TILT * 2);
      ry((px - 0.5) * MAX_TILT * 2);
      sx?.(e.clientX - rect.left);
      sy?.(e.clientY - rect.top);
    };

    const onLeave = () => {
      rect = null;
      rx(0);
      ry(0);
      if (spot) gsap.to(spot, { opacity: 0, duration: duration.base, ease: ease.entrance, overwrite: "auto" });
    };

    card.addEventListener("pointerenter", onEnter);
    card.addEventListener("pointermove", onMove);
    card.addEventListener("pointerleave", onLeave);

    disposers.push(() => {
      card.removeEventListener("pointerenter", onEnter);
      card.removeEventListener("pointermove", onMove);
      card.removeEventListener("pointerleave", onLeave);
      gsap.killTweensOf([card, spot].filter(Boolean));
      gsap.set(card, { rotationX: 0, rotationY: 0 });
    });
  });

  // Rects are cached per hover; scrolling (smoothly, under a still pointer) stales them.
  const onScroll = () => { scrollGeneration++; };
  window.addEventListener("scroll", onScroll, { passive: true });
  disposers.push(() => window.removeEventListener("scroll", onScroll));

  return () => disposers.splice(0).forEach((dispose) => dispose());
}
