## Why

Two directives from Aries's own playtest of the previous release. The spiral ramp read as capped floors instead of one continuous spiral, and the clean-room disclaimer repeated on walls, panels, and screens until it crowded out the place itself. Both are fixed at the root in this release.

## What is new

- The well is open. Every floor was built as one full ring spanning the ramp band, so each flight climbed under the next floor as a ceiling, and from the landing above the ramp hid beneath flat floor. Floors are now built around a well sector that spirals with the coil, over the arriving and departing flights. From any landing you can see the ramp continuing up and down, and no ramp pierces any floor. The floor-height rule changed in exactly one place, where the floor is genuinely gone: stepping over the well now lands you on the ramp surface instead of on air. Walking behavior is otherwise untouched, and the door readings on the climb are unchanged.
- The disclaimer has one home. It was removed from the lobby plaques, the lobby record panels, the building and bridge and deck info cards, the in-world VR cards, the persistent screen-corner note, the spawn kiosk, and the platform deck. It now lives verbatim in one place inside the experience, the Settings panel, opened from the sliders button beside the help button, the way legal sits in one place in any interface. The README keeps the text as repository documentation.
- The plan records the new placement rule: BASE-PLAN.md in both repositories now states the disclaimer lives in the Settings panel only and is not repeated on walls, panels, cards, or signs.

## Verification

All five suites pass with zero JavaScript errors, including 14 new checks written for this release. The new well checks were demonstrated failing on the previous build before passing on this one: bitmap measurements from the landings show the ramp in the well where a flat slab was before, and a new walk leg proves a visitor stepping over the well lands on the ramp at its exact helical height instead of standing on air. The framing sentence occurs exactly once in the client code, feeding the Settings panel, and zero times anywhere else in the experience. Draw calls are unchanged.
