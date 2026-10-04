import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/hero.css";
import "./styles/sections.css";

import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

import type { FluidController, FluidQuality } from "./fluid/fluid";
import { registerEases, prefersReducedMotion, hasFinePointer } from "./motion/tokens";
import { initScroll } from "./motion/scroll";
import { initReveals } from "./motion/reveal";
import { initCursor } from "./motion/cursor";
import { initMagnetic } from "./motion/magnetic";

import * as hero from "./sections/hero";
import * as how from "./sections/how";
import * as features from "./sections/features";
import * as stats from "./sections/stats";
import * as products from "./sections/products";
import * as pricing from "./sections/pricing";
import * as blog from "./sections/blog";
import * as cta from "./sections/cta";
import * as footer from "./sections/footer";
import * as forms from "./sections/forms";

type Dispose = () => void;

/*
 * Boot order
 *  1. Flags (reduced motion, pointer) + GSAP plugins/eases.
 *  2. Hero entrance + Lenis/ScrollTrigger — the only synchronous work, so
 *     the hero text is the first thing painted (LCP).
 *  3. After first paint: every below-the-fold section, one module per task
 *     (yielding in between keeps input responsive), then cursor + magnetics.
 *     CSS keeps [data-reveal] hidden until the reveal system owns it.
 *  4. After first paint + fonts + idle: start the fluid (code-split). If
 *     WebGL is missing, fall back to the CSS gradient.
 *  5. Fonts settle line lengths → ScrollTrigger.refresh().
 */
function boot(): Dispose {
  const disposers: Dispose[] = [];
  const reduced = prefersReducedMotion();
  const finePointer = hasFinePointer();
  const root = document.documentElement;
  root.classList.toggle("reduced-motion", reduced);

  gsap.registerPlugin(ScrollTrigger);
  registerEases();
  // Pinned sections + Lenis behave better without iOS address-bar refreshes.
  ScrollTrigger.config({ ignoreMobileResize: true });

  let cancelled = false;

  // 2 — hero + scroll system
  disposers.push(hero.init(reduced));
  const scroll = initScroll(reduced);
  disposers.push(scroll.cleanup);

  // 3 — sections, chunked after first paint
  const deferred: Array<() => Dispose> = [
    forms.init,
    initReveals,
    how.init,
    features.init,
    stats.init,
    products.init,
    pricing.init,
    blog.init,
    cta.init,
    footer.init,
  ];
  if (finePointer && !reduced) deferred.push(initCursor, () => initMagnetic());
  afterPaint(async () => {
    for (const init of deferred) {
      await yieldToMain();
      if (cancelled) return;
      disposers.push(init());
    }
    ScrollTrigger.refresh();
  });

  // 4 — fluid after first paint
  let fluid: FluidController | null = null;
  const canvas = document.querySelector<HTMLCanvasElement>("canvas.fluid");
  const startFluid = async () => {
    if (cancelled || !canvas) return;
    try {
      // Code-split: the engine's JS is fetched only after first paint.
      const { createFluid } = await import("./fluid/fluid");
      if (cancelled) return;
      fluid = createFluid(canvas, {
        quality: baseQuality(),
        staticFrame: reduced,
        maxPixelRatio: 1.5,
        // Bloom in with the burst instead of cutting from black.
        onReady: () => gsap.to(canvas, { opacity: 1, duration: reduced ? 0.6 : 0.9, ease: "power2.out" }),
        onContextLost: () => root.classList.add("no-webgl"),
        onError: (error) => {
          root.classList.add("no-webgl");
          if (import.meta.env.DEV) console.info("[fluid] start-up failed, using CSS gradient:", error);
        },
        onQualityChange: (tier) => {
          if (import.meta.env.DEV) console.info(`[fluid] quality → tier ${tier}`);
        },
      });
    } catch (error) {
      root.classList.add("no-webgl");
      if (import.meta.env.DEV) console.info("[fluid] falling back to CSS gradient:", error);
    }
  };
  afterFirstPaint(startFluid);
  disposers.push(() => {
    cancelled = true;
    fluid?.destroy();
    fluid = null;
  });

  // 5 — line lengths change when Onest swaps in
  document.fonts?.ready.then(() => {
    if (!cancelled) ScrollTrigger.refresh();
  });

  return () => {
    disposers.splice(0).reverse().forEach((dispose) => dispose());
    ScrollTrigger.getAll().forEach((st) => st.kill());
  };
}

function baseQuality(): FluidQuality {
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  const small = Math.min(window.innerWidth, window.innerHeight) < 600;
  return coarse || small ? 1 : 0;
}

/** Run after the browser has painted at least once. */
function afterPaint(fn: () => unknown) {
  // rAF doesn't fire in background tabs; the timer guarantees setup still runs.
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    void fn();
  };
  requestAnimationFrame(() => setTimeout(run, 0));
  setTimeout(run, 250);
}

/** Give the main thread back between chunks of setup work. */
function yieldToMain() {
  const scheduler = (window as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (scheduler?.yield) return scheduler.yield();
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** Wait for first paint, then fonts (capped), then an idle slot. */
function afterFirstPaint(fn: () => unknown) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const idle = () => {
      if ("requestIdleCallback" in window) window.requestIdleCallback(() => void fn(), { timeout: 500 });
      else setTimeout(() => void fn(), 1);
    };
    const fontsReady = document.fonts?.ready ?? Promise.resolve();
    // Never let a slow font CDN hold the fluid back for long.
    Promise.race([fontsReady, new Promise((r) => setTimeout(r, 600))]).then(idle);
  }));
}

const dispose = boot();

if (import.meta.env.DEV) {
  // Debug handle for stepping the timeline from devtools.
  Object.assign(window, { __flowstate: { gsap, ScrollTrigger } });
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => dispose());
}
