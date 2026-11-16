# DeadRamp Base v0.4.0: Phase 4 complete

This release closes Phase 4. The Base now carries the full brand research (600 of 674 vendors researched from citable public identity, 74 held at the neutral federal finish on the record), the build lineage skybridges, the platform layer deck, construction states, the lit interiors, and the experience pass: every room's terminal launches its DeadRamp build, all 101 catalogued live. The fixes in this release came from the owner's playtest of v0.3.15.

## What is new, and why

**The Python runtime ships with the site.** Terminals previously loaded their Python runtime from an outside server at first launch; when that load stalled or failed on a visitor's connection, a live room silently fell back to its recorded surface, which reads as placeholder output. The runtime (Pyodide 0.26.4, 13.8 MB) is now vendored into the site itself and loads lazily from the same origin at first launch. World boot is unchanged (plus 1,690 bytes, no runtime bytes). The launch suite now proves a live session with the outside server blocked entirely: the page never even attempts it.

**Lobby directories say where everything is, and what it runs.** Each lobby's directory panel now lists every room with its floor and its mode (RUNS LIVE IN YOUR BROWSER, RECORDED SURFACE, or NO REFERENCE BUILD), and the interior readout names the current floor while climbing ("Floor 3 of 10"). This answers a real playtest finding: in a tall tower the upper rooms were all built and reachable, but nothing in the building said how many rooms existed or which floor you were on, so the top of the spiral read as the end.

**Terminals open on the build's own functions.** A terminal session now displays the build's function surface, its real routes drawn from driving the build and its own test suites, immediately on open, before any typing. The first thing a visitor sees is what the service does.

**Recorded exchanges lead with real driven responses.** The exporter now orders every build's recorded surface drive-first by rule (exchanges captured by driving the build itself ahead of test-suite exchanges), pinned by a new export test across all 101 surfaces. Regeneration is byte-identical, so the rule ratifies what the data already held and guarantees it from here.

**The climb is proven to the top.** The walk suite gains a full-height leg: it climbs the largest tower type on foot, checks the floor height at every door up to floor 10 (34.0 m), and steps into the top room. Full-height climbs are now regression-tested, not sampled to floor 3.

## Verification

All six suites pass with zero JavaScript errors: export fidelity 93 of 93 (including the new drive-first pin and the harvest mutation control), exterior and interior checks, the walk suite with the full-height leg, platform deck checks, XR boundary checks, and the launch suite including the blocked-server live session. Draw calls are unchanged at every measured viewpoint. The framing text still lives in exactly one place in the experience, the Settings panel.

One open item remains, stated plainly: the Phase 3 VR session itself is verified only on the owner's Quest 2, which no headless check can stand in for. Everything else about the Base is complete, and the owner has judged that it looks nice.
