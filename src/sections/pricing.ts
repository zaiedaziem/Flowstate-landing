import { gsap } from "gsap";
import { duration, ease, prefersReducedMotion } from "../motion/tokens";

type Billing = "monthly" | "yearly";

/**
 * Pricing: a segmented monthly/yearly toggle with a sliding thumb, and prices
 * built from rolling digit strips (0–9) that spin to the new value.
 */
export function init() {
  const section = document.querySelector<HTMLElement>(".pricing");
  if (!section) return () => {};

  const buttons = Array.from(section.querySelectorAll<HTMLButtonElement>("[data-billing]"));
  const thumb = section.querySelector<HTMLElement>(".billing__thumb")!;
  const prices = Array.from(section.querySelectorAll<HTMLElement>(".price"));
  const notes = Array.from(section.querySelectorAll<HTMLElement>(".plan__note"));
  const reduced = prefersReducedMotion();
  let billing: Billing = "monthly";

  // Build digit strips once. Width = the longer of the two prices.
  const rollers = prices.map((price) => {
    const amount = price.querySelector<HTMLElement>(".price__amount")!;
    const monthly = price.dataset.monthly ?? "0";
    const yearly = price.dataset.yearly ?? "0";
    const width = Math.max(monthly.length, yearly.length);

    const sr = document.createElement("span");
    sr.className = "sr-only";
    const visual = document.createElement("span");
    visual.setAttribute("aria-hidden", "true");
    visual.style.display = "inline-flex";

    const strips: HTMLElement[] = [];
    for (let i = 0; i < width; i++) {
      const digit = document.createElement("span");
      digit.className = "digit";
      const strip = document.createElement("span");
      strip.className = "digit__strip";
      // Cells 0–9 plus a blank (index 10) so a shorter price can roll its leading digit away.
      strip.innerHTML = Array.from({ length: 10 }, (_, n) => `<span>${n}</span>`).join("") + "<span>&nbsp;</span>";
      digit.appendChild(strip);
      visual.appendChild(digit);
      strips.push(strip);
    }
    amount.replaceChildren(sr, visual);

    const show = (value: string, animate: boolean) => {
      const padded = value.padStart(width, " ");
      sr.textContent = value;
      strips.forEach((strip, i) => {
        const ch = padded[i];
        const index = ch === " " ? 10 : Number(ch);
        const yPercent = -(100 / 11) * index;
        if (animate) {
          gsap.to(strip, {
            yPercent,
            duration: duration.slow,
            ease: ease.outExpo,
            delay: i * 0.07,
            overwrite: true,
          });
        } else {
          gsap.set(strip, { yPercent });
        }
      });
    };

    show(monthly, false);
    return { show, monthly, yearly };
  });

  const moveThumb = (animate: boolean) => {
    const active = buttons.find((b) => b.dataset.billing === billing);
    if (!active) return;
    const props = { x: active.offsetLeft, width: active.offsetWidth };
    if (animate && !reduced) gsap.to(thumb, { ...props, duration: duration.base, ease: ease.entrance, overwrite: true });
    else gsap.set(thumb, props);
  };

  const setBilling = (next: Billing) => {
    if (next === billing) return;
    billing = next;
    buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.billing === next)));
    moveThumb(true);
    rollers.forEach((r) => r.show(next === "monthly" ? r.monthly : r.yearly, !reduced));
    notes.forEach((note) => {
      const text = (next === "monthly" ? note.dataset.noteMonthly : note.dataset.noteYearly) ?? "";
      if (note.textContent === text) return;
      if (reduced) {
        note.textContent = text;
        return;
      }
      gsap.timeline()
        .to(note, { opacity: 0, y: -6, duration: 0.2, ease: "power2.in" })
        .add(() => { note.textContent = text; })
        .fromTo(note, { y: 6 }, { opacity: 1, y: 0, duration: 0.45, ease: ease.entrance });
    });
  };

  const onClick = (e: Event) => setBilling((e.currentTarget as HTMLElement).dataset.billing as Billing);
  buttons.forEach((b) => b.addEventListener("click", onClick));

  // Fonts and the rem grid change button widths; keep the thumb glued.
  const ro = new ResizeObserver(() => moveThumb(false));
  buttons.forEach((b) => ro.observe(b));
  moveThumb(false);

  return () => {
    buttons.forEach((b) => b.removeEventListener("click", onClick));
    ro.disconnect();
    gsap.killTweensOf(thumb);
  };
}
