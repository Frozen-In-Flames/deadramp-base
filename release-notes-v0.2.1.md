## Why

Two pieces of feedback from Aries, given while standing in the Base on his phone, became design rules. First: there is no "press E" on a cellphone or in VR, so no prompt may name a control the visitor's device does not have. Second: guidance should behave like an in-game tutorial, present when it teaches and gone when it has taught, never floating over the simulation forever.

## What is new

- Platform-matched prompts everywhere. The Base detects the visitor's input class once at load. Touch visitors get tap language only (thumb stick, drag to look, tap the door to go in, tap the EXIT door to leave) and the doors themselves are now tap targets, outdoors and in. Desktop keeps the WASD and E copy it already had. The rule is written into LAYOUT.md with its Phase 3 consequence: WebXR will speak controller and gaze, never keys.
- A tutorial lifecycle for the help text. It appears on arrival, appears again briefly the first time you step inside a building, then fades after a few seconds, or sooner once you do the thing it describes. A small bronze-ringed "?" button in the corner recalls it for the space you are standing in.
- A narrow-screen layout fix found during verification: on phone widths the stats line and the clean-room framing note could overlap; they now stack cleanly.
- One correctness fix with real-phone consequences: tap timing is now measured from the touch events' own timestamps. Under a long rendering frame, handler-time measurement was silently dropping genuine taps near doors; event-time measurement is correct even when the device is janky.

## Verification

A new platform suite passes 30 of 30 with zero JavaScript errors across desktop and touch contexts: correct copy per input class (a regex sweep confirms no keyboard language reaches touch visitors), tap-to-enter and tap-to-exit working end to end, help fading and recalling on cue. The full Phase 1 and 2 suite re-passes 50 of 50 on the same tree.
