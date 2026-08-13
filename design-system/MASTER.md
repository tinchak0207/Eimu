# Design System — Tinchak Image Studio
# Global Source of Truth

## Identity
- **Product**: Commercial AI image generation SaaS (中轉站)
- **URL**: image.tinchak0207.xyz
- **Stack**: Next.js 15, Tailwind CSS 3, shadcn/ui, TypeScript
- **Target**: Non-technical users (小白), mobile-first

---

## Visual Language

### Core Style: Apple iOS 26 Liquid Glass
Based on WWDC25 "Meet Liquid Glass" (Session 219). All components use the Liquid Glass material system.

**Core principles from Apple:**
1. **Refraction** — glass bends background via `backdrop-filter: blur + saturate + brightness`
2. **Specular highlight** — bright top border (`rgba(255,255,255,0.92)`), dim bottom border (`rgba(0,0,0,0.06)`)
3. **Color sampling** — `saturate(180%)` pulls ambient color from background
4. **Spring physics** — `cubic-bezier(0.34, 1.56, 0.64, 1)` for all interactive transitions
5. **Three-tier material hierarchy** — card → float → bar
6. **SF Pro font stack** — `-apple-system, BlinkMacSystemFont, "SF Pro Display"`

**DO NOT** use the old paper-card / zen-dock / ink-wash classes in new components.
**DO** use the `lg-*` class system exclusively for new work.
**Legacy aliases** exist in globals.css for backward compat — do not add new ones.

### Liquid Glass Material Tiers
```css
.lg-card    /* primary — main content cards, blur 40px, sat 180%, bright 1.08 */
.lg-float   /* secondary — pills, badges, secondary panels, blur 28px */
.lg-bar     /* tertiary — navbar, dock, toolbar, blur 48px, sat 200% */
.lg-sheet   /* elevated — modals, sheets, popovers, blur 60px */
```

### Tinted Glass Variants
```css
.lg-tint-blue   /* #007AFF — primary actions, links */
.lg-tint-green  /* #34C759 — success, completed */
.lg-tint-red    /* #FF3B30 — error, destructive */
.lg-tint-gold   /* #FFB300 — wallet, coins */
.lg-fill-active /* selected state */
```

### Specular Highlight Pattern
Every card/sheet needs a top-edge specular line:
```jsx
<div className="pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-[inherit] bg-gradient-to-r from-transparent via-white to-transparent opacity-80" />
```

---

## Color Tokens

| Token | Value | Usage |
|-------|-------|-------|
| `--background` | hsl(210 23% 97%) | Page background |
| `--foreground` | hsl(222 18% 22%) | Primary text |
| `--muted-foreground` | hsl(220 10% 49%) | Secondary text |
| `--primary` | #2d3142 | CTA buttons, key actions |
| `--ring` | hsl(158 17% 44%) | Focus ring, accent |
| `--destructive` | hsl(2 58% 58%) | Error states |
| `--coin-gold` | #c9a84c | Coin/wallet accent |
| `--coin-gold-light` | #f5e6c0 | Coin badge background |
| `--success` | #5b7a5e | Success states |
| `--success-light` | #e7efe9 | Success badge background |

---

## Typography

- **Font**: Geist (existing, keep)
- **Mono**: Geist Mono (existing, keep)
- **Scale**:
  - Label/eyebrow: `text-[11px] tracking-[0.18em] font-medium text-[#7b8694]`
  - Body small: `text-sm text-[#6e7886]`
  - Body: `text-[15px] leading-8`
  - Heading: `text-lg font-semibold text-foreground`

---

## Spacing & Radius

- **Card radius**: `rounded-[2.4rem]` (large cards), `rounded-[2.15rem]` (model cards)
- **Button radius**: `rounded-full`
- **Select radius**: `rounded-[1.35rem]`
- **Page padding**: `px-4 sm:px-6 lg:px-8`
- **Max width**: `max-w-[1660px]`

---

## Interaction Patterns

- Hover lift: `hover:-translate-y-[1px]` with `transition-all duration-200`
- Active fill: `.ink-wash` class
- Loading: skeleton pulse or `animate-spin` spinner (Lucide `LoaderCircle`)
- Disabled: `disabled:bg-[#bcc2ca] disabled:cursor-not-allowed`
- Focus: ring via `--ring` token, always visible

---

## Component Patterns

### CTA Button (primary)
```
bg-[#2d3142] text-white rounded-full px-5 py-3.5 text-sm font-medium
shadow-[0_18px_36px_rgba(45,49,66,0.12)]
hover:-translate-y-[1px] hover:bg-[#272b39]
transition-all duration-200
```

### Status Badge
```
inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium
+ state-specific bg/text colors
```

### Coin Badge
```
paper-float inline-flex items-center gap-1.5 rounded-full px-3 py-1.5
text-sm font-medium text-[#c9a84c] bg-[#f5e6c0]/60
```

---

## Auth Flow (new-api integration)

- User logs in via new-api → receives `sk-xxx` token
- Token stored in `localStorage` as `napi_token`
- All API calls include `Authorization: Bearer sk-xxx`
- Balance fetched from new-api `/v1/dashboard/billing/subscription`
- On 401 → clear token → show AuthModal

---

## Page Inventory

| Page | File | Status |
|------|------|--------|
| Main canvas | `src/app/page.tsx` | Upgrading |
| Image playground | `src/components/ImagePlayground.tsx` | Upgrading |
| Navbar | `src/components/Navbar.tsx` | New |
| Auth modal | `src/components/AuthModal.tsx` | New |
| Style presets | `src/components/StylePresets.tsx` | New |
| Wallet badge | `src/components/WalletBadge.tsx` | New |

---

## Anti-patterns (NEVER do these)

- No emoji icons in UI
- No dark mode default
- No layout shift on hover
- No `bg-white/10` in light mode (too transparent)
- No exposing `GATEWAY_MASTER_KEY` to browser
- No direct fetch to new-api from client without server proxy
