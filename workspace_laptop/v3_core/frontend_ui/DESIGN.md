# Uchino Frontend Design

## 1. Scope

This file documents the existing UI language for the active Vite frontends. It is descriptive, not a redesign brief.

## 2. Visual Direction

Robot, Cocina and the served Admin dashboard use a dark operational neon interface for fast scanning: cyan for live/system state, amber for pending/action, green for success, rose for danger, and purple for intelligence/admin accents.

## 3. Tokens

- Background: `bg-chipi-bg`
- Surface: `glass`, `bg-chipi-card`
- Border: `border-chipi-border`
- Text: `text-text-primary`, `text-text-secondary`, `text-text-dim`
- Accents: `text-neon-cyan`, `text-neon-amber`, `text-neon-green`, `text-neon-rose`, `neon-text-purple`
- Actions: `btn-primary`, `btn-amber`, `btn-green`

## 4. Layout

Use dense operational panels, route-level tabs, compact cards, and fixed-height dashboard areas. Avoid landing-page sections inside the app surfaces.

## 5. Components

- Metric cards: `glass rounded-2xl border border-chipi-border p-5`
- Tabs: `nav-active` for selected state, muted text for inactive state.
- Forms: dark card background, `border-chipi-border`, cyan focus border, compact labels.
- Status messages: tinted borders with the same accent as the message state.

## 6. Interaction

Controls must show loading/disabled states and preserve the dashboard layout. Hardware controls must report disconnected hardware honestly instead of pretending success.
