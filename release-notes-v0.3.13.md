## Why

The Phase 4 polish pass. One real defect, a bounded set of arrival improvements, and the plan of record brought into line with what the records actually supported. With this release the Phase 4 build is complete; what remains is judgment, not construction.

## What is new

- The dark upper floors are fixed, at the root. The interior ramp's triangles were wound so the walking surface's front face pointed down while its normals claimed up, so no light from above could ever reach it at any height. The ribbons now wind front face up and carry the helix's true normals, computed from the spiral's own partial derivatives. No light was added or retuned; the existing rig was always sufficient once the surface could receive it. Measured inside a ten room tower: the near black fraction of the view ahead on the ramp fell from between 0.40 and 0.70 to 0.000 at every flight, and the lobby is unchanged, with zero clipped whites anywhere.
- The plaza reads as a plaza. The bare spawn disc is now paved: granite inlay rings at the quarter, half, and three quarter radii, a bronze ringed medallion at the spiral centre, lighter base paving, still one mesh and one draw call. Dusk balance lifted slightly across hemisphere and fill, and vendor and district labels now fade in at legible opacity with a subtle backing, instead of sitting at the old floor where they washed out at spawn.
- The plan tells the truth about Phase 4. BASE-PLAN.md, in both repos, now records that the skybridges render the UNION-SPEC build lineage because DeadRamp's records contain no vendor to vendor merges, and that the platform deck presents the 40 re-scoped entries in GAPS.md with the gaps batch decision's 39 closure accounting noted alongside.

## Verification

All five suites pass on the final tree with zero JavaScript errors: exporter fidelity tests, the full site suite, the on foot walk suite (the climb proof), the platform prompt suite, and the XR boundary suite. Draw calls are unchanged at every measured viewpoint; triangles rose by exactly the paving geometry. Before and after measurements and screenshots are recorded in LAYOUT.md.
