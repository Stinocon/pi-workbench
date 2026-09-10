---
name: web-ui
description: "Web UI design conventions — design tokens (CSS variables), color system, light/dark mode, accessibility, file organization, and base features. Use when generating or modifying any web interface: SPA, dashboard, static page, or frontend component. Encodes patterns extracted from real, shipped projects — evidence, not invention."
summary: web UI design conventions (tokens, dark/light, a11y, organization)
---

# Web UI — conventions for web parts

## Quando usarlo

When a project needs a web part — a dashboard, a tool UI, a static page, a frontend component —
apply these conventions. They are extracted from real, shipped projects, so the output looks
like finished work, not generic boilerplate.

## Two tracks — pick by app type

1. **Data-dense SPA / tool** (finance/tool SPAs): React 19 + TypeScript + Vite,
   full design-token system, recharts, tests alongside.
2. **Static / brand page** (content/brand pages): vanilla HTML + one CSS file, zero
   runtime dependencies, works offline.

Rule: reach for the SPA track only when there is real state, routing or charts. Otherwise the
vanilla track is the smaller, more maintainable answer.

## 1. Design tokens — ALWAYS, no magic numbers

Every color, spacing and font size is a **named CSS variable**. Never scatter raw hex/px in
components. The canonical structure:

- **Type scale** — one named step per role, no inline `font-size`:
  `--fs-micro` 11 · `--fs-xs` 12 (caption) · `--fs-sm` 13 (badge/note) · `--fs-base` 14 (body) ·
  `--fs-md` 16 (controls) · `--fs-lg` 18 (section) · `--fs-xl` 22 (stat value) · `--fs-2xl` 26 (title)
- **Spacing scale** — `--space-1` 4 → `--space-2` 8 → `--space-3` 12 → `--space-4` 16 →
  `--space-5` 20 → `--space-6` 24 → `--space-8` 32. No mixed magic numbers.
- **Radii** — two only: `--radius` (cards/panels) and `--radius-sm` (badges/chips/inputs).
- **Semantic colors** — role-named, not color-named:
  `--bg` · `--bg-card` · `--bg-soft` · `--text` · `--text-strong` · `--text-muted` · `--text-subtle` ·
  `--border` · `--accent` · `--accent-bg` · `--accent-on`.
- **Status colors** — always a pair (foreground + background tint + border):
  `--danger/--danger-bg/--danger-bd` · `--warn/…` · `--ok/…` · `--info/…`.
- **Categorical chart palette** — `--c-teal`, `--c-blue`, `--c-gold`, `--c-violet`, `--c-orange`,
  `--c-green`, `--c-rose`, `--c-slate`, `--c-red`, harmonized with the accent.
- **Historical aliases → semantic tokens**: when a color gets a real role, keep the old name as
  an alias (`--cognac: var(--accent)`) so existing code follows the theme automatically.

## 2. Color

- **One accent + neutral surfaces.** The accent is a per-project *brand* choice; the neutrals
  are always low-saturation greys. Examples from real projects: teal `#0f766e` (finance tools),
  warm terracotta/cream (kitchen content), purple-blue gradient (card collection).
- **Every token gets a light AND a dark value.** No token is left theme-less.
- Charts use the categorical palette, never ad-hoc colors.

## 3. Light + dark — ALWAYS

- **SPA:** toggle via `[data-theme="dark"]` on `<html>`; persist in `localStorage`; resolve the
  theme **before render** (saved preference → system `prefers-color-scheme`) so there is no
  flash of the wrong theme on first paint.
- **Static:** `@media (prefers-color-scheme: dark)` redefining the same tokens — no toggle needed.
- Dark surfaces are neutral slate, the accent brightened for contrast (e.g. teal `#0f766e` →
  `#2dd4bf`), and every chart color lightened.

## 4. Accessibility — non-negotiable

- `<html lang="…">` set to the actual UI language (selectable via i18n where relevant).
- Skip-link first in the DOM (visible only on keyboard focus).
- `:focus-visible` outline on the accent, everywhere — keyboard navigation is never blind.
- `@media (prefers-reduced-motion: reduce)` zeroes transitions/animations.
- Correct ARIA: `aria-expanded`, `aria-hidden` on decorative layers, accessible chart
  components (never charts that only color-blind users can't read).
- Guard `[hidden] { display: none !important; }` so no later `.class { display:flex }` overrides it.

## 5. Organization

```
src/
├── main.tsx            # entrypoint: theme set pre-render, mount <App>
├── index.css           # reset + tokens + type scale (the design system)
├── App.css             # layout + navigation + component classes
├── components/         # shared primitives (Stat, Modal, EmptyState, PageHeader, …)
├── pages/              # one file per route/section
│   └── *.test.tsx      # tests live ALONGSIDE the page/component
└── i18n/               # translations when more than one language
```

- Tests alongside (`Vitest` + `Testing Library` in the SPA track).
- One shared primitive instead of per-page copies: if a pattern repeats on three pages,
  extract it (the `Stat` component was born exactly this way).
- Comments explain **why**, not what.

## 6. Base features

- **i18n** — `i18next` (SPA) or `data-i18n` attributes (static); a declared default language.
- **Routing** — `react-router` (SPA only).
- **Markdown rendering** — `react-markdown` when content is prose.
- **Charts** — `recharts`.
- **Offline / no CDN** — no external fonts or icon fonts; icons embedded (Material Symbols /
  `lucide-react`) with `currentColor` fill, favicon as inline SVG or data-URI. The interface
  works with the network unplugged.

## Contratto

- **produces:** a web interface (SPA or static page) that follows this design system
- **consumes:** a UI/web request (page, dashboard, component)

## Provenienza

Extracted from real shipped projects across both tracks (a React+Vite token system with a
dark-mode toggle, an accessible React design system, a vanilla site with a warm palette +
`prefers-color-scheme` + i18n, a static site with `[data-theme="dark"]`). No code copied —
patterns distilled.
