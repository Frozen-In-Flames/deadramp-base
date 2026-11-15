## Why

Phase 1 proved the city. A twin you cannot enter is only a model, so Phase 2 makes every building a place: walk in, climb the spiral, and stand inside the room of the service you came to see. The marketplace stops being a chart and becomes a building full of working offices.

## What is new

- Room records for all 781 offerings, traced to the real DeadRamp builds. The exporter now joins each offering to its source spec (779 exact joins; the only 2 without one are the 2 unclassified offerings, flagged honestly since Phase 0), hashes all 854 source modules into a manifest, extracts each build's command and operations surface, and carries the control catalogs of the 8 groups that have them. Test functions across the builds: 16,969, counted.
- Interiors: every building generates its lobby and a spiral ramp tower on entry, one room per offering, and disposes it all on exit. Six room archetypes follow the service's own function: operations center (130 rooms), lab (254), meeting space (118), ledger office (29), server hall (17), and the federal office fallback (233). Each room carries three panels: the service record, its functions and controls where the build has them, and a terminal showing the reference build's actual extracted surface, labeled as the build's own, never as the vendor's API.
- Brand per room: each room wears its own vendor's color scheme. Researched palettes lead the room's finishes; vendors without an established palette get the federal finish, never invented colors. The lobby stays federal with brand accents, and the clean-room framing plaque hangs in every lobby.
- Door signage carries each offering's tier and status; the two unclassified offerings keep their honest flags indoors too.

## Verification

Main-side re-run, not just the builder's word: 47 of 47 exporter fidelity tests pass, including both mutation controls (one flipped spec field changes exactly one room field; one flipped product name changes zero rooms) and all 854 manifest hashes; re-export is byte-identical. In-browser checks pass 50 of 50 with zero JavaScript errors: room counts match the catalog for a 1-room, a 4-room, and the largest 10-room vendor; sampled room text matches the source spec verbatim; the largest interior renders in 19 draw calls.

## Honest limits

Long service records exceed a wall panel's capacity; the panel caps with a visible "+N more in the source record" line and the full record stays in the catalog, never silently dropped. Visual polish is early, flat lighting and plain chamber walls; finish work belongs to the later phases. Device performance on phone and Quest is Phase 3 and remains untested by design.
