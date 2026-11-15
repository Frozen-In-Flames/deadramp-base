## Why

The per-phase playthrough filming caught a real defect. Preparing the Phase 2 chapter raised an honest question: does plain walking actually climb the interior spiral ramp, or did the earlier checks only ever prove teleporting? A walk-only test answered it. Walking could not climb at all. The floor-height logic picked whichever candidate surface sat nearest the player's current height, and the flat ring floor, which is computed from that same height, won the contest at distance zero on every step, forever. The coil looked like a ramp and behaved like decoration.

## What is new

- The coil rule, in two parts. The interior now tracks which flight you are standing on: while that flight still offers a surface under you, its helical height is your floor, at any walking speed. And a ramp surface within one step (0.8 m, derived from the largest rise a single frame can physically contain) of your current height can be mounted, at the foot of the coil or stepping down from a landing. Beyond a step, the flat floor keeps the contest, so walking the lobby ring underneath the flights still holds the lobby floor.
- Teleporting now resets flight tracking, since a jump breaks surface continuity.
- A new walk-only verification suite (verify/verify-walk.js) proves the behavior on foot: through IBM's real door, around the lobby ring, then up the coil with movement controls only, passing the floor doors at 3.37 m and 6.84 m against their designed 3.4 m and 6.8 m, and standing at floor 3 at 10.02 m. Every risen sample was measured riding the ramp surface.
- The rule and the measurement behind the step size are documented in LAYOUT.md.

## Verification

Main-side re-verification on the shipped tree: walk suite all checks passed, the full Phase 1 and 2 suite all checks passed (50 of 50), the platform suite all checks passed, zero JavaScript errors. Exterior behavior, room floors, and stepping off at landings are unchanged.
