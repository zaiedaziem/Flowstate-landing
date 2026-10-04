import { gsap } from "gsap";
import { CustomEase } from "gsap/CustomEase";

/** Easing tokens — every tween on the site picks from this list. */
export const ease = {
  /** SPEC --ease-entrance, cubic-bezier(0.2, 0, 0, 1): stand-in for the 120/24 spring. */
  entrance: "entrance",
  /** SPEC word reveals: 1 - (1 - t)^3. GSAP's power2 is cubic. */
  outCubic: "power2.out",
  /** Drawn lines, scrubbed reveals. */
  none: "none",
  /** Big, weighty moves (pricing digits, nav). */
  outExpo: "expo.out",
  /** Magnetic release. */
  release: "elastic.out(1, 0.4)",
} as const;

/** Duration tokens, seconds. */
export const duration = {
  fast: 0.15,
  base: 0.7,
  slow: 1.1,
  hover: 0.45,
} as const;

/** SPEC hero timings (seconds after boot). */
export const hero = {
  navDelay: 0.15,
  badgeDelay: 0.32,
  headingDelay: 0.48,
  headingStagger: 0.085,
  headingDuration: 0.72,
  headingFromY: 26,
  subDelay: 1.15,
  subStagger: 0.022,
  subDuration: 0.6,
  subFromY: 14,
  formDelay: 1.45,
  footDelay: 1.65,
  /** rem */
  navFromY: -0.75,
  /** rem */
  blockFromY: 1.25,
} as const;

/** Media conditions shared by every gsap.matchMedia(). */
export const media = {
  desktop: "(min-width: 768px) and (prefers-reduced-motion: no-preference)",
  mobile: "(max-width: 767px) and (prefers-reduced-motion: no-preference)",
  reduced: "(prefers-reduced-motion: reduce)",
  finePointer: "(hover: hover) and (pointer: fine)",
} as const;

export type MotionConditions = { desktop: boolean; mobile: boolean; reduced: boolean };

let registered = false;
export function registerEases() {
  if (registered) return;
  registered = true;
  gsap.registerPlugin(CustomEase);
  CustomEase.create(ease.entrance, "0.2,0,0,1");
}

/** rem → px using the live (viewport-scaled) root font size. */
export function rem(value: number) {
  return value * parseFloat(getComputedStyle(document.documentElement).fontSize);
}

export const prefersReducedMotion = () => window.matchMedia(media.reduced).matches;
export const hasFinePointer = () => window.matchMedia(media.finePointer).matches;
