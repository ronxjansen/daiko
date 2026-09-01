---
name: Daiko
description: A quiet printed ledger of immutable editions — provenance you inspect, not a SaaS dashboard.
colors:
  paper: "light-dark(#f6f5f3, #16171a)"
  paper-warm: "light-dark(#faf7f4, #1a191d)"
  paper-cool: "light-dark(#eff2f0, #15181a)"
  plate: "light-dark(#fbfaf9, #1c1d21)"
  ink: "light-dark(#1a1c1e, #e6e4e0)"
  ink-soft: "light-dark(#43474b, #b6b4af)"
  muted: "light-dark(#5f6469, #94928d)"
  hairline: "light-dark(#d2cfcb, #33353a)"
  hairline-soft: "light-dark(#e3e0dc, #27292d)"
  rule: "light-dark(#a5a29e, #4b4e54)"
  seal: "light-dark(#dfe0f4, #2d2f4c)"
  seal-ink: "light-dark(#4f53b3, #a5aaee)"
  reg-red: "light-dark(#a83a2d, #d98376)"
  tint: "light-dark(rgba(26, 28, 30, 0.04), rgba(230, 228, 224, 0.05))"
  tint-strong: "light-dark(rgba(26, 28, 30, 0.07), rgba(230, 228, 224, 0.09))"
  red-tint: "light-dark(rgba(168, 58, 45, 0.08), rgba(217, 131, 118, 0.1))"
typography:
  headline:
    fontFamily: "Public Sans Variable, -apple-system, Helvetica Neue, Arial, sans-serif"
    fontSize: "29px"
    fontWeight: 500
    lineHeight: 1.15
    letterSpacing: "-0.015em"
  body:
    fontFamily: "Public Sans Variable, -apple-system, Helvetica Neue, Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "Red Hat Mono, ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "10.5px"
    fontWeight: 500
    letterSpacing: "0.09em"
  mono-meta:
    fontFamily: "Red Hat Mono, ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    letterSpacing: "normal"
  ledger-figures:
    fontFamily: "Red Hat Mono, ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "26px"
    fontWeight: 400
    lineHeight: 1.1
spacing:
  xs: "2px"
  sm: "8px"
  md: "14px"
  lg: "24px"
  xl: "40px"
  xxl: "48px"
rounded:
  control: "0"
components:
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "8px 15px"
  button-ghost-hover:
    backgroundColor: "{colors.tint}"
  button-primary:
    backgroundColor: "{colors.seal}"
    textColor: "{colors.seal-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "8px 15px"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.reg-red}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "8px 15px"
  button-danger-hover:
    backgroundColor: "{colors.red-tint}"
  button-small:
    padding: "4px 9px"
  badge:
    backgroundColor: "transparent"
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.control}"
    padding: "2px 7px"
  pin-badge:
    backgroundColor: "{colors.seal}"
    textColor: "{colors.seal-ink}"
    rounded: "{rounded.control}"
    padding: "2px 7px"
  input-search:
    backgroundColor: "{colors.plate}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "9px 12px"
  editor:
    backgroundColor: "{colors.plate}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "20px"
  stat-card:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "18px 16px 15px"
  notice:
    backgroundColor: "{colors.seal}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "10px 14px"
---

# Design System: Daiko

## Overview

**Creative North Star: "The Printed Ledger"**

Daiko's webui is a store rendered as a quiet printed ledger of immutable editions. The material is uncoated stock in two lights — warm paper by day, night stock after dark — carrying ink-and-chalk text, 1px hairline and rule lines, and mono ledger figures. Provenance is the product, so the interface behaves like a document you inspect rather than an app that performs: counts sit in a hairline-ruled grid, versions stack as ledger rows with truncated hashes, and every state change is a tint wash on the paper, never an inversion of it.

One color is allowed to speak: the periwinkle seal, used as a pale wash with seal-ink text for the primary act, the pin, the selection, and the user's own voice in transcripts. Registration red exists solely for destructive acts. Everything else is drawn in ink at three strengths over paper at four strengths. Confirmed rejections, carried from the build's own contract: no card chrome (no shadows, no radii, no elevated containers), no inversion hovers, no rotated seals, no shouting caps above the small mono label voice — all refused as the former "display-annual loudness" this design quieted.

Theming is token-level: every color is a CSS `light-dark()` pair under `color-scheme: light dark`, so the whole world follows the OS with no toggle and no per-component dark variants. Density is deliberate — 14px body, 13.5px tables, 12px mono meta — exact rather than airy.

**Key Characteristics:**
- Uncoated stock in two lights via `light-dark()`; follows the system, no theme toggle
- Ink-and-chalk text hierarchy; one periwinkle seal as sole accent; registration red destructive-only
- Structure drawn with 1px hairlines and rules, never with shadows or cards
- Public Sans UI voice; Red Hat Mono for labels, hashes, meta, and ledger figures
- 0-radius controls; tint washes for every interactive state, never inversions
- One authored motion: the page settling onto the stock

## Colors

An ink-on-paper neutral world where every value is a `light-dark()` pair (frontmatter values are normative), with a single periwinkle seal accent and a destructive-only registration red.

### Primary
- **Periwinkle Seal Ink** (`{colors.seal-ink}`): the sole accent's ink — primary-button text and border, pin-badge text, focus outlines, hovered stat figures, the user's speaker label in transcripts, and hovered wordmark ring.
- **Periwinkle Seal Wash** (`{colors.seal}`): the accent as a pale stamp — primary button fill, pin-badge fill, selected version-row fill, text selection, notice fill, and (at 42% strength via `color-mix`) the user-message wash in transcripts.

### Tertiary
- **Registration Red** (`{colors.reg-red}`): destructive acts only — Delete/Remove button text, with **Red Tint** (`{colors.red-tint}`) as its hover wash. Never used for connectivity errors, emphasis, or status.

### Neutral
- **Paper** (`{colors.paper}`): the ground. The body carries two faint radial washes of **Paper Warm** (`{colors.paper-warm}`, top-left) and **Paper Cool** (`{colors.paper-cool}`, top-right) over it — the only atmosphere in the system.
- **Plate** (`{colors.plate}`): one step off the paper; fill for content plates — code view, editor, inputs, empty states, tool-result messages, inline `code`.
- **Ink** (`{colors.ink}`): primary text, row links, body copy.
- **Ink Soft** (`{colors.ink-soft}`): secondary voice — section labels, badges, speaker labels.
- **Muted** (`{colors.muted}`): tertiary voice — descriptions, table headers, stat labels, nav at rest, timestamps, empty-state copy.
- **Hairline** (`{colors.hairline}`): standard 1px border — stat cells, buttons, badges.
- **Hairline Soft** (`{colors.hairline-soft}`): quieter 1px separations — table rows, list rows, sidebar edge, plate borders.
- **Rule** (`{colors.rule}`): the strongest line — section-label underlines, table-header underlines, tag borders, the wordmark ring.
- **Tint / Tint Strong** (`{colors.tint}` / `{colors.tint-strong}`): translucent ink washes for hover and active-nav states.

### Named Rules
**The One Seal Rule.** Periwinkle is the only accent and it is a stamp, not a paint: seal wash + seal-ink text for the one primary act, the pin, and the selection. If a surface needs a second accent, the surface is wrong.

**The Registration Red Rule.** Red means "this destroys data" and nothing else. Connectivity errors and empty states speak in muted ink on plate — calm, not alarmed.

**The Wash, Never Inversion Rule.** Every hover, active, and selected state is a translucent tint or a seal wash over the paper. Ink and paper never trade places.

**The Two Lights Rule.** Every color token is a `light-dark()` pair resolved by `color-scheme: light dark`. New colors join as pairs; no component defines its own dark variant and no toggle exists.

## Typography

**Body Font:** Public Sans Variable (with -apple-system, Helvetica Neue, Arial fallbacks)
**Label/Mono Font:** Red Hat Mono, weights 400 and 500 (with ui-monospace, SF Mono, Menlo fallbacks)

**Character:** A plainspoken civic sans carries the prose; a mono ledger hand carries every label, figure, hash, and timestamp. The pairing reads like a well-set government form: exact, unadorned, trustworthy.

### Hierarchy
- **Headline** (500, 29px → 24px under 640px, 1.15, -0.015em): one per page; balanced wrapping; may carry an inline type badge.
- **Body** (400, 14px, 1.55): descriptions and prose; page-header intro capped at 62ch. Table cells run denser at 13.5px.
- **Label — the mono-caps voice** (Red Hat Mono 500, 9.5–10.5px, 0.07–0.09em, UPPERCASE): nav tokens, section labels, table headers, buttons, badges, tags, stat labels, speaker labels. This is the only uppercase in the system.
- **Mono meta** (Red Hat Mono 400, 11–12.5px): hashes (8-char truncation), file paths, timestamps, inline `code`, version rows, message bodies, and the content plate/editor at 12.5px/1.6.
- **Ledger figures** (Red Hat Mono 400, 26px → 21px under 900px, 1.1, tabular-nums): stat-grid counts; the usage variant runs at 19px.

### Named Rules
**The Ledger Figures Rule.** Every number, hash, path, and timestamp is set in Red Hat Mono; counts always carry `tabular-nums`. Prose is the only thing Public Sans owns.

**The Mono-Caps Ceiling Rule.** Uppercase exists only in the mono label voice at 9.5–10.5px with 0.07–0.09em tracking. Nothing larger ever shouts.

## Layout

A fixed sticky sidebar (224px, full viewport height, hairline-soft right edge, 26px/20px padding) holds the circular "D" wordmark and a vertical stack of mono-caps nav tokens. Content sits in a centered sheet, max-width 1120px, padded 48px 40px 88px.

The signature grid is the six-column stat grid: cells share hairlines through 1px borders collapsed with `margin: 0 -1px -1px 0` — a ruled ledger table, not a row of cards. Detail pages split into a `1fr / 320px` grid (content plate / side panels) with a 40px gutter. Vertical rhythm: 40px between panels, 48px under the stat grid, 32px under page headers; rows pad 10px vertically; the fine scale is 2 / 8 / 14 / 24px.

Responsive behavior (two breakpoints, 900px and 640px): under 900px the sidebar becomes a 60px sticky top bar (row layout, translucent paper at 88% with `backdrop-filter: blur(6px)`), the stat grid drops to three columns, the detail grid stacks, and content padding tightens to 36px/24px. Under 640px the grid drops to two columns, headlines drop to 24px, the wordmark text and secondary meta columns hide (`.col-hide-sm`, long nav labels swap to short forms), and nav tokens compress to 9.5px/0.05em so all five fit a 390px bar without clipping.

Motion is one authored moment: each page settles onto the stock — `page-in`, 0.4s `cubic-bezier(0.19, 1, 0.22, 1)` (expo-out), fading up from a 6px offset — disabled entirely under `prefers-reduced-motion`. Everything else is the 0.15s ease "wash" on background, color, and border-color only.

### Named Rules
**The One Settle Rule.** The page-in settle is the only authored animation. State feedback is the 0.15s wash; nothing slides, scales, bounces, or rotates.

## Elevation & Depth

There are no shadows anywhere in the system. Depth is conveyed tonally and linearly: plate sits one step off the paper for anything holding content (code, editor, inputs, empty states), translucent tint washes mark interaction, and 1px lines do all structural work at three weights — hairline-soft for row separations, hairline for cell and control borders, rule for section underlines and emphasized edges. The single blur in the system is the mobile top bar's `backdrop-filter: blur(6px)` over translucent paper, which is legibility, not elevation.

### Named Rules
**The Hairline Rule.** If structure needs marking, draw a 1px line; if a surface needs distinction, shift it one tonal step to plate. Shadows, glows, and elevated cards do not exist in this world.

## Shapes

Zero-radius everywhere: buttons, inputs, badges, notices, plates, and the editor all meet the page as exact rectangles (`border-radius: 0` is set explicitly on controls that browsers would otherwise round). Rectangles butt-join and share edges — the stat grid collapses neighboring borders so cells read as one ruled table. The single exception is the wordmark: a 32px circle ruled in `rule` holding a mono "D", the closest thing to a logo the brand allows. Underlines on hovered row links sit 3px off the baseline in the rule color, like a pencil notation.

### Named Rules
**The Zero-Radius Rule.** Controls and containers are exact rectangles. The one circle in the system is the 32px "D" wordmark roundel; nothing else curves.

## Components

### Buttons
Quiet mono-caps controls; hierarchy comes from wash, not weight.
- **Shape:** exact rectangle (0 radius), 1px hairline border, mono-caps label (10.5px / 0.07em), padding 8px 15px; small variant 4px 9px at 9.5px.
- **Ghost (default):** transparent fill, ink text. Hover: tint wash, border deepens to rule.
- **Primary:** seal wash fill, seal-ink border and text — the stamp for the one main act per surface (e.g. "Save as new version"). Hover nudges the fill toward seal-ink via `color-mix` (94/6); no inversion.
- **Danger:** ghost with registration-red text; hover brings red-tint wash and red border. Reserved for Delete/Remove, always confirm-gated.
- **Disabled:** 45% opacity, no hover response. Focus (all): 2px seal-ink outline, offset 2px.

### Badges & Tags
The ledger's marginalia, all in mono-caps at 9.5px / 0.07em, 2px 7px padding, 0 radius.
- **Badge** (artifact type, message speaker): transparent with hairline border, ink-soft text. Harness identity badges (claude / codex / gemini) are deliberately neutral — rule border, ink-soft text — identity rides in the label text so the seal keeps sole-accent duty.
- **Pin badge:** the seal as a literal stamp — seal wash, seal-ink text, borderless. Marks pinned versions only.
- **Tag** ("origin", "current"): hairline-weight sibling with rule border and ink text.

### Tables & Ledger Rows
- **Headers:** mono-caps 10px muted, underlined by a full rule line. **Cells:** 13.5px, baseline-aligned, hairline-soft row separators, 10px 14px padding (flush at row edges; last column right-aligned and nowrap).
- **Row hover:** tint wash on the whole row. **Row links:** ink at 500; hover underlines in rule at 3px offset.
- **Activity/artifact lists** are the same grammar as flex rows: type badge (84px, centered), name at 500, muted context, mono meta pushed right at 11.5px.
- **Version rows:** mono 12px — 8-char hash at 500, muted source · age, "current"/"pinned" marks, a small Pin/Unpin ghost button; selected version fills with the seal wash.

### Stat Cards
Not cards — cells of one ruled counting table. 1px hairline borders collapsed via negative margins, transparent fill, 18px 16px 15px padding. Ledger figure (mono 26px, tabular-nums) over a mono-caps muted label. Linked cells wash with tint on hover and turn the figure seal-ink — the only moment a count takes the accent.

### Inputs / Fields
- **Style:** plate fill, 1px hairline border, 0 radius; search input in body sans at 13.5px (9px 12px), editor in mono 12.5px/1.6 (20px padding, min-height 50vh, vertical resize).
- **Focus:** border turns seal-ink with the standard outline collapsed to the border (offset 0). **Placeholder:** muted.

### Navigation
Mono-caps tokens (10.5px / 0.09em) in muted; hover brings ink over tint; the active page holds ink over tint-strong — presence marked by wash, never by accent color. Desktop: vertical stack in the 224px sidebar under the wordmark. Mobile: horizontal 60px translucent bar (blur 6px), tokens compressed to 9.5px, long labels swapped for short forms.

### Notices & Empty States
- **Notice:** seal wash with seal-ink border, body text at 13.5px — used for "viewing an older version" and sync results. Informational, not celebratory.
- **Empty state:** plate fill, hairline-soft border, generous 44px 32px centered padding, muted voice. Copy is terse and directive: "Nothing here yet. Run `dai add .` in a repo to get started." Connectivity failure uses the same calm plate, verbatim: "Couldn't reach the server. Restart `dai webui` and reload."

### Transcript (signature)
Session messages are ledger entries, not chat bubbles: full-width rows split by hairline-soft, each led by a mono-caps speaker label (ink-soft; seal-ink for the user) with mono meta pushed right. Bodies are mono 12px/1.6 pre-wrapped; the user's rows fill with the seal wash at 42% and speak in body sans 13.5px; thinking/system rows go muted italic; tool results sit on plate.

## Do's and Don'ts

### Do:
- **Do** define every new color as a `light-dark()` pair on `:root`; the OS picks the light (The Two Lights Rule).
- **Do** draw all structure with 1px lines at three weights — hairline-soft, hairline, rule — and mark surfaces by a one-step shift to plate.
- **Do** set every number, hash, path, and timestamp in Red Hat Mono, with `tabular-nums` on counts.
- **Do** express hover/active/selected as tint or seal washes over the transparent ground, transitioned by the 0.15s wash.
- **Do** reserve the seal wash + seal-ink pairing for the single primary act, the pin, and the selection.
- **Do** keep the error voice exact and calm, on plate in muted ink: "Couldn't reach the server. Restart `dai webui` and reload."

### Don't:
- **Don't** invert ink and paper for any state — inversion hovers are the refused former loudness.
- **Don't** add card chrome: no shadows, no border radii, no elevated or floating containers.
- **Don't** use registration red for anything except destructive acts; errors and warnings stay neutral.
- **Don't** color harness identity badges — badges stay in the neutral ledger voice; identity is text.
- **Don't** uppercase anything outside the mono label voice (9.5–10.5px); headings and body never shout.
- **Don't** add motion beyond the page-in settle and the 0.15s wash, and always honor `prefers-reduced-motion`.
