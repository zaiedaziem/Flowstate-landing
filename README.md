# Flowstate

Waitlist landing page for **Flowstate**, a deep-work app. The page runs over a full-bleed WebGL ink-in-water fluid simulation. The hero follows the original single-file spec exactly; eight more sections extend it in the same palette, glass style and motion language.

Stack: **Vite + TypeScript** (vanilla), **GSAP** (ScrollTrigger, SplitText, DrawSVG, CustomEase), **Lenis**, raw **WebGL** and plain CSS with custom properties.

## Run

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # tsc --noEmit && vite build → dist/
npm run preview    # serve dist/ on http://localhost:4173
```

Node 18+ is required (developed on Node 22).

## Architecture

```
index.html                 markup for every section, meta/OG, inline SVG favicon
public/robots.txt
src/
  main.ts                  boot order, reduced-motion + pointer checks, HMR teardown
  fluid/fluid.ts           createFluid(canvas, opts) → { pause, resume, setQuality, quality, destroy }
  motion/
    tokens.ts              easing + duration tokens, SPEC hero timings, media conditions, rem()
    scroll.ts              Lenis on gsap.ticker, anchors, progress bar, nav hide/show, scrim/veil
    reveal.ts              shared [data-reveal] system (batched fade-up + masked title lines)
    cursor.ts              dot + ring cursor (fine pointer only)
    magnetic.ts            magnetic white pills (fine pointer only)
  sections/                one module per section; each init() returns its cleanup
    hero.ts how.ts features.ts stats.ts products.ts pricing.ts blog.ts cta.ts footer.ts forms.ts
  styles/
    tokens.css             SPEC color tokens verbatim, plus accent/surface/spacing tokens
    base.css               reset, SPEC adaptive rem grid, a11y helpers, Lenis
    components.css         fluid/scrim/veil layers, progress, cursor, glass, pill, waitlist bar
    hero.css               nav + hero (SPEC geometry), first-paint guards
    sections.css           all sections below the hero
legacy/single-file.html    the original single-file build, kept for reference
```

### Boot order (`src/main.ts`)

1. Read flags (`prefers-reduced-motion`, fine pointer), register GSAP plugins and the `entrance` ease.
2. **Hero runs synchronously.** It splits the words and sets start states, then adds `.hero-ready` in the same frame so nothing flashes. Lenis and ScrollTrigger are set up next. This is the only blocking work, so the hero text is the first paint and the LCP element.
3. **After first paint**, the section modules init one per task and yield to the main thread between them. `[data-reveal]` blocks stay hidden by CSS until the reveal system owns them. A timer backs up rAF, so setup still runs in background tabs.
4. **After first paint, fonts (capped at 600ms) and an idle slot**, the fluid engine is dynamically imported (it's code-split). Its shaders compile in parallel and it starts on the frame they're ready, then the canvas fades in with the load burst. If WebGL or half-float render targets are missing, or start-up fails, `html.no-webgl` switches to the CSS gradient fallback.
5. `document.fonts.ready` triggers `ScrollTrigger.refresh()`, since Onest changes line lengths.

All teardown runs in reverse, and Vite HMR disposes everything cleanly.

### How the fixed canvas, Lenis and ScrollTrigger coexist

- **Layers:** the canvas, scrim and veil are `position: fixed` at z-index 0–1, and `main` and the footer sit at z-index 10. They never move, so pins and transforms can't affect them. The canvas uses `pointer-events: none`; the engine reads pointer input from `window`, using a rect cached by a ResizeObserver.
- **One clock:** Lenis smooths *native* scrolling, driven by `gsap.ticker` with `lagSmoothing(0)`. `lenis.on("scroll", ScrollTrigger.update)` keeps ScrollTrigger in sync, the window stays the scroller, and pins keep using `position: fixed`.
- **Layout reads:** the fluid never reads layout per frame. Size comes from a ResizeObserver, so it never forces a reflow while GSAP writes transforms.
- **Atmosphere:** the scrim is the SPEC radial gradient. A center-weighted veil fades in after the hero, so the ink is dimmed behind reading sections. Both lift away for the final CTA so the fluid is at its most vivid, and the veil returns for the footer.

### Fluid engine

`src/fluid/fluid.ts` ports the SPEC's engine (Pavel Dobryakov's WebGL fluid, MIT). The simulation, shaders, config, 34-splat burst with 8 follow-up waves, cyan→magenta color band and 300px breathing auto-cursor orbit are all unchanged. The additions are lifecycle only:

- **DPR:** devicePixelRatio is capped at **1.5**. All splat and orbit maths runs in CSS px, so the look is identical at any DPR.
- **Adaptive quality:** after a 45-frame warm-up, the engine averages frame time over 60 frames. If the average exceeds 22ms, it steps down a tier: 200/512 → 128/384 → 96/256 (SIM/DYE). Mobile (coarse pointer or a small screen) starts at tier 1.
- **Pausing:** the engine pauses when the tab is hidden (`visibilitychange`) or the canvas isn't intersecting (IntersectionObserver).
- **Reduced motion:** the engine simulates 30 steps of the burst, renders one calm frame and stops. There's no auto-cursor and no pointer input.
- **Non-blocking start:** shaders compile with `KHR_parallel_shader_compile`. Programs the config never uses (bloom, checkerboard) are only created if needed.
- **Cleanup:** GPU resources replaced on resize or quality change are deleted, and context loss falls back to CSS.

## Performance

These are Lighthouse 12 results against `npm run preview`, run in headless Chrome:

| Preset | Performance | Accessibility | Best Practices | SEO | LCP | TBT | CLS |
|---|---|---|---|---|---|---|---|
| Mobile (simulated 4× CPU, slow 4G) | 99 | 100 | 100 | 100 | 1.6 s | 20 ms | 0.001 |
| Desktop | 100 | 100 | 100 | 100 | 0.4 s | 0 ms | 0.001 |

- **Code splitting and startup:** the fluid is code-split and starts after first paint, and section init is chunked across tasks.
- **Fonts:** the font CSS is non-blocking (`preload` → `stylesheet`, `display=swap`), with `preconnect` to both Google Fonts hosts.
- **Animated properties:**
  - Animation is limited to `transform` and `opacity`.
  - The exceptions are the self-drawing SVG stroke (DrawSVG, inherently `stroke-dashoffset`) and two CSS variables that map to `transform: scaleX()`.
  - `will-change` is used only on the horizontally scrolling track.
- **Mobile:** no tilt, no custom cursor, no magnetic pills, no horizontal pin (Products stacks vertically), and a lower base fluid tier.

## Accessibility and fallbacks

- **Reduced motion** (`prefers-reduced-motion: reduce`):
  - No Lenis, pinning, parallax, counters or ambient CSS loops.
  - Reveals become plain fades.
  - The fluid renders one static frame.
- **No WebGL or half-float targets:** a typed `FluidUnsupportedError` triggers the drifting CSS gradient fallback, with no console errors.
- **Semantics:**
  - Semantic landmarks (`header`, `nav` ×2 with labels, `main`, `footer`), a skip link and visible `:focus-visible` rings.
  - The nav reappears when it receives focus.
- **Reveals and split text:**
  - Reveals animate `opacity`, not `visibility`, so unrevealed content stays in the accessibility tree.
  - Split text keeps real text nodes.
- **Forms:**
  - A visually hidden `<label>` on each input.
  - `novalidate` with custom messages, `aria-invalid` and `aria-describedby`.
  - A `role="status"` live region announces errors and success.
  - The success state locks the input and confirms on the button.
- **Animated numbers:** count-ups and rolling price digits are `aria-hidden`, with a `.sr-only` final value beside them.
- **Contrast:** dimmed How-it-works steps stay at ≥4.5:1, and the CTA reveal moves the text rather than fading it, so it's always at full contrast.

## Animation techniques

**Global**
- WebGL fluid: load burst, perpetual orbiting auto-cursor and pointer/touch stirring. On start it fades in with the burst.
- Lenis smooth scroll on the GSAP ticker.
- Ink-gradient scroll progress bar (`scaleX`, scrubbed).
- Nav: an entrance reveal, then hides on scroll down and returns on scroll up (`yPercent`). It gains a soft backing once scrolled.
- Scroll-driven atmosphere: veil and scrim opacity scrubbed across hero → sections → CTA → footer.
- Dot + ring custom cursor: `quickTo` follow with the ring trailing. It swells over interactive elements, steps aside over text fields and squeezes on press.
- Magnetic white pills: the button and its label pull toward the pointer at different strengths for depth, then release with an elastic ease.
- Shared reveal system: batched, staggered fade-up. Section titles rise line by line out of SplitText masks, split lazily at reveal time.

**Hero** (SPEC timings)
- Staggered block reveals: nav 150ms, badge 320ms, form 1450ms, footer 1650ms (`entrance` ease, ~700ms).
- Word-by-word heading via SplitText: 480ms start, 85ms stagger, 720ms per word, +26px, easeOutCubic.
- Word-by-word sub-line: 1150ms start, 22ms stagger, 600ms per word, +14px.

**How it works**
- Pinned for 220% of the viewport.
- A gradient SVG flow line draws itself (DrawSVG) with a glow pass.
- Nodes generated on the path light up as the line reaches them, the matching step brightens and its ink rail scales in.
- A rolling step counter is driven by the scrubbed timeline, not raw scroll.
- On mobile there's no pin; the line draws as it passes.

**Features**
- Six-card glass bento.
- A spotlight glow follows the pointer (`transform`) and the card tilts in 3D toward it (`quickTo` rotationX/Y), with scroll-stale rect handling.
- Ambient CSS loops: equalizer bars and sync pulses.

**Stats**
- Count-ups (expo out) with tabular figures, fired once on enter.

**Products**
- Pinned horizontal scroll.
- Parallax layers inside each panel use `containerAnimation`: glow, mock UI and floating chip at three depths.
- Focus falloff: the panel crossing the center is lit and neighbors recede (opacity and scale).
- A progress bar tracks the pin.
- On mobile the panels stack, with a vertical parallax.

**Pricing**
- A segmented toggle with a sliding thumb.
- Rolling digit strips (0–9 plus a blank) spin to the new price with a per-digit stagger.
- The billing note crossfades.
- The Pro card's border is a conic gradient rotating behind a 1px inset (`transform: rotate`).

**Blog**
- Gradient thumbnails with grain and scrubbed inner parallax.
- On hover, the thumbnail zooms and the arrow hands off: the old arrow exits right while the new one enters from the left.

**Final CTA**
- Scroll-scrubbed word reveal: words rise and un-rotate out of per-line masks.
- The fluid is at its most visible here.

**Footer**
- An oversized gradient wordmark rises letter by letter from the bottom edge, scrubbed.

**Forms**
- A shake keyframe on invalid input; on success the button label swaps with a check icon.

## Motion review: the five weakest moments, and what changed

The site was reviewed after the build, and these five moments were reworked:

1. **The fluid cold-started with a hard cut.**
   - Before: the canvas sat black, then the burst popped in mid word reveal.
   - Now: the engine signals `onReady`, and the canvas blooms in over 0.9s with the burst.
2. **Copy over the white-hot orbit.**
   - Before: the auto-cursor's 3.2× ink burned through an even veil exactly where centered copy sits.
   - Now: the veil is center-weighted, and the CTA scrim keeps 50%.
3. **Every heading moved like a caption.**
   - Before: section titles shared the generic fade-up.
   - Now: they rise line by line from masks, so headings lead and body copy follows.
4. **The Products track felt like a conveyor.**
   - Before: every panel was equally lit.
   - Now: there's a scrubbed focus falloff (opacity and scale), so the panel in front reads as "the one."
5. **The step counter hard-cut its digits.**
   - Before: everything around the counter eased, but the counter itself jumped.
   - Now: it rolls in the direction of travel.

## Notes

- `SPEC.md` was not in the repository. The spec used is the original single-file brief, whose output is preserved in `legacy/single-file.html`.
- **Deviations from that brief:**
  - The header is `position: fixed` (site-wide) instead of `absolute`.
  - The waitlist message is absolutely positioned so it never shifts the hero.
  - Everything else in the hero is per spec.
- There's no `og:image` because the project has no image assets. Add a 1200×630 PNG and an `og:image` / `twitter:image` tag before launch.
- In development, `window.__flowstate` exposes `gsap` and `ScrollTrigger` for stepping timelines from devtools. It's stripped from production builds.
