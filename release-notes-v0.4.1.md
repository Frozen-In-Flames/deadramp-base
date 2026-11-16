# DeadRamp Base v0.4.1: every building states its own status

## What is new

**Per-building status signs.** Every building that is still in the authorization process now carries a gate sign that states its own level in plain words: UNDER CONSTRUCTION, Authorization in process, and the building's own count, such as "0 of 1 offerings authorized" or "5 of 6 offerings authorized". The exporter derives each sign from the same offering statuses as the construction state itself, so a sign can never disagree with the scaffold it hangs on. All 228 construction-state vendors carry a sign record; the whole catalog holds only nine distinct count lines, and all 227 gate boards render as one merged mesh, so draw calls at spawn are unchanged.

**The surveyed lot speaks plainly too.** TERIDA's lot plaque now reads SURVEYED LOT, Unclassified in the record, 0 of 1 offerings authorized.

**A legend where a visitor arrives.** The plaza directory kiosk gained a three-entry legend: finished buildings are FedRAMP authorized; scaffold and a sign mean authorization in process; an empty lot means unclassified in the record. The arrival help text on both outdoor variants carries the same two sentences, so the reading is taught once, in the tutorial's own lifecycle, and stays recallable from the help button.

**Record cards in plain words.** Building cards, on the flat screen and in the in-world XR mirror, now state status with counts ("Authorization in process, 5 of 6 offerings authorized") instead of an abbreviation alone. The interior lobby panel uses the same wording, so the building says the same thing at the gate, on its card, and inside.

## Why

Nothing about the construction states changed: the scaffold, netting, barriers, and cranes are the FedRAMP record rendered as architecture, and they stay. What was missing was legibility. A scaffolded building read as a generic "coming soon" when the record actually says something specific about that vendor: how many of its offerings are authorized today. Aries's direction was to clarify each building's status in place, per building, without removing or hiding anything. This release is that clarification, at the gate, at the kiosk, in the arrival help, and on the card.

## Verification

- Exporter tests 100 of 100, including sign records re-derived independently from the registry, the Cisco pin at 5 of 6 and the TERIDA pin at 0 of 1, and the status-flip mutation control extended so a flipped vendor gains exactly one sign and no other sign changes.
- The browser suite re-checks all 228 sign records against the catalog, confirms the sign atlas holds exactly the catalog's distinct count lines, reads the plain-words status line on certified, mixed, and lot cards, and confirms the framing text still occurs exactly once, in Settings.
- The platform suite confirms both outdoor help variants carry the new sentences verbatim.
- Walk, XR, and launch suites pass unchanged; the package touches no movement, interior, or terminal code.
