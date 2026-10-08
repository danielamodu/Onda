# Onda design system

## Product identity

- **Product:** Onda helps businesses pay people in Nigeria and gives recipients a clear choice about how to receive a payment.
- **Feel:** Calm, precise, dependable, and human. The product should feel like payment infrastructure, not a crypto dashboard.
- **Audience:** Businesses sending payments and recipients receiving them.
- **First impression:** “I understand what Onda does, and I can see the next step.”

## Visual language

- **Direction:** Restrained financial utility with editorial spacing and clear transaction hierarchy.
- **Brand source:** The supplied Onda mark. Preserve its lowercase wordmark, navy, crimson, and warm white. Do not replace the mark with a text glyph or redraw it in CSS.
- **Brand files:** Use `public/brand/onda-logo.png` in the interface. `public/brand/onda-logo-source.png` preserves the supplied transparent source image.
- **Typography:** Manrope for headings and display; DM Sans for interface/body copy; DM Mono for IDs, amounts, and compact metadata. Keep the existing families for consistency and readability.
- **Color roles:** Navy is the main action and text color. Crimson identifies the brand and is used sparingly for small accents; it must not communicate success. Warm white and cool gray form the surfaces. Success, warning, and error each have distinct semantic colors.
- **Surfaces:** Light neutral page canvas, white working surfaces, subtle cool borders, and restrained shadow only for elevated forms/details.
- **Motion:** Existing short transitions for button and row feedback only. Respect reduced-motion preferences. No decorative motion added.
- **Reference principles:** Increase's transaction-first hierarchy and direct financial language; Jeton's short action labels and simple transfer progression. Onda keeps the same restraint without copying their layouts or brand details.

## Design tokens

Primary colors sampled from the supplied logo artwork:

| Token | Value | Role |
| --- | --- | --- |
| Brand navy | `#001639` | Brand text, primary actions, strongest contrast |
| Brand crimson | `#D6002E` | Logo accent, small brand markers |
| Brand warm white | `#F4F4F4` | Logo field and neutral highlight |

Interface roles:

| Token | Value | Role |
| --- | --- | --- |
| Canvas | `#F7F8FA` | Main page background |
| Surface | `#FFFFFF` | Forms, panels, detail surfaces |
| Surface muted | `#EEF1F5` | Quiet inset and selected backgrounds |
| Border | `#DCE2EA` | Dividers, inputs, panel edges |
| Text | `#071B37` | Main interface text |
| Text muted | `#637188` | Supporting copy and labels |
| Success | `#23744D` | Verified/completed state |
| Warning | `#8B5B16` | Pending/caution state |
| Danger | `#A52A3A` | Failed/destructive state |

Existing spacing/radius rhythm remains: 4/8/12/16/24/32px spacing; 6px controls, 10px panels, and 16px larger surfaces. Transitions stay between 150–250ms with the existing ease-out curve.

## Copy voice

- Direct, plain-language, and specific. Prefer short labels and explicit state descriptions.
- Use **Onda** consistently in prose; use the supplied lowercase wordmark asset for visual identity.
- Business primary action: **Pay someone**. Recipient action: **Choose how to receive**.
- Refer to the recipient as “recipient” in business views and to “your payment” in recipient views.
- State clearly when no money has moved or when a preference is saved without an actual payout.
- Avoid unexplained chain names, crypto jargon, vague marketing claims, and decorative all-caps copy.

## User flow

1. Business signs in and sees its payments.
2. Business chooses **Pay someone**, enters recipient/payment details, and creates the record.
3. Business reviews the payment and can fund it from its wallet.
4. Recipient signs in, sees incoming payment state, and records a receive preference.

## Screen inventory

- Public landing / sign-in entry
- Business dashboard and empty state
- Business sign-in and sign-up
- Create payment
- Business payment details and funding/settlement states
- Recipient sign-in and sign-up
- Recipient dashboard and empty state
- Recipient payment details and preference selection
- Not-found and temporary-error states

## Design constraints

- Preserve the existing payment and recipient functionality.
- Do not claim a transfer or payout succeeded unless the backend/provider has verified it.
- Keep the UI clear at 320px wide and avoid horizontal overflow.
- Use one shared Onda logo component across business and recipient shells.
- Keep colors token-driven so future UI stays on-brand.
- The logo mark is the source of truth; no invented replacement icon or text symbol.
