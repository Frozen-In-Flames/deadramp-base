## Why

The eighth tranche of the Phase 4 brand research pass, continuing in registry order under the same rule: a palette is seeded only when a citable public source establishes the vendor's colors as published hex values, verified against the source before seeding, and a vendor whose colors cannot be established keeps the federal finish.

## What is new

- 54 more vendors wear their own researched colors, 470 of 674 researched in total, including OCLC, Omnissa, Orca Security, PagerDuty, Perplexity AI, Pinecone, Pitney Bowes, Precisely, Procore, Qualtrics, and the rest of the tranche in the exporter's seed table, each with its source recorded beside it. The tranche opens with OneSpan, whose palette was verified in the previous pass and held unseeded at that tranche's boundary; it was re-fetched, confirmed exactly, and seeded here.
- 6 vendors stayed default on the record: one whose listing now presents its acquirer's brand, one whose own domain presents only its parent company's palette under the parent's name, one whose listing states exactly two colors, one major vendor whose listing page states no hex palette at all and whose own guidelines could not be found, and two that could not be identified to any citable source.
- Two partial tensions between listing prose and listed swatches are recorded in the seed table where they occur; in both cases the prose's colors are present in the seeded palette, so the seeds stand on the swatch data with the tension on the record.

## Verification

Exporter fidelity tests pass in full (781 offerings, 674 vendors, byte-equal fields, deterministic re-export, both mutation controls, brand-integrity checks including researched count equals seed-table size). The full site suite passes with zero JavaScript errors. Main-side spot checks on the new seeds all match their sources, and the fallback-trio guard confirms zero researched vendors carry it.
