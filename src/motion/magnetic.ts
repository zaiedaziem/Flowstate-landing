import { gsap } from "gsap";
import { duration, ease } from "./tokens";

/**
 * Magnetic pills: the button leans toward the pointer and its label leans a
 * little further, giving a sense of depth. Releases with a soft elastic.
 * Desktop / fine pointer only (the caller gates it).
 */
export function initMagnetic(root: ParentNode = document, strength = 0.32) {
  const disposers: Array<() => void> = [];

  root.querySelectorAll<HTMLElement>("[data-magnetic]").forEach((el) => {
    const label = el.querySelector<HTMLElement>(".pill__label");
    const xTo = gsap.quickTo(el, "x", { duration: 0.5, ease: "power3.out" });
    const yTo = gsap.quickTo(el, "y", { duration: 0.5, ease: "power3.out" });
    const lxTo = label ? gsap.quickTo(label, "x", { duration: 0.5, ease: "power3.out" }) : null;
    const lyTo = label ? gsap.quickTo(label, "y", { duration: 0.5, ease: "power3.out" }) : null;
    let rect: DOMRect | null = null;

    const onEnter = () => {
      // Measure once per hover, with the element at rest, so the pull never feeds back on itself.
      gsap.killTweensOf(el, "x,y");
      const r = el.getBoundingClientRect();
      const x = Number(gsap.getProperty(el, "x")) || 0;
      const y = Number(gsap.getProperty(el, "y")) || 0;
      rect = new DOMRect(r.left - x, r.top - y, r.width, r.height);
    };

    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      if (!rect) onEnter();
      const dx = e.clientX - (rect!.left + rect!.width / 2);
      const dy = e.clientY - (rect!.top + rect!.height / 2);
      xTo(dx * strength);
      yTo(dy * strength);
      lxTo?.(dx * strength * 0.35);
      lyTo?.(dy * strength * 0.35);
    };

    const onLeave = () => {
      rect = null;
      gsap.to(el, { x: 0, y: 0, duration: duration.slow, ease: ease.release, overwrite: true });
      if (label) gsap.to(label, { x: 0, y: 0, duration: duration.slow, ease: ease.release, overwrite: true });
    };

    el.addEventListener("pointerenter", onEnter);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerleave", onLeave);

    disposers.push(() => {
      el.removeEventListener("pointerenter", onEnter);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
      gsap.killTweensOf([el, label].filter(Boolean));
      gsap.set([el, label].filter(Boolean), { clearProps: "transform" });
    });
  });

  return () => disposers.splice(0).forEach((dispose) => dispose());
}
