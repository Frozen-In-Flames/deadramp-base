## Why

The fifth tranche of the Phase 4 brand research pass, continuing in registry order under the same rule: a palette is seeded only when a citable public source establishes the vendor's colors as published hex values, verified against the source before seeding, and a vendor whose colors cannot be established keeps the federal finish.

## What is new

- 52 more vendors wear their own researched colors, 310 of 674 researched in total, including Drata, Druva, Egnyte, Ericsson, Figma, Files.com, Forescout, Freshworks, Geotab, Granicus, HackerOne, and the rest of the tranche in the exporter's seed table, each with its source recorded beside it.
- 8 vendors stayed default on the record: two listings rejected because their hex codes contradict their own branding text, one listing that now sits under an acquirer's brand, one whose only listing describes its successor brand after a rename, one listing describing two different companies in its header and its About section, and two with no citable hex source anywhere found.
- One judgment call is flagged in the seed table for the record: a vendor whose palette shares a single swatch value with the listing service's fallback trio, but not the trio itself, with named unique swatches and an About section naming that vendor's own products. It was seeded on that evidence; the fallback-trio guard still confirms zero researched vendors carry the full trio.

## Verification

Exporter fidelity tests pass in full (781 offerings, 674 vendors, byte-equal fields, deterministic re-export, both mutation controls, brand-integrity checks including researched count equals seed-table size). The full site suite passes with zero JavaScript errors. Main-side spot checks on the new seeds all match their sources.
