import { gsap } from "gsap";
import { duration, ease, prefersReducedMotion } from "../motion/tokens";

const CHECK_SVG =
  '<svg class="waitlist__check" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8.5l3 3 7-7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/**
 * Waitlist forms (hero + CTA). No backend — validation, an accessible error,
 * and a success state that is announced via the role=status message.
 */
export function init() {
  const disposers: Array<() => void> = [];
  const reduced = prefersReducedMotion();

  document.querySelectorAll<HTMLFormElement>("form[data-waitlist]").forEach((form) => {
    const input = form.querySelector<HTMLInputElement>("input[type=email]")!;
    const button = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
    const label = button.querySelector<HTMLElement>(".pill__label")!;
    const msg = form.querySelector<HTMLElement>(".waitlist__msg")!;
    const bar = form.querySelector<HTMLElement>(".waitlist__bar")!;

    const setMessage = (text: string) => {
      msg.textContent = text;
      if (!reduced) gsap.fromTo(msg, { opacity: 0, y: -4 }, { opacity: 1, y: 0, duration: duration.hover, ease: ease.entrance });
    };

    const onSubmit = (e: SubmitEvent) => {
      e.preventDefault();
      if (form.dataset.state === "success") return;

      if (!input.checkValidity()) {
        form.dataset.state = "error";
        input.setAttribute("aria-invalid", "true");
        setMessage(input.validity.valueMissing ? "Please enter your email address." : "That doesn’t look like a valid email address.");
        if (!reduced) gsap.to(bar, { keyframes: { x: [0, -6, 5, -3, 2, 0] }, duration: 0.4, ease: "none" });
        input.focus();
        return;
      }

      form.dataset.state = "success";
      input.removeAttribute("aria-invalid");
      input.readOnly = true;
      button.disabled = true;
      button.setAttribute("aria-disabled", "true");
      label.innerHTML = `${CHECK_SVG}<span>You’re in</span>`;
      setMessage("You’re on the list. We’ll email you once, when your seat opens.");
      if (!reduced) gsap.fromTo(label, { y: 8, opacity: 0 }, { y: 0, opacity: 1, duration: duration.base, ease: ease.entrance });
    };

    const onInput = () => {
      if (form.dataset.state !== "error") return;
      delete form.dataset.state;
      input.removeAttribute("aria-invalid");
      msg.textContent = "";
    };

    form.addEventListener("submit", onSubmit);
    input.addEventListener("input", onInput);
    disposers.push(() => {
      form.removeEventListener("submit", onSubmit);
      input.removeEventListener("input", onInput);
    });
  });

  return () => disposers.splice(0).forEach((dispose) => dispose());
}
