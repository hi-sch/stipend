---
name: Stipend
description: Light operate dashboard for named envelopes — warm paper, pastel KPI plates, one charcoal total, pill-active nav.
colors:
  accent: "#5b4fe0"
  lilac: "#e7e3f8"
  lilac-ink: "#3d348b"
  peach: "#f3e4d2"
  peach-ink: "#7a4e22"
  mint: "#d8efe8"
  mint-ink: "#1d6b5c"
  dark: "#171717"
  dark-2: "#2a2a2a"
  on-dark: "#f6f6f4"
  paper: "#ffffff"
  sidebar: "#f8f8f8"
  surface: "#ffffff"
  ink: "#141416"
  muted: "#6b717c"
  line: "#eceef2"
  danger: "#c4473a"
  ok: "#1f8a6e"
  envelope-violet: "#7C6CF0"
  envelope-clay: "#C9894A"
  envelope-teal: "#2F9E8A"
  wash: "#f4f5f8"
  ok-wash: "#e4f5ee"
  ok-wash-ink: "#176b50"
  warn-wash: "#f8ead3"
  danger-wash: "#f8e1dd"
  danger-wash-ink: "#9a3026"
  selection: "#dcd6f8"
typography:
  display:
    fontFamily: "Atkinson Hyperlegible, Segoe UI, sans-serif"
    fontSize: "1.85rem"
    fontWeight: 700
    letterSpacing: "-0.03em"
    fontFeature: "tabular-nums"
  headline:
    fontFamily: "Atkinson Hyperlegible, Segoe UI, sans-serif"
    fontSize: "1.45rem"
    fontWeight: 700
    letterSpacing: "-0.03em"
  title:
    fontFamily: "Atkinson Hyperlegible, Segoe UI, sans-serif"
    fontSize: "1.05rem"
    fontWeight: 700
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Atkinson Hyperlegible, Segoe UI, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    letterSpacing: "-0.011em"
  label:
    fontFamily: "Atkinson Hyperlegible, Segoe UI, sans-serif"
    fontSize: "0.78rem"
    fontWeight: 400
    letterSpacing: "normal"
rounded:
  sm: "12px"
  md: "14px"
  lg: "16px"
  xl: "22px"
  pill: "999px"
  full: "50%"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "22px"
  2xl: "28px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "#ffffff"
    rounded: "{rounded.pill}"
    padding: "10px 16px"
    typography: "{typography.title}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "10px 16px"
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "#ffffff"
    rounded: "{rounded.pill}"
    padding: "10px 16px"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.xl}"
    padding: "20px 22px"
  kpi-lilac:
    backgroundColor: "{colors.lilac}"
    textColor: "{colors.lilac-ink}"
    rounded: "{rounded.xl}"
    padding: "20px 22px 16px"
    height: "168px"
  kpi-peach:
    backgroundColor: "{colors.peach}"
    textColor: "{colors.peach-ink}"
    rounded: "{rounded.xl}"
    padding: "20px 22px 16px"
    height: "168px"
  kpi-dark:
    backgroundColor: "{colors.dark}"
    textColor: "{colors.on-dark}"
    rounded: "{rounded.xl}"
    padding: "20px 22px 16px"
    height: "168px"
  chip:
    backgroundColor: "#f1f2f6"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "4px 8px"
    typography: "{typography.label}"
  chip-on-ink:
    backgroundColor: "#2c2c2c"
    textColor: "#ffffff"
    rounded: "{rounded.pill}"
    padding: "4px 8px"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.pill}"
    padding: "11px 14px"
  nav-item-active:
    backgroundColor: "{colors.ink}"
    textColor: "#ffffff"
    rounded: "{rounded.pill}"
    padding: "11px 14px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "10px 12px"
  search:
    backgroundColor: "{colors.wash}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "8px 14px"
  badge-ok:
    backgroundColor: "{colors.ok-wash}"
    textColor: "{colors.ok-wash-ink}"
    rounded: "{rounded.pill}"
    padding: "3px 8px"
  badge-warn:
    backgroundColor: "{colors.warn-wash}"
    textColor: "{colors.peach-ink}"
    rounded: "{rounded.pill}"
    padding: "3px 8px"
  badge-bad:
    backgroundColor: "{colors.danger-wash}"
    textColor: "{colors.danger-wash-ink}"
    rounded: "{rounded.pill}"
    padding: "3px 8px"
---

# Design System: Stipend

**This is a concept.** The screens and tokens below describe a demonstration UI, not a shipped issuing program.

## Overview

**Creative North Star: "The Envelope Counter"**

Stipend is a light operate desk on warm paper. Cardholder and admin share one room: a cream ground, a slightly warmer rail, white 22px cards, and three KPI plates (lilac, peach, charcoal) that treat remaining euros as named envelopes rather than a single pile. The accent violet is a quiet signal — the wordmark pipe, focus ring, and caret — not a wash.

The form language is pill for action and navigation, large radius for surfaces. Hairline charts and a donut of connection colors sit on white; spend over time is a stacked area with envelope-colored gradients (a 24-hour cumulative with purchase marks for a single day). The virtual card is the only object that goes fully dark-plastic. Density is operate-dashboard, not editorial: short titles, tabular money, muted supporting lines. The planned black sidebar did not land; the shipped rail is bright grey `#f8f8f8`, and only the active nav item is ink.

**Key Characteristics:**
- White page ground with a `#f8f8f8` sidebar
- Three KPI plates: pastel lilac, pastel peach, one charcoal total
- Ink-filled pills for active nav, primary buttons, and selected MCC chips
- 22px white cards with a soft charcoal bloom
- Atkinson Hyperlegible at every rank; tabular euros
- Cardholder and admin are one visual system

## Colors

A warm paper field, two pastel plates, one charcoal plate, and a reserved violet accent. Connection slices use a three-color series, not the accent.

### Primary
- **Operate Violet** (`accent`): Brand pipe in the wordmark, `:focus-visible` ring, caret, and the lilac-plate spark. Rare on the canvas.

### Secondary
- **Plate Lilac** (`lilac`) with **Lilac Ink** (`lilac-ink`): First KPI plate (a named envelope or count).
- **Plate Peach** (`peach`) with **Peach Ink** (`peach-ink`): Second KPI plate (a second named envelope or credit volume).

### Tertiary
- **Charcoal Plate** (`dark`) with **On-Dark** (`on-dark`) and **Charcoal Well** (`dark-2`): Third KPI (total available or MCC declines) and inset icon well on that plate. Virtual card plastic is a separate dark object, not this flat fill.

### Neutral
- **Page** (`paper`): White `#ffffff` ground.
- **Rail** (`sidebar`): Bright grey `#f8f8f8` left rail.
- **Surface White** (`surface`): Cards, fields, device chip.
- **Ink** (`ink`): Body text, active pills, primary buttons.
- **Muted Slate** (`muted`): Supporting copy, idle nav, table headers.
- **Hairline** (`line`): Dividers, field borders, ghost-button stroke.
- **Cool Wash** (`wash`): Search pills and hook code wells.

### Supporting

Small, single-purpose colours. They are not plates, not chart series, and not on the palette
for general use — each one belongs to the thing it is named for.

- **Mint** (`mint`) with **Mint Ink** (`mint-ink`): The cash-limit meter — mint is the track,
  mint ink the portion used. This is the one pastel pair that is not a KPI plate, which is
  why cash reads as its own kind of thing rather than a fourth envelope.
- **Live Dot** (`#3bb56a`): The 8px dot on the device chip, meaning connected. The only place
  a saturated green appears.
- **On-Dark Muted** (`#9aa0a8`, `#c8cad0`, `#d4d6dc`): Supporting text on the charcoal plate,
  the virtual card and the chart tooltip, where Muted Slate has too little contrast.
- **Delta Up** (`#7ddea8`): A rise shown on the charcoal plate. Ok green is for badges on
  paper; it is unreadable on charcoal.
- **Secret Notice** (`#fff8e8` on `#f0dfb5`): The one-time password callout, shown once and
  never again. Warmer than Warn Wash on purpose: it is a thing to act on, not a status.

### Chart series
- **Envelope Violet** (`envelope-violet`), **Envelope Clay** (`envelope-clay`), **Envelope Teal** (`envelope-teal`): Donut strokes, legend swatches, stacked spend-area fills. One color per Connection on a screen.

### Status
- **Ok** / **Ok Wash**: Credits and settled badges.
- **Danger** / **Danger Wash**: Destructive actions and declined badges.
- **Warn Wash**: Pending or not-connected badges (ink is peach-ink).

### Named Rules
**The Three-Plate Rule.** A KPI row is always three tiles in order: lilac, peach, charcoal. Do not add a fourth plate or swap the charcoal into the first slot.

**The Reserved Violet Rule.** Operate Violet is not a plate fill, not a sidebar, and not a chart series. Connection color lives on the slice.

**The Paper Rail Rule.** The sidebar is rail paper. Ink is the active pill, not the rail.

## Typography

**Display Font:** Atkinson Hyperlegible (Segoe UI, sans-serif)
**Body Font:** Atkinson Hyperlegible (Segoe UI, sans-serif)
**Wordmark:** Sora 600, `#1a1a1a`, used for the sidebar lockup and the vertical mark on the plastic
**Card lettering:** Share Tech Mono 400, black, for PAN, expiry, CVC, and cardholder on the plastic
**Label/Mono Font:** `ui-monospace, SFMono-Regular, Menlo, monospace` for inbound hook payloads and sample `pain.001` only

**Character:** One hyperlegible grotesque, slightly tight tracking, two weights (400 / 700). Money is the display voice.

### Hierarchy
- **Display** (700, 1.85rem, tracking −0.03em, tabular-nums): KPI amounts. The only oversized number on a page.
- **Headline** (700, 1.45rem, tracking −0.03em): Page title in the topbar (`Today's spend`, `Admin console`).
- **Title** (700, 1.05rem, tracking −0.02em): Card headings. Sidebar wordmark is Sora 600 at ~1.45rem, horizontal, with Hugeicons `CreditCardPosIcon` to the left.
- **Body** (400, 1rem, tracking −0.011em): UI copy. Table cells drop to 0.92rem. Supporting paragraphs cap around 62–70ch in muted slate.
- **Label** (400, 0.75–0.85rem): Meta on plates, legend MCC counts, table headers, badges (0.72rem), card network letter-spacing 0.08em.

### Named Rules
**The Tabular Euro Rule.** Amounts, PANs, and MCC codes use `font-variant-numeric: tabular-nums`. Amounts are 700. Never oldstyle figures for money.

**The One Face Rule.** Atkinson Hyperlegible at every rank of the operate UI. Sora is the brand mark only. Share Tech Mono is the plastic lettering only. Payload mono is for hooks, not chrome.

## Layout

Operate split: a 248px paper rail and a fluid main column (`padding` 22px 28px 40px). Main stacks a topbar (title + actions), then a three-column KPI row (`gap` 16px), then 1.55fr / 0.95fr card pairs (`gap` 16px). Connection catalogs are two equal columns. Vertical rhythm is 16px between peers and 22px under the topbar and KPI row.

At 1080px the app, KPIs, card pairs, connection grid, and pie+legend collapse to one column; the rail becomes a sticky horizontal scroller and the dashboard reorders so the envelope donut sits above the KPI plates. At 720px main padding tightens to 16px 14px 32px and KPIs stack.

Focus is a 2px Operate Violet ring, offset 2px. Selection wash is `selection`.

## Elevation & Depth

Hybrid: pastel and charcoal plates are tonal (flush, no shadow). White cards, the sidebar device chip, and connection cards lift with one ambient bloom. The MCC tooltip and toast sit on ink and use a deeper bloom so they clear the paper.

### Shadow Vocabulary
- **Card bloom** (`box-shadow: 0 10px 30px rgba(20, 20, 22, 0.06)`): White cards, connection cards, device chip.
- **Ink float** (`box-shadow: 0 18px 40px rgba(0, 0, 0, 0.25)`): MCC tooltip over the donut.

### Named Rules
**The Soft Bloom Rule.** Lift is a 6% charcoal blur. No hard offset shadows, no colored drop shadows on plates.

## Shapes

Large-radius operate: surfaces are 22px; nested wells and fields are 12px; tooltips, groups, and the device chip are 16px. Every action, nav item, search, segment, badge, and MCC option is a pill (999px). Avatars and the notification control are full circles (40px). The donut is a 28px stroke on a 220px viewBox (thicker when selected). Spend is a full-bleed SVG area (week = 7 days, month = every day of the calendar month, day = 24-hour cumulative with purchase marks). Category spend uses track bars, not a heatmap.

## Components

Pill-confident, paper-quiet. Same parts in cardholder and admin.

### Buttons
- **Shape:** Pill (999px), 700 weight, 10px 16px.
- **Primary:** Ink fill, white label. Disabled at 45% opacity.
- **Ghost:** Transparent with hairline border, ink label.
- **Danger:** Danger fill, white label — freeze and destructive confirms only.
- **Hover / Focus:** Primary has no fill hover; focus-visible is the 2px violet ring. Ghost and idle nav wash to `#eceef3`.

### Chips
- **Style:** Cool gray pill (`#f1f2f6`) at 0.75rem for MCC lists on paper; on-ink chips (`#2c2c2c`) inside the dark tooltip.
- **State:** MCC picker options are ghost pills that invert to ink fill when allowed.

### Cards / Containers
- **Corner Style:** 22px.
- **Background:** Surface white on paper; KPI plates use the triad fills and do not use card bloom.
- **Shadow Strategy:** Card bloom on white only.
- **Border:** None on cards; groups and fields use hairline.
- **Internal Padding:** 20px 22px (KPI plates add 16px bottom and extra right room for the spark).

### Inputs / Fields
- **Style:** White fill, hairline border, 12px radius, 10px 12px. Labels 0.85rem muted above a 6px gap. Search is a cool-wash pill, not a boxed field. Country scope is a pill select in the admin topbar.
- **Focus:** Caret in Operate Violet; focus-visible ring as globally defined.
- **Error / Disabled:** Primary submit disables when required envelope fields are empty; no separate error chrome.

### Navigation
- **Style:** Column of pills in the paper rail (gap 4px). Idle is muted; hover washes `#eceef3` to ink; active is ink fill, white label. Wordmark is `Stip|end.` with the pipe in Operate Violet.
- **Mobile:** Row of the same pills, sticky, side-foot hidden.

### KPI plates
Flush 22px tiles, min-height 168px. Icon well 36px / 12px radius (white 55% on pastels; charcoal well on the dark plate). Amount is Display; meta and foot are Label at ~75–80% opacity. Hairline spark is decorative on desktop and hidden below 720px.

### Envelope donut
220px stroke ring plus a legend of 12px swatches. Center label “Available” in muted 13px over a 700 ink total. Clicking a slice or legend row opens a fixed ink tooltip listing MCC chips. Empty ring track is hairline gray.

### Virtual card
18px radius plastic: diagonal gradient `#2a2740 → #17151f → #3d2f22`, on-dark type, PAN tracking 0.12em, lilac orb in the corner. Reveal is a ghost pill under the plate, not chrome on the plastic.

### Tables, segments, badges
Hairline rows, muted 0.8rem headers, hover `#fafafb`. Segmented day/week/month is a cool-wash pill with an ink inner pill. Status is a 0.72rem pill: ok / warn / bad washes.

## Do's and Don'ts

### Do:
- **Do** put remaining money on a named slice, plate, or row — never as an unlabeled total alone.
- **Do** keep cardholder and admin on this token set (same rail, plates, pills, typeface). Country scope is a pill select, not a reskin.
- **Do** use the lilac → peach → charcoal KPI order and 22px white cards with card bloom.
- **Do** set amounts in Atkinson 700 with tabular-nums.
- **Do** show MCC allowlists as pills (paper chips or on-ink chips), not as a paragraph of codes.

### Don't:
- **Don't** paint the sidebar black; ink is the active pill only.
- **Don't** use Operate Violet as a plate or donut series color.
- **Don't** introduce a second typeface for headlines or UI.
- **Don't** add hard offset or neobrutalist shadows.
- **Don't** add a fourth KPI plate or a competing hero beside the envelope donut on the first viewport.
