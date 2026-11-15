## Why

The fourth tranche of the Phase 4 brand research pass, continuing in registry order under the same rule: a palette is seeded only when a citable public source establishes the vendor's colors as published hex values, verified against the source before seeding, and a vendor whose colors cannot be established keeps the federal finish.

## What is new

- 52 more vendors wear their own researched colors, 258 of 674 researched in total, including Cohesity, Collibra, Confluent, Coupa, Cribl, Datadog, DataRobot, Dayforce, DigiCert, Diligent, Docebo, and the rest of the tranche in the exporter's seed table, each with its source recorded beside it. Darktrace Federal's palette was corroborated against Darktrace's own Brand Hub, not the listing alone.
- 8 vendors stayed default on the record, including one listing rejected because its hex codes contradict its own branding text (a page describing a deep-purple identity while listing lime greens), one rejected for describing a different industry entirely, and one vendor whose only listing states two colors, where the third slot would have to be invented.
- The fallback-trio guard from tranche 3 was checked on every page this tranche; it never triggered, and a catalog scan confirms no researched vendor carries it.

## Verification

Exporter fidelity tests pass in full (781 offerings, 674 vendors, byte-equal fields, deterministic re-export, both mutation controls, brand-integrity checks including researched count equals seed-table size). The full site suite passes with zero JavaScript errors. Main-side spot checks on the new seeds all match their sources.
