import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { DrawSVGPlugin } from "gsap/DrawSVGPlugin";
import { ease, media, type MotionConditions } from "../motion/tokens";

const SVG_NS = "http://www.w3.org/2000/svg";
/** Where along the line each step's node sits (0–1). */
const NODE_AT = [0.04, 0.5, 0.96];
/** Dimmed steps stay at 4.5:1 contrast (WCAG AA) against the base. */
const INACTIVE = 0.66;

/**
 * How it works: the section pins while a gradient flow line draws itself
 * through three nodes; each node lights its step on the left.
 * Mobile: no pin, the line draws as the section scrolls past.
 * Reduced motion: everything shown, line fully drawn.
 */
export function init() {
  gsap.registerPlugin(ScrollTrigger, DrawSVGPlugin);

  const section = document.querySelector<HTMLElement>(".how");
  if (!section) return () => {};
  const steps = gsap.utils.toArray<HTMLElement>(section.querySelectorAll("[data-step]"));
  const line = section.querySelector<SVGPathElement>(".flow-line")!;
  const glow = section.querySelector<SVGPathElement>(".flow-glow")!;
  const nodesGroup = section.querySelector<SVGGElement>(".flow-nodes")!;
  const count = section.querySelector<HTMLElement>(".how__count")!;

  // Build the nodes on the path itself so they always sit exactly on the line.
  const length = line.getTotalLength();
  const nodes = NODE_AT.map((at) => {
    const p = line.getPointAtLength(length * at);
    const g = document.createElementNS(SVG_NS, "g");
    g.innerHTML =
      `<circle class="flow-node__halo" cx="${p.x}" cy="${p.y}" r="26" fill="url(#node-halo)"/>` +
      `<circle class="flow-node__core" cx="${p.x}" cy="${p.y}" r="7" fill="#0a0b16" stroke="rgba(255,255,255,0.35)" stroke-width="2"/>`;
    nodesGroup.appendChild(g);
    return {
      halo: g.querySelector<SVGCircleElement>(".flow-node__halo")!,
      core: g.querySelector<SVGCircleElement>(".flow-node__core")!,
    };
  });

  let shown = 0;
  const setActive = (index: number, animate = true) => {
    const direction = index >= shown ? 1 : -1;
    shown = index;
    count.textContent = String(index + 1).padStart(2, "0");
    if (animate) {
      gsap.fromTo(count,
        { yPercent: 70 * direction, opacity: 0 },
        { yPercent: 0, opacity: 1, duration: 0.5, ease: ease.entrance, overwrite: true });
    }
  };

  const lightNode = (tl: gsap.core.Timeline, i: number, at: number, focusSteps: boolean) => {
    tl.to(nodes[i].halo, { scale: 1, autoAlpha: 1, duration: 0.08, ease: ease.outCubic }, at)
      .to(nodes[i].core, { stroke: "#ffffff", fill: "#ffffff", scale: 1.15, duration: 0.06 }, at);
    if (!focusSteps) return;
    tl.to(steps[i], { opacity: 1, "--rail": 1, duration: 0.08, ease: ease.outCubic }, at);
    if (i > 0) tl.to(steps[i - 1], { opacity: INACTIVE, "--rail": 0, duration: 0.08 }, at);
  };

  const mm = gsap.matchMedia();
  mm.add(media, (ctx) => {
    const { desktop, reduced } = ctx.conditions as MotionConditions;

    if (reduced) {
      gsap.set([line, glow], { drawSVG: "100%" });
      gsap.set(nodes.map((n) => n.halo), { autoAlpha: 1, scale: 1 });
      gsap.set(steps, { opacity: 1 });
      return;
    }

    gsap.set([line, glow], { drawSVG: "0%" });
    gsap.set(nodes.map((n) => n.halo), { autoAlpha: 0, scale: 0.3, transformOrigin: "50% 50%" });
    gsap.set(nodes.map((n) => n.core), { transformOrigin: "50% 50%" });
    gsap.set(steps, { opacity: desktop ? INACTIVE : 1, "--rail": 0 });

    // The counter follows the (scrubbed) timeline, not raw scroll, so it never
    // runs ahead of the line.
    const nodeTimes = NODE_AT.map((at) => Math.max(0, at - 0.02));
    let active = -1;
    const tl = gsap.timeline({
      defaults: { ease: ease.none },
      onUpdate() {
        const time = tl.time();
        let next = 0;
        nodeTimes.forEach((t, i) => { if (time >= t) next = i; });
        if (next !== active) setActive((active = next));
      },
      scrollTrigger: desktop
        ? {
            trigger: section,
            start: "top top",
            end: "+=220%",
            pin: true,
            scrub: 0.8,
            anticipatePin: 1,
          }
        : {
            trigger: section.querySelector(".how__visual"),
            start: "top 80%",
            end: "bottom 40%",
            scrub: 0.8,
          },
    });

    tl.to([line, glow], { drawSVG: "100%", duration: 1 }, 0);
    nodeTimes.forEach((at, i) => lightNode(tl, i, at, desktop));
    // Hold on the finished state before the pin releases.
    tl.to({}, { duration: 0.15 });

    return () => setActive(0, false);
  });

  return () => {
    mm.revert();
    nodesGroup.replaceChildren();
  };
}
