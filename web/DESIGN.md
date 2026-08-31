---
name: Daiko webui
description: Daiko's artifact store rendered as a design annual's plate section — printed plates, edition credits, ink on uncoated paper, sidebar navigation.
colors:
  paper: "#f5f4f6"
  paper-warm: "#faf6f5"
  paper-cool: "#eef3ef"
  plate: "#fbfbfc"
  ink: "#16181a"
  ink-soft: "#3f4347"
  muted: "#5c6166"
  hairline: "#c9c7c4"
  hairline-soft: "#dddbd8"
  seal: "#dcddf3"
  seal-ink: "#4f53b3"
  reg-red: "#b3392b"
typography:
  display:
    fontFamily: "Schibsted Grotesk, Helvetica Neue, Arial, sans-serif"
    fontSize: "44px"
    fontWeight: 400
    lineHeight: 1.05
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Schibsted Grotesk, Helvetica Neue, Arial, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "Red Hat Mono, ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "11px"
    fontWeight: 500
    letterSpacing: "0.14em"
  data:
    fontFamily: "Red Hat Mono, ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "12.5px"
    fontWeight: 400
    letterSpacing: "0"
  numeral:
    fontFamily: "Red Hat Mono, ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "32px"
    fontWeight: 400
    lineHeight: 1.1
rounded:
  none: "0px"
spacing:
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "24px"
  xl: "40px"
  xxl: "56px"
components:
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "10px 18px"
  button-secondary-hover:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "10px 18px"
  button-primary-hover:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.reg-red}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "10px 18px"
  button-danger-hover:
    backgroundColor: "{colors.reg-red}"
    textColor: "{colors.paper}"
  badge:
    backgroundColor: "{colors.plate}"
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.none}"
    padding: "3px 8px"
  pin-badge:
    backgroundColor: "{colors.seal}"
    textColor: "{colors.seal-ink}"
    rounded: "{rounded.none}"
    padding: "3px 8px"
  tag:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.none}"
    padding: "3px 8px"
  stat-card:
    backgroundColor: "transparent"
    rounded: "{rounded.none}"
    padding: "22px 20px 18px"
  stat-card-hover:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
  editor:
    backgroundColor: "{colors.plate}"
    textColor: "{colors.ink}"
    typography: "{typography.data}"
    rounded: "{rounded.none}"
    padding: "20px"
  notice:
    backgroundColor: "{colors.seal}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "12px 16px"
---

# Design System: Daiko webui

## Overview

**Creative North Star: "The Plate Section"**

Daiko's store is rendered as the plate section of a printed design annual: artifacts are plates, versions are edition credits, the whole UI is one sheet of uncoated near-white stock inspected under good light. The page background is paper (#f5f4f6) with a warm radial drift at the top-left and a cool one at the top-right, so the "stock" reads as material rather than flat fill. Everything on it is set in ink (#16181a) and separated by hairlines (#c9c7c4); a periwinkle accent family (#dcddf3) marks provenance. The sheet carries no printed ornament — no crosshairs, dot matrices, or stamps; structure alone does the decorating.

The system deliberately refuses the dark SaaS card dashboard: no dark surfaces, no rounded cards floating on shadows, no gradient accents. Density is editorial — one 1120px sheet, generous 40px gutters, tables and ledgers ruled by hairlines rather than boxed by cards. Provenance is the product, so the visual grammar is a ledger's: mono hashes, edition tags, a pinned stamp set slightly askew like a hand-applied chop.

**Key Characteristics:**
- Uncoated paper world: near-white stock with warm/cool edge drift, never pure white, never dark.
- One ink, one accent: everything is #16181a on paper except a single periwinkle accent family and a registration red reserved for destruction.
- No ornament: hairline structure, ruled sections, and type carry the identity; no crosshairs, dot matrices, stamps, or illustration.
- Two voices: one grotesque (Schibsted Grotesk) for prose, one mono (Red Hat Mono) for labels, data, and hashes.
- 0-radius controls; hover is a 0.1s ink inversion, not a lift.

## Colors

An achromatic ink-on-paper ledger with exactly one accent family (periwinkle) and one alarm color (registration red).

### Primary
- **Periwinkle** (#dcddf3): the provenance color. Fills the "pinned" stamp tag, the selected version row, the notice bar, and text `::selection`. It marks provenance and attention, never decoration at scale.
- **Seal Ink** (#4f53b3): the deep periwinkle pressed into the accent — pinned-tag text, notice border, and the `:focus-visible` outline (2px, offset 2px).

### Secondary
- **Registration Red** (#b3392b): destructive actions only — the Delete/danger button's text and 1px border, inverting to a red fill on hover. It appears nowhere else.

### Neutral
- **Paper** (#f5f4f6): the page stock; also the text color on any ink-filled surface.
- **Warm Drift** (#faf6f5) and **Cool Drift** (#eef3ef): two large radial gradients feathered into the paper from opposite top corners; the stock's only "texture" at page level.
- **Plate** (#fbfbfc): the slightly brighter surface for mounted content — code chips, the content viewer, the editor, and type badges.
- **Ink** (#16181a): all primary text, filled controls (including the active nav item), section rules, table header rules.
- **Soft Ink** (#3f4347): secondary text (nav resting state, badge text).
- **Muted** (#5c6166): tertiary text — column headers, stat labels, metadata.
- **Hairline** (#c9c7c4): structural 1px rules — the sidebar border, stat-cell and plate borders.
- **Soft Hairline** (#dddbd8): row separators inside tables, lists, and the version ledger.
- **Ink Wash** (rgba(22, 24, 26, 0.045)): the resting hover tint for table rows, list rows, and version rows.

### Named Rules
**The One Accent Rule.** Periwinkle is a stamp, not a theme. It appears only where provenance or attention is being marked (pinned, selected version, notice, selection, focus); it never colors buttons, links, headings, or backgrounds at scale.

**The Registration Red Rule.** #b3392b exists solely to mark destruction. If it isn't a delete/remove action, it isn't red.

**The No-White Rule.** Nothing is #ffffff and nothing is dark-surfaced. Every surface is a paper tone between #eef3ef and #fbfbfc; every foreground is an ink tone.

## Typography

**Display/Body Font:** Schibsted Grotesk (with Helvetica Neue, Arial fallback) — weights 400 and 500 only, self-hosted via @fontsource.
**Label/Mono Font:** Red Hat Mono (with ui-monospace, SF Mono, Menlo, Consolas fallback) — weights 400 and 500, self-hosted via @fontsource.

**Character:** One quiet grotesque carries all prose at regular weight; the mono is the machine's voice — every label, count, hash, and credit line reads like type from a spec sheet. Nothing is bold; emphasis comes from weight 500, case, and tracking.

### Hierarchy
- **Display** (400, 44px, 1.05, -0.02em): page headlines ("Dashboard", artifact names). Drops to 32px below 640px. Balanced wrapping (`text-wrap: balance`).
- **Body** (400, 15px, 1.55): all prose, descriptions, table cells. Descriptions cap at 60ch.
- **Wordmark/Title** (500, 17px, -0.01em): the Daiko wordmark; row-link names and activity names are body-size at 500.
- **Numeral** (mono 400, 32px, 1.1, tabular-nums): the count-row statistics. Drops to 24px below 900px.
- **Data** (mono 400, 12.5px): hashes, paths, timestamps, code chips, the content viewer and editor (line-height 1.65 in the plate).
- **Label** (mono 500, 11px, 0.14em, UPPERCASE): the mono-token voice — nav items, section headings, table headers, stat labels, buttons. A 10px/0.12em variant serves badges, tags, and stamps.

### Named Rules
**The Two Voices Rule.** Schibsted Grotesk speaks prose; Red Hat Mono speaks apparatus. Anything uppercase, tracked, numeric, hashed, or machine-generated is mono. The grotesque is never uppercased, never tracked wide, and never exceeds weight 500.

**The Mono-Token Rule.** Every label in the system is one voice: mono, 11px, weight 500, 0.14em tracking, uppercase. New labels reuse it exactly (the `.token` class); they do not invent adjacent sizes.

## Layout

A sidebar and a sheet: a sticky 224px full-height sidebar on the left — wordmark on top, mono-token nav stacked beneath — separated from the content by a 1px hairline. The content is a single 1120px max-width column with 40px side gutters and 56px top / 96px bottom padding (24px gutters, 40px/72px vertical below 900px). Below 900px the sidebar becomes a sticky 64px horizontal bar on 88%-opacity paper with a 6px backdrop blur over a 1px hairline, nav scrolling horizontally. There is no footer.

Sections stack with 48px rhythm under mono-token headings ruled by a 1px ink border; page headers get 40px below. Spacing is an 8-step rhythm (8/12/16/24/32/40/56) rather than a formal token scale.

Grids: the count row is five equal cells sharing hairlines via negative margins (collapsing to 2 columns below 640px, last cell full-width); the artifact detail is a 1fr / 320px two-column grid (single column below 900px). Tables are full-width, ruled not boxed: ink rule under mono headers, soft hairlines between rows, last column right-aligned. Below 640px, secondary columns and metadata hide rather than reflow.

## Elevation & Depth

Flat, entirely. There is not a single `box-shadow` in the system. Depth is conveyed by printing metaphors instead: the plate tone (#fbfbfc) reads as mounted stock against the paper, hairlines rule the structure, and the hover state inverts to ink rather than lifting. The one translucency is the mobile nav bar (88% paper + 6px blur) so the sheet visibly slides beneath it.

### Named Rules
**The Ink-Invert Rule.** Interactive surfaces respond by inverting to ink (background #16181a, text #f5f4f6) or washing with rgba(22,24,26,0.045), over 0.1s ease. Nothing lifts, glows, scales, or casts a shadow.

## Shapes

Square. Controls, plates, badges, cells, notices, and the editor are all 0-radius rectangles with 1px borders — press-trimmed, not molded. The only circle is the wordmark's 34px ring badge. One rotated element remains: the "pinned" stamp sits at -2deg like a hand-applied chop. Text on ink-filled surfaces (tags, the active nav item) is the only reversed printing.

### Named Rules
**The Zero-Radius Rule.** No border-radius on any control or surface. The circle is reserved for the wordmark ring; nothing else curves.

## Components

### Buttons
- **Shape:** square (0 radius), 1px border, mono-token label (mono 500, 11px, 0.12em, uppercase), 10px 18px padding; small variant 5px 10px at 10px.
- **Secondary (default `.btn`):** transparent with 1px ink outline, ink text; hover inverts to ink fill / paper text.
- **Primary:** filled ink with paper text; hover inverts back to outline.
- **Danger:** registration-red text and border; hover fills red with paper text. Destructive actions are also confirm-gated.
- **States:** all transitions 0.1s ease; disabled drops to 45% opacity; focus is the global 2px seal-ink outline.

### Chips (badges, stamps, tags)
- **Type badge:** mono 10px/0.12em uppercase, plate background, 1px hairline border, soft-ink text, 3px 8px — labels an artifact's type inline (including inside display headlines).
- **Pinned stamp:** same setting but periwinkle fill, seal-ink text, no border, rotated -2deg — the hand-applied chop marking a pinned version.
- **Current tag:** ink fill, paper text, square — the edition currently in force.

### Cards / Containers
- **Stat cell:** hairline-bordered square cell, 22px 20px 18px, transparent on the stock; mono numeral over muted mono-token label; cells share borders via -1px margins; linked cells invert fully to ink on hover.
- **Content plate:** plate background, 1px hairline border, 28px padding, mono 12.5px/1.65 pre-wrapped content, max-height 70vh.
- **Notice:** periwinkle fill with 1px seal-ink border, 12px 16px — the "viewing an older version" advisory.
- **Empty state:** hairline-bordered box on the plate tone; a muted centered message with CLI commands in code chips.

### Inputs / Fields
- **Editor (textarea):** plate background, 1px hairline border, 0 radius, mono 12.5px/1.65, 20px padding, min-height 50vh, vertical resize; focus swaps the border to ink (outline suppressed here only).

### Navigation
- **Sidebar:** sticky 224px full-height column, hairline right border. The wordmark sits on top; nav links stack beneath as mono-token soft-ink rows (9px 12px padding); hover washes with ink at 4.5%; the active item inverts fully to ink fill with paper text. The wordmark's ring badge inverts to ink on hover. Below 900px the sidebar becomes a sticky 64px horizontal bar (translucent paper with blur, hairline underline) with the nav in a scrollable row; long labels swap to short forms below 640px ("MCP Servers" → "MCP").

### Tables & Ledgers
- **Tables:** mono-token muted headers over a 1px ink rule; rows separated by soft hairlines, hover-washed with ink at 4.5%; row links are 500-weight ink, underlining on hover (3px offset); numeric/meta columns in mono.
- **Activity/artifact lists:** borderless rows on soft hairlines — badge, 500-weight name, muted context, right-aligned mono meta.
- **Version ledger:** mono rows (8-char hash, muted credit line "source · time"), current tag, pinned stamp, and a small Pin/Unpin button per row; the version being viewed fills periwinkle.

## Do's and Don'ts

### Do:
- **Do** set every label in the mono-token voice: Red Hat Mono, 11px, 500, 0.14em, uppercase (10px/0.12em for chips).
- **Do** separate with 1px hairlines (#c9c7c4 structural, #dddbd8 between rows) and rule section headings with 1px ink.
- **Do** make hover an inversion: ink fill + paper text on controls, rgba(22,24,26,0.045) wash on rows, always 0.1s ease.
- **Do** mark provenance with the periwinkle family: pinned = -2deg periwinkle stamp, current = ink tag, selected version = periwinkle row.
- **Do** keep destructive actions registration-red (#b3392b) and confirm-gated.

### Don't:
- **Don't** build dark surfaces, cards on shadows, or gradient accents — the world refuses the dark SaaS dashboard; the only gradients are the paper's edge drifts.
- **Don't** round anything: no border-radius on controls or surfaces; the circle belongs to the wordmark ring alone.
- **Don't** use box-shadows, lifts, scales, or glows; motion is the 0.1s invert, nothing else.
- **Don't** add a second accent or periwinkle decoration at scale; one stamp per world.
- **Don't** exceed weight 500 or uppercase the grotesque; bold emphasis, wide-tracked headlines, and display mono over 32px don't exist here.
- **Don't** introduce ornament — no crosshairs, dot matrices, seals, icon glyphs, or illustration; structure and type are the only decoration.
