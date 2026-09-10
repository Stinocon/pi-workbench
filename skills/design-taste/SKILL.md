---
name: design-taste
description: Anti-slop aesthetic judgment for frontends — read the brief, declare a one-line design read, set the variance/motion/density dials, and avoid the LLM default tells (AI-purple gradients, three equal cards, Inter+slate, centered heroes, fake-precise numbers). Complements web-ui, which owns the HOW (tokens, a11y, structure); this skill owns the WHAT (direction and taste). Use when generating or judging any landing page, portfolio, brand page or redesign.
summary: anti-slop design judgment (brief read -> dials -> tells -> pre-flight)
---

# Design taste — the aesthetic layer web-ui does not cover

`web-ui` encodes **how** to build a frontend: design tokens, light/dark, accessibility,
file organization. This skill encodes the layer above it — **what** the interface should look
like and why. Most LLM design output is bad because the model jumps to a default aesthetic
instead of reading the brief. This skill forces the judgment first, then the pixels.

Where the two skills touch, `web-ui` wins for projects that follow its stack (it is the source
of truth for that stack: CSS variables, no Tailwind, no CDN, offline). The stack guidance below
applies only when a project already lives on a different stack.

## The loop

1. Read the brief → infer the **design read** (one line, declared before any code).
2. Set the **three dials** (variance / motion / density) from the read.
3. Build — but never on the LLM defaults; reach past them deliberately.
4. Run the **pre-flight check** before declaring done.

## 1. Read the brief before anything else

Before touching code, infer what is actually wanted. Read these signals:

- **Page kind** — landing (SaaS / consumer / agency / event), portfolio (dev / designer / studio),
  redesign (preserve vs overhaul), editorial / blog.
- **Vibe words** — "minimalist", "Linear-style", "Awwwards", "brutalist", "premium consumer",
  "Apple-y", "playful", "serious B2B", "editorial", "glassy", "dark tech".
- **Reference signals** — URLs, screenshots, products named, brands the client competes with.
- **Audience** — the audience picks the aesthetic, not the model's taste.
- **Existing brand assets** — logo, colors, type, photography. For redesigns these are starting
  material, not optional input.
- **Quiet constraints** — accessibility-first, public-sector, regulated, trust-first commerce.
  These OVERRIDE aesthetic preference.

Then declare, in one line, before any code:

> "Reading this as: B2B SaaS landing for technical buyers, with a Linear-style minimalist
> language, leaning toward Tailwind utilities + Geist + restrained motion."

If the read genuinely diverges (two plausible directions), ask **exactly one** question — never a
multi-question dump. If you can infer confidently, do not ask; declare and proceed.

## 2. Anti-default discipline

The LLM defaults to avoid, unless the brief explicitly asks for them:

- AI-purple / blue-glow gradients; centered hero over a dark mesh
- three equal feature cards in a row
- Inter + slate-900 as the unthinking font/neutral pair
- generic glassmorphism on everything; infinite-loop micro-animations everywhere
- centered hero when a split / asymmetric / editorial composition would serve better

Reach past these **based on the design read**, not as a checklist of "don'ts" applied uniformly.

## 3. The three dials

Set three explicit values from the read. They gate every layout, motion and density decision.

- `VARIANCE` 1–10 — 1 = perfect symmetry, 10 = artsy chaos.
- `MOTION` 1–10 — 1 = static, 10 = cinematic / physics.
- `DENSITY` 1–10 — 1 = airy gallery, 10 = cockpit / packed data.

Baseline `8 / 6 / 4` for a default marketing page. Inference:

| Signal | VARIANCE | MOTION | DENSITY |
|---|---|---|---|
| minimalist / calm / editorial / Linear-style | 5–6 | 3–4 | 2–3 |
| premium consumer / Apple-y / luxury / brand | 7–8 | 5–7 | 3–4 |
| playful / Dribbble / Awwwards / experimental | 9–10 | 8–10 | 3–4 |
| trust-first / public-sector / a11y-critical | 3–4 | 2–3 | 4–5 |
| redesign — preserve | match existing | +1 | match existing |
| redesign — overhaul | +2 | +2 | match existing |

Use these exact names — never invent aliases. Overrides happen conversationally, not by editing
the file.

## 4. Real design system, or honest aesthetic

If the brief maps to a real design system, use the **official package** — do not hand-recreate
its CSS, and do not import its tokens then override 90% of them. One system per project.

- Microsoft / enterprise SaaS → Fluent UI · Google/Material → `@material/web` · IBM B2B →
  Carbon · Shopify surfaces → Polaris · Atlassian → Atlaskit · GitHub-style devtool → Primer ·
  UK public-sector → govuk-frontend · US public-sector → USWDS · modern SaaS owning components →
  shadcn/ui (never default state).

If the brief is an **aesthetic, not a system** (glassmorphism, bento, brutalism, editorial,
dark-tech, aurora, kinetic type), there is no official package: build it, and be honest in
comments about what is borrowed inspiration vs official material. Never present a trend as an
official system.

For projects that follow `web-ui`, the default is its token system (CSS variables, no framework
dependency). The Tailwind/Next.js/Motion defaults below apply only to a project already on that
stack.

## 5. Banned AI tells

These are the signatures a model defaults to when it "tries to look designed". Hard bans unless
the brief calls for one explicitly:

**Visual** — no neon/outer glows (use inner borders or tinted shadows); no pure `#000000`/`#ffffff`
(off-black / off-white); no oversaturated accents; no gradient text on large headers; no custom
mouse cursors; no div-based fake screenshots (fake terminal, fake dashboard built of `<div>`s) —
use a real screenshot, a generated image, or none.

**Typography** — no Inter as unthinking default (Geist / Outfit / Cabinet Grotesk / a brand
serif first); **serif is not the default for "creative" briefs** — it needs an explicit reason
(editorial / luxury / publication), and never `Fraunces`/`Instrument_Serif` (the LLM favorites);
emphasis inside a headline = italic/bold of the SAME family, never a random serif word injected
into a sans headline.

**Content** — no "John Doe"/"Acme"/"Nexus" names; no filler verbs ("Elevate", "Seamless",
"Unleash", "Next-Gen"); no fake-precise numbers (`99.99%`, `13.4 lb`) unless the data is real or
labeled mock — invented engineering precision is worse than no number; no micro-meta sentences
under eyebrows ("each of these is a feature we ship today…").

**Structure** — no three equal feature cards; no 3+ consecutive image+text zigzag sections; no
two sections sharing the same layout family (8 sections → ≥ 4 different families); no eyebrow
(small uppercase label) above every section header — max 1 eyebrow per 3 sections, the headline
alone is enough; no section-number eyebrows (`001 · Capabilities`); no scroll cues; no
decoration text strip at the hero bottom (`BRAND. MOTION. SPATIAL.`).

**Copy in the interface** — em-dashes (`—`) are banned in headlines, buttons, eyebrows, captions
and button text (use a period, comma, colon, or hyphen). This applies to **interface copy**, not
to long-form prose documents. One CTA label per intent — never
"Get in touch" + "Let's talk" + "Start a project" on the same page; no CTA label wrapping to two
lines at desktop (shorten or widen, never both); no hero overflowing the first viewport (headline
≤ 2 lines, subtext ≤ 20 words, CTA visible without scroll).

## 6. Color and consistency locks

- Max **one** accent; saturation below ~80% by default; one neutral family per project (do not mix
  warm and cool greys).
- **Consistency locks** (audit before shipping): the accent is the SAME on every section; ONE
  corner-radius system (all-sharp / all-soft / all-pill, or a documented rule); ONE page theme —
  no section inverting to the opposite mode mid-scroll.
- The "premium consumer" AI palette (warm beige + brass/clay/oxblood + espresso text) is banned as
  the default reach — it is the palette every generated premium site ships. Rotate families
  (cold luxury, forest, black-and-tan, cobalt+cream, terracotta+slate); never the same warm-craft
  palette twice in a row.

## 7. Motion discipline

- Motion must be **motivated**: each animation answers one of hierarchy / storytelling / feedback /
  state-transition. "It looked cool" is not a reason.
- Animate only `transform` and `opacity`. Never `window.addEventListener('scroll')` — use
  scroll-driven animations, `useScroll`, ScrollTrigger or IntersectionObserver.
- Any motion above `MOTION > 3` honors `prefers-reduced-motion` (collapse to static).
- "Motion claimed, motion shown": if `MOTION > 4`, the page must actually move. If you cannot ship
  working motion in scope, lower the dial and ship a clean static page — never half-built motion.

## 8. Redesign protocol

Misclassifying greenfield vs redesign is the biggest source of bad redesign output. Detect the mode
first; if ambiguous, ask once ("preserve the brand, or start visually from scratch?").

- **Audit before touching**: brand tokens, information architecture, content blocks, patterns to
  preserve, patterns to retire, and the **SEO baseline** (slugs, meta, structured data — SEO
  migration is the #1 redesign risk).
- **Preserve by default**: URL structure, primary nav labels, form field names/order, brand
  logo/wordmark, legal copy, analytics events. Never change these silently.
- **Modernise in order of leverage**: typography → spacing/rhythm → color recalibration → motion →
  hero recomposition → full block replacement (only when unsalvageable).

## 9. Pre-flight check

Run before declaring a page done. Every box; a single unticked box = not done.

- [ ] Design read declared (one line) and dials explicit, reasoned from the brief
- [ ] Real design system used (official package) OR aesthetic labeled honestly — no hand-rolled clone
- [ ] Zero em-dashes in interface copy; no AI tells from §5; no fake-precise numbers
- [ ] One accent, one neutral family, one radius system, one page theme (§6)
- [ ] CTA contrast passes WCAG AA; no wrapped CTA; one label per intent
- [ ] Hero fits the first viewport; headline ≤ 2 lines; subtext ≤ 20 words
- [ ] Eyebrow count ≤ ceil(sections/3); no 3+ zigzag repeats; ≥ 4 layout families across 8 sections
- [ ] Every visible string re-read (copy self-audit): no broken grammar, no AI-cute copy
- [ ] Real images present — no div-based fake screenshots, no pure-text page
- [ ] Motion motivated and reduced-motion-safe; dark mode tested in both modes; mobile collapse explicit
- [ ] For `web-ui` projects: conventions hold (tokens, `lang`, skip-link, `:focus-visible`, no CDN)

## Contratto

- **produces:** a frontend (or a design judgment on one) with an explicit direction, not boilerplate
- **consumes:** a UI request — landing page, portfolio, brand page, or redesign
- **does not own:** the structural HOW — tokens, a11y, file layout (that is `web-ui`); long-form prose

## Provenienza

The anti-slop brief→dial→tells method and the "honest design system vs aesthetic" distinction,
reconciled with `web-ui` (its stack conventions win) — no external code copied, per the "Idea
yes, plugin no" rule.
