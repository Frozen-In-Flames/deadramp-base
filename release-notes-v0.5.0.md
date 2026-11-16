# DeadRamp Base v0.5.0: the accessibility release

This release implements the findings of the measured accessibility audit conducted against v0.4.0 (36 WCAG 2.2 criteria assessed: 21 pass, 12 fail, 3 not applicable, with three blockers). The Base is generated from data, so every fact in the scene can also exist as text; this release builds that second, fully equivalent surface and repairs the interaction defects the audit measured.

## What is new

**Directory mode.** A Directory button (and a skip link) opens a searchable, screen-reader-native directory rendered as real document structure: 81 district sections, all 674 vendors with their status stated in the same plain words the record cards use, and all 781 offerings with their launch modes. Each vendor offers Open record, Go to, and Enter building; inside a building, the Directory lists the rooms with Go to room and Open terminal actions. The directory is a pure function of the same catalog the scene renders from, so the text cannot drift from the place.

**Full keyboard operation.** Turning takes the Comma and Period keys (the E key keeps its established action meaning: enter, launch, exit), and Enter performs the same centre pick a pointer click performs, opening the same cards and terminals. Touch visitors gain hold-to-turn pads. A keyboard-controls switch in Settings turns the scene keys off entirely.

**Announcements and focus care.** A polite live region announces arrival, district changes, door prompts, record opens, building entries and exits, and floor changes; terminal output is a live log. Opening any panel moves focus into it; closing returns focus to the control that opened it; Escape closes the topmost panel.

**Measured repairs.** Label fade floors are raised so vendor and district labels meet the 4.5:1 contrast requirement at rendered opacity (sampled 7.96:1 to 13.93:1; the same computation at the old floor fails at 4.12:1, which is the audit's defect reproduced as a negative control). The viewport no longer bans pinch zoom. All close buttons meet the 24 by 24 CSS pixel minimum target size. The pooled scene labels are hidden from assistive technology, with their information carried by the Directory and announcements. The reduced-motion preference is honoured: under it, help does not fade and interior idle animation holds still.

**Comfort settings.** Settings gains reduced motion (following the operating system until set), high-contrast labels, larger labels, and the keyboard-controls switch, persisted across visits, plus an Accessibility statement that names what the environment provides and its remaining limits.

## Why

A public environment that can only be used with a pointer and a screen excludes visitors by construction. Because the Base is a generated view over a verified catalog, accessibility here is not an overlay: the same record that builds a building also builds its text equivalent, and the fidelity discipline that governs the rest of the project (every claim re-derived by the test suites) now governs the accessible surface too.

## Verification

A new suite, verify/verify-a11y.js, adds 60 checks in the project's style, including the directory-count mutation control (a catalog copy with one vendor dropped must yield exactly 673 directory records) and the contrast negative control described above. All seven suites pass: exporter fidelity, principal verification, walk, platform, XR boundary, launch, and accessibility. Draw calls at spawn are unchanged at 21; boot weight rises by 33,476 bytes, all of it the Directory, announcements, settings, and focus logic.

## Stated limits

In-headset panels remain visual only, because WebXR offers no assistive channel; the Settings statement says so plainly. The on-device checks (VoiceOver on iPhone, the Quest 2 pass) remain to be run by the owner. One cosmetic finding, the stats bar overlap at 320 pixel width, is deferred rather than bundled, because repairing it means reworking the HUD layout that other suites measure.
