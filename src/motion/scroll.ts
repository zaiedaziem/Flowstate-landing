import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";
import { duration, ease, media, type MotionConditions } from "./tokens";

export interface ScrollSystem {
  lenis: Lenis | null;
  scrollTo(target: string | HTMLElement): void;
  cleanup(): void;
}

/**
 * Lenis smooth scroll driven by gsap.ticker so Lenis, ScrollTrigger and every
 * tween share one clock. Lenis smooths *native* scrolling, so ScrollTrigger
 * keeps the window as its scroller and pins stay position:fixed.
 */
export function initScroll(reduced: boolean): ScrollSystem {
  gsap.registerPlugin(ScrollTrigger);
  const disposers: Array<() => void> = [];

  let lenis: Lenis | null = null;
  if (!reduced) {
    lenis = new Lenis({ smoothWheel: true, autoRaf: false });
    const onTick = (time: number) => lenis!.raf(time * 1000);
    lenis.on("scroll", ScrollTrigger.update);
    gsap.ticker.add(onTick);
    gsap.ticker.lagSmoothing(0);
    disposers.push(() => {
      gsap.ticker.remove(onTick);
      lenis!.destroy();
    });
  }

  const scrollTo = (target: string | HTMLElement) => {
    const el = typeof target === "string" ? document.querySelector<HTMLElement>(target) : target;
    if (!el) return;
    if (lenis) lenis.scrollTo(el, { duration: 1.4 });
    else el.scrollIntoView({ behavior: reduced ? "auto" : "smooth" });
  };

  // In-page anchors go through Lenis; focus moves to the target for keyboard users.
  const onClick = (event: MouseEvent) => {
    const link = (event.target as Element | null)?.closest<HTMLAnchorElement>('a[href^="#"]');
    if (!link || link.classList.contains("skip-link")) return;
    const id = link.getAttribute("href")!;
    const target = id.length > 1 ? document.querySelector<HTMLElement>(id) : null;
    if (!target) return;
    event.preventDefault();
    scrollTo(target);
    history.replaceState(null, "", id);
    if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: true });
  };
  document.addEventListener("click", onClick);
  disposers.push(() => document.removeEventListener("click", onClick));

  disposers.push(initProgress(), initNav(), initAtmosphere());

  return {
    lenis,
    scrollTo,
    cleanup() {
      disposers.splice(0).reverse().forEach((dispose) => dispose());
    },
  };
}

/** Thin ink-gradient progress bar along the top edge. */
function initProgress() {
  const bar = document.querySelector<HTMLElement>(".progress");
  if (!bar) return () => {};
  const tween = gsap.to(bar, {
    scaleX: 1,
    ease: ease.none,
    scrollTrigger: { start: 0, end: "max", scrub: 0.3 },
  });
  return () => {
    tween.scrollTrigger?.kill();
    tween.kill();
  };
}

/** Nav hides on scroll down, returns on scroll up; gains a backing once scrolled. */
function initNav() {
  const nav = document.querySelector<HTMLElement>(".site-nav");
  if (!nav) return () => {};
  let hidden = false;

  const setHidden = (next: boolean) => {
    if (next === hidden) return;
    hidden = next;
    gsap.to(nav, {
      yPercent: next ? -110 : 0,
      duration: next ? duration.base * 0.7 : duration.base,
      ease: next ? "power2.in" : ease.entrance,
      overwrite: true,
    });
  };

  const trigger = ScrollTrigger.create({
    start: 0,
    end: "max",
    onUpdate(self) {
      const y = self.scroll();
      nav.classList.toggle("is-scrolled", y > 40);
      if (y < window.innerHeight * 0.4) setHidden(false);
      else if (self.direction === 1) setHidden(true);
      else setHidden(false);
    },
  });

  // Keyboard users must always be able to reach the nav.
  const onFocus = () => setHidden(false);
  nav.addEventListener("focusin", onFocus);

  return () => {
    trigger.kill();
    nav.removeEventListener("focusin", onFocus);
    gsap.set(nav, { clearProps: "transform" });
  };
}

/**
 * The scrim (SPEC radial) frames the hero; an even veil dims the fluid behind
 * reading sections; both lift away for the final CTA so the ink comes through.
 */
function initAtmosphere() {
  const scrim = document.querySelector<HTMLElement>(".scrim");
  const veil = document.querySelector<HTMLElement>(".veil");
  const hero = document.querySelector<HTMLElement>(".hero");
  const cta = document.querySelector<HTMLElement>(".cta");
  const footer = document.querySelector<HTMLElement>(".site-footer");
  if (!scrim || !veil || !hero || !cta) return () => {};

  const mm = gsap.matchMedia();
  mm.add(media, (ctx) => {
    const { reduced } = ctx.conditions as MotionConditions;
    const scrub = reduced ? true : 0.6;

    gsap.fromTo(veil, { opacity: 0 }, {
      opacity: 1,
      ease: ease.none,
      scrollTrigger: { trigger: hero, start: "bottom 85%", end: "bottom 25%", scrub },
    });
    gsap.fromTo(veil, { opacity: 1 }, {
      opacity: 0,
      ease: ease.none,
      immediateRender: false,
      scrollTrigger: { trigger: cta, start: "top 90%", end: "top 20%", scrub },
    });
    gsap.fromTo(scrim, { opacity: 1 }, {
      opacity: 0.5,
      ease: ease.none,
      scrollTrigger: { trigger: cta, start: "top 90%", end: "top 20%", scrub },
    });
    // The CTA is the climax; the footer settles back down so its links read cleanly.
    if (footer) {
      gsap.fromTo(veil, { opacity: 0 }, {
        opacity: 1,
        ease: ease.none,
        immediateRender: false,
        scrollTrigger: { trigger: footer, start: "top 85%", end: "top 35%", scrub },
      });
    }
  });

  return () => mm.revert();
}
