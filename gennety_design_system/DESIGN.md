---
name: Gennety Design System
colors:
  surface: '#050505'
  surface-dim: '#000000'
  surface-bright: '#0a0a0a'
  surface-container-lowest: '#0e0e0e'
  surface-container-low: '#050505'
  surface-container: '#080808'
  surface-container-high: '#0a0a0a'
  surface-container-highest: '#111111'
  on-surface: '#ededed'
  on-surface-variant: '#a3a3a3'
  inverse-surface: '#e5e2e1'
  inverse-on-surface: '#313030'
  outline: '#1a1a1a'
  outline-variant: '#2a2a2a'
  surface-tint: '#c6c6c7'
  primary: '#ffffff'
  on-primary: '#2f3131'
  primary-container: '#e2e2e2'
  on-primary-container: '#636565'
  inverse-primary: '#5d5f5f'
  secondary: '#c8c6c5'
  on-secondary: '#313030'
  secondary-container: '#474746'
  on-secondary-container: '#b7b5b4'
  tertiary: '#ffffff'
  on-tertiary: '#303030'
  tertiary-container: '#e4e2e1'
  on-tertiary-container: '#656464'
  error: '#f43f5e'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#e2e2e2'
  primary-fixed-dim: '#c6c6c7'
  on-primary-fixed: '#1a1c1c'
  on-primary-fixed-variant: '#454747'
  secondary-fixed: '#e5e2e1'
  secondary-fixed-dim: '#c8c6c5'
  on-secondary-fixed: '#1c1b1b'
  on-secondary-fixed-variant: '#474746'
  tertiary-fixed: '#e4e2e1'
  tertiary-fixed-dim: '#c8c6c6'
  on-tertiary-fixed: '#1b1c1c'
  on-tertiary-fixed-variant: '#474747'
  background: '#141313'
  on-background: '#e5e2e1'
  surface-variant: '#353434'
  status-active: rgba(34, 197, 94, 0.15)
  status-pending: rgba(234, 179, 8, 0.15)
  status-dislike: rgba(244, 63, 94, 0.15)
typography:
  display:
    fontFamily: Inter
    fontSize: 72px
    fontWeight: '700'
    lineHeight: 82px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Inter
    fontSize: 48px
    fontWeight: '700'
    lineHeight: 56px
    letterSpacing: -0.02em
  headline-md:
    fontFamily: Inter
    fontSize: 30px
    fontWeight: '700'
    lineHeight: 36px
    letterSpacing: -0.01em
  title-lg:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
  body-lg:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: '400'
    lineHeight: 28px
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  label-md:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 16px
  label-sm:
    fontFamily: Space Grotesk
    fontSize: 11px
    fontWeight: '400'
    lineHeight: 14px
    letterSpacing: 0.05em
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  xs: 4px
  base: 8px
  sm: 12px
  gutter: 16px
  md: 24px
  margin: 24px
  lg: 40px
  xl: 64px
---

## Brand & Style
The design system of Gennety is built on an ultra-minimalist, high-end "Dark Mode First" aesthetic. It is tailored for an AI-driven, professional matchmaking platform targeting agents, developers, and founders. The visual identity exudes precision, exclusivity, and cutting-edge technology.

Rather than relying on heavily saturated colors to grab attention, Gennety uses deep darkness with highly deliberate white and monochromatic typographic accents to direct the user's eye. The interface feels weightless but highly structured, utilizing very faint borders, subtle glow effects, and micro-animations to create a premium digital experience.

## Colors
The color palette is strictly monochromatic with a few semantic accents used sparingly for statuses or specialized badges.

- **Primary Canvas:** A stark, deep black (`#050505`) serves as the foundation.
- **Surface & Hierarchy:** Content is separated not by stark contrasting backgrounds, but by faint, translucent borders (`#1a1a1a` to `#2a2a2a`) and very subtle shifts in black tones (`#080808` to `#111111`).
- **Typography Colors:** High contrast white (`#ededed`) for primary content, grading down through neutral grays (`#a3a3a3`, `#737373`, `#525252`) for metadata, timestamps, and secondary labels.
- **Semantic Accents:** Statuses use muted, translucent washes of color (e.g., green for active matches, yellow for pending/aging, and red/rose for dislikes). These accents are primarily driven by low-opacity background fills (`10%` to `20%` opacity) paired with colored borders.

## Typography
The system employs a dual-typeface approach that balances humanist readability with technical precision.

- **Primary Typeface (Geist Sans):** Used for headlines and body copy. It is clean, geometric, and optimized for screen reading. Headlines are tight and bold (`tracking-tight`), while body text uses a relaxed `leading-relaxed` line height to ensure maximum readability against the dark background.
- **Secondary Typeface (Monospace):** A technical monospace font is used for timestamps, user ranks, scores, system logs, and micro-labels. This typographic contrast reinforces the "AI Agent" and "Developer" persona of the product.

## Layout & Spacing
The layout follows a precise, structured, and generous flow.

- **Width & Containment:** The main content is typically constrained to a maximum width (e.g., `max-w-5xl`) centered on the page.
- **Whitespace:** Spacing is generous. Large gaps (`xl` to `2xl`) are used between major sections to let the minimalist design breathe.
- **Component Padding:** Internal padding within cards is ample, ensuring text and badges never feel cramped.

## Elevation & Depth
In an ultra-dark theme, depth is notoriously difficult to achieve using shadows. Gennety solves this through glowing effects and layered borders.

- **Borders over Shadows:** Depth is primarily established by wrapping floating elements in thin, slightly lighter borders (`#1a1a1a`).
- **Subtle Glows:** Core call-to-actions or focal elements may employ extremely diffused, low-opacity white glows (e.g., `rgba(255, 255, 255, 0.06)`) rather than traditional black drop shadows.
- **Interactive Depth:** Cards lift interactively on hover, transitioning to a slightly lighter border (`#2a2a2a`) and sometimes utilizing micro-animations to simulate tactile feedback.

## Shapes & Structural Elements
The geometry of the interface is mixed, utilizing both sharp structure and soft touchpoints.

- **Cards & Containers:** Primary content containers use an `xl` or `2xl` border radius to create a slightly softer, more approachable feel to balance the harsh black theme.
- **Interactive Elements:** Buttons and small badges often use a `full` (pill-shaped) radius.
- **Separators:** The system makes heavy use of 1px dashed or solid border lines (often with gradient fades `to-transparent`) to connect elements logically without cluttering the UI.

### Badges and Tags
Labels and metadata (such as expertise or domain) are encased in pill or subtly rounded rectangles. These badges use darker neutral backgrounds (`#111111`) with neutral text, ensuring they do not visually compete with the primary data on the screen.

### Dialogue & AI Components
AI-centric components (like the agent dialogue window or match negotiation timelines) combine the technical monospace font with soft container shapes. They often feature pulsing status dots, conveying the feeling that the AI is actively "thinking" or processing behind the glass of the interface.