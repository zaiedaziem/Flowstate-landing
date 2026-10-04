import { gsap } from "gsap";
import { duration, ease } from "./tokens";

const HOVER_SELECTOR = "a, button, [data-cursor='hover'], [data-tilt]";
const TEXT_SELECTOR = "input, textarea";

/**
 * Dot + ring cursor. Desktop / fine pointer only (the caller gates it).
 * Dot tracks 1:1, the ring trails; the ring swells over interactive targets
 * and both step aside over text fields so the caret stays visible.
 */
export function initCursor() {
  const root = document.createElement("div");
  root.className = "cursor";
  root.setAttribute("aria-hidden", "true");
  root.innerHTML = '<div class="cursor__ring"></div><div class="cursor__dot"></div>';
  document.body.appendChild(root);
  document.documentElement.classList.add("has-cursor");

  const dot = root.querySelector<HTMLElement>(".cursor__dot")!;
  const ring = root.querySelector<HTMLElement>(".cursor__ring")!;

  const dotX = gsap.quickTo(dot, "x", { duration: 0.08, ease: "power3.out" });
  const dotY = gsap.quickTo(dot, "y", { duration: 0.08, ease: "power3.out" });
  const ringX = gsap.quickTo(ring, "x", { duration: 0.42, ease: "power3.out" });
  const ringY = gsap.quickTo(ring, "y", { duration: 0.42, ease: "power3.out" });

  let visible = false;
  let mode: "default" | "hover" | "text" = "default";

  const show = (next: boolean) => {
    if (next === visible) return;
    visible = next;
    // Visibility lives on the root so hover modes (which fade ring/dot) can't reveal it early.
    gsap.to(root, { opacity: next ? 1 : 0, duration: duration.fast * 2, overwrite: "auto" });
  };

  const setMode = (next: typeof mode) => {
    if (next === mode) return;
    mode = next;
    gsap.to(ring, {
      scale: next === "hover" ? 1.75 : next === "text" ? 0.4 : 1,
      opacity: next === "text" ? 0 : 1,
      borderColor: next === "hover" ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.55)",
      duration: duration.hover,
      ease: ease.entrance,
      overwrite: "auto",
    });
    gsap.to(dot, {
      scale: next === "hover" ? 0 : 1,
      opacity: next === "text" ? 0 : 1,
      duration: duration.hover * 0.6,
      ease: ease.entrance,
      overwrite: "auto",
    });
  };

  const onMove = (e: PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    if (!visible) {
      gsap.set([dot, ring], { x: e.clientX, y: e.clientY });
    }
    show(true);
    dotX(e.clientX);
    dotY(e.clientY);
    ringX(e.clientX);
    ringY(e.clientY);
  };

  const onOver = (e: PointerEvent) => {
    const target = e.target as Element | null;
    if (target?.closest(TEXT_SELECTOR)) setMode("text");
    else if (target?.closest(HOVER_SELECTOR)) setMode("hover");
    else setMode("default");
  };

  const onLeave = () => show(false);
  const onDown = () => gsap.to(ring, { scale: mode === "hover" ? 1.5 : 0.8, duration: duration.fast, overwrite: "auto" });
  const onUp = () => gsap.to(ring, { scale: mode === "hover" ? 1.75 : 1, duration: duration.hover, ease: ease.entrance, overwrite: "auto" });

  window.addEventListener("pointermove", onMove, { passive: true });
  document.addEventListener("pointerover", onOver, { passive: true });
  document.documentElement.addEventListener("pointerleave", onLeave);
  window.addEventListener("pointerdown", onDown, { passive: true });
  window.addEventListener("pointerup", onUp, { passive: true });

  return () => {
    window.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerover", onOver);
    document.documentElement.removeEventListener("pointerleave", onLeave);
    window.removeEventListener("pointerdown", onDown);
    window.removeEventListener("pointerup", onUp);
    gsap.killTweensOf([root, dot, ring]);
    root.remove();
    document.documentElement.classList.remove("has-cursor");
  };
}
