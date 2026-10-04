import { gsap } from "gsap";
import { SplitText } from "gsap/SplitText";
import { ease, duration, hero as t, rem } from "../motion/tokens";

/**
 * Hero entrance per SPEC.md: nav → badge → heading (word-by-word) →
 * sub-line (word-by-word) → form → footer line. Runs immediately at boot so
 * text paints before the fluid starts.
 */
export function init(reduced: boolean) {
  gsap.registerPlugin(SplitText);

  const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
  const nav = q(".site-nav__inner");
  const badge = q('[data-hero="badge"]');
  const title = q('[data-hero="title"]');
  const sub = q('[data-hero="sub"]');
  const form = q('[data-hero="form"]');
  const foot = q('[data-hero="foot"]');
  if (!nav || !badge || !title || !sub || !form || !foot) return () => {};

  const splits: SplitText[] = [];
  const tl = gsap.timeline();

  if (reduced) {
    // Simple, gentle fades in the same order — no translation.
    const blocks = [nav, badge, title, sub, form, foot];
    gsap.set(blocks, { opacity: 0 });
    document.documentElement.classList.add("hero-ready");
    blocks.forEach((el, i) => tl.to(el, { opacity: 1, duration: 0.6, ease: "none" }, 0.1 + i * 0.12));
  } else {
    const titleSplit = SplitText.create(title, { type: "words", wordsClass: "word", tag: "span", aria: "none" });
    const subSplit = SplitText.create(sub, { type: "words", wordsClass: "word", tag: "span", aria: "none" });
    splits.push(titleSplit, subSplit);

    const blockFrom = { opacity: 0, y: rem(t.blockFromY) };
    const blockTo = { opacity: 1, y: 0, duration: duration.base, ease: ease.entrance };

    // Start states, then let CSS stop hiding the blocks — same frame, no flash.
    gsap.set(nav, { opacity: 0, y: rem(t.navFromY) });
    gsap.set([badge, form, foot], blockFrom);
    gsap.set([title, sub], { opacity: 1 });
    gsap.set(titleSplit.words, { opacity: 0, y: t.headingFromY });
    gsap.set(subSplit.words, { opacity: 0, y: t.subFromY });
    document.documentElement.classList.add("hero-ready");

    tl.to(nav, { ...blockTo }, t.navDelay)
      .to(badge, { ...blockTo }, t.badgeDelay)
      .to(titleSplit.words, {
        opacity: 1,
        y: 0,
        duration: t.headingDuration,
        ease: ease.outCubic,
        stagger: t.headingStagger,
      }, t.headingDelay)
      .to(subSplit.words, {
        opacity: 1,
        y: 0,
        duration: t.subDuration,
        ease: ease.outCubic,
        stagger: t.subStagger,
      }, t.subDelay)
      .to(form, { ...blockTo }, t.formDelay)
      .to(foot, { ...blockTo }, t.footDelay);
  }

  return () => {
    tl.kill();
    splits.forEach((s) => s.revert());
    gsap.set([nav, badge, title, sub, form, foot], { clearProps: "all" });
  };
}
