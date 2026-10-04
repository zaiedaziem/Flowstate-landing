import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { media, rem, type MotionConditions } from "../motion/tokens";

/**
 * Products: on desktop the section pins and the track scrolls horizontally;
 * inside each panel, [data-depth] layers drift at different rates against
 * the horizontal motion (containerAnimation). Mobile stacks vertically with a
 * light vertical parallax. Reduced motion: static stack (CSS handles layout).
 */
export function init() {
  gsap.registerPlugin(ScrollTrigger);
  const section = document.querySelector<HTMLElement>(".products");
  if (!section) return () => {};
  const pin = section.querySelector<HTMLElement>(".products__pin")!;
  const track = section.querySelector<HTMLElement>(".products__track")!;
  const fill = section.querySelector<HTMLElement>(".products__progress-fill");
  const panels = gsap.utils.toArray<HTMLElement>(track.children);

  const mm = gsap.matchMedia();
  mm.add(media, (ctx) => {
    const { desktop, mobile } = ctx.conditions as MotionConditions;

    if (desktop) {
      const distance = () => Math.max(0, track.scrollWidth - pin.clientWidth);

      const scroll = gsap.to(track, {
        x: () => -distance(),
        ease: "none",
        scrollTrigger: {
          trigger: pin,
          start: "top top",
          end: () => "+=" + distance(),
          pin: true,
          scrub: 0.6,
          anticipatePin: 1,
          invalidateOnRefresh: true,
          onUpdate(self) {
            if (fill) gsap.set(fill, { scaleX: self.progress });
          },
        },
      });

      panels.forEach((panel) => {
        // Focus: the panel crossing the centre is fully lit; neighbours recede.
        gsap.timeline({
          scrollTrigger: {
            trigger: panel,
            containerAnimation: scroll,
            start: "left right",
            end: "right left",
            scrub: true,
          },
        })
          .fromTo(panel, { opacity: 0.35, scale: 0.94 }, { opacity: 1, scale: 1, ease: "power2.out", duration: 1 })
          .to(panel, { opacity: 0.35, scale: 0.94, ease: "power2.in", duration: 1 });

        panel.querySelectorAll<HTMLElement>("[data-depth]").forEach((layer) => {
          const depth = parseFloat(layer.dataset.depth ?? "1");
          gsap.fromTo(layer,
            { x: () => rem(5) * depth },
            {
              x: () => -rem(5) * depth,
              ease: "none",
              scrollTrigger: {
                trigger: panel,
                containerAnimation: scroll,
                start: "left right",
                end: "right left",
                scrub: true,
                invalidateOnRefresh: true,
              },
            });
        });
      });
    }

    if (mobile) {
      panels.forEach((panel) => {
        panel.querySelectorAll<HTMLElement>("[data-depth]").forEach((layer) => {
          const depth = parseFloat(layer.dataset.depth ?? "1");
          gsap.fromTo(layer,
            { y: () => rem(1.5) * depth },
            {
              y: () => -rem(1.5) * depth,
              ease: "none",
              scrollTrigger: { trigger: panel, start: "top bottom", end: "bottom top", scrub: true },
            });
        });
      });
    }
  });

  return () => mm.revert();
}
