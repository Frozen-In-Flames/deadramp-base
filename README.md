# DeadRamp Base

A walkable 3D twin of the FedRAMP Marketplace, generated from the
DeadRamp catalog: 674 vendor buildings and 781 service offerings laid
out on one spiral, in a single federal architectural language, that you
walk through in first person. It is a place, not a data viewer with
walls: movement, light, and scale are the interface, and the
architecture itself is the first read (who does what, at what tier, in
what state) before any sign is read.

> Clean-room model built from public FedRAMP Marketplace information,
> inspired by the vendor's public brand identity. Not affiliated with
> or endorsed by the vendor.

That framing is the label, and it is carried wherever a vendor is
named: on the spawn kiosk, on every building info card, in the page
itself, and here. DeadRamp Base is a clean-room rebuild by Frozen In
Flames. Vendor names are used nominatively and factually, from the
public Marketplace record, to identify whose services are modeled.
Colour schemes are evocation only: no logos, logotypes, wordmarks,
brand fonts, mascots, or trade dress elements are reproduced.

The rendition principle, in one analogy: this is the generic medicine,
not the brand product. Same active ingredient (each service, its
function, tier, status, and data, modeled faithfully from the public
record, and proven equivalent by the fidelity tests), different label
and packaging (our federal rendition), and a label that states plainly
it is not the brand product.

## Phase status

| Phase | Scope | Status |
|---|---|---|
| 0 | Catalog exporter (registry to base-catalog.json) with fidelity tests | Implemented, verified |
| 1 | Spiral city exterior: districts, buildings, labels, picking, walking | Implemented, verified |
| 2 | Interiors: lobby and service rooms, in-room panels from real build data | Planned, not built |
| 3 | WebXR: Quest Browser VR, controller locomotion, comfort settings | Planned, not built |
| 4 | Full archetype coverage, merge skybridges, platform deck, construction states | Planned, not built |
| 5 | Guided tours, multiplayer walkthroughs (WebRTC) | Planned, optional |

Stated plainly, so the twin never overstates the repo: the platform
layer deck is a Phase 4 item. The registry itself carries no platform
field (the re-scoped platform entries are build-side state in the
DeadRamp repo), so Phase 1 renders exactly what the registry holds.
The full 674-vendor brand research pass is likewise a later, unhurried
phase; see Brand palettes below for the current seeding state.

## Run it locally

The site is static (index.html plus modules, Three.js vendored under
vendor/). ES modules and the catalog fetch need an HTTP origin, so
serve the folder with any static server, for example:

```sh
cd deadramp-base
python3 -m http.server 8000
# then open http://localhost:8000/
```

Controls:

- Desktop: WASD or arrow keys to walk, mouse to look (click the world
  to lock the mouse), Shift to move fast. Click a building for its
  record.
- Touch: left thumb stick to walk, drag the right side to look, tap a
  building for its record.
- Everything is one spiral away: follow the boulevard out from the
  plaza, or drop into any district at its gate pylon.

## How to read the Base

Legibility comes from the architecture first:

- Function: each district ground carries its function colour family,
  and districts are the registry's (function, tier) pairs.
- Tier: the district gate pylon wears the tier colour (L1 bronze, L2
  silver, L3 gold, untiered slate).
- Status: certified buildings are finished and lit at dusk; pipeline
  buildings are weathered toward scaffold grey with dark windows;
  mixed vendors sit between. One vendor, TERIDA, whose only offering
  is unclassified in the DeadRamp build, is a surveyed empty lot with
  a marker, honestly not a building. (The other unclassified offering,
  USDA's vGov, is flagged as unclassified on its card; the USDA
  building stands for its classified offerings.)
- Brand: inside the federal grammar, a researched vendor's finish is
  tinted by its public palette (facade, trim, signage band, glass).
  See LAYOUT.md for the exact modulation.

Info cards show the public record plainly and completely: vendor,
product, service model, FedRAMP impact level, authorization status,
tier, and the Marketplace source link, exactly as the registry holds
them. The data rail is strict: the Base shows only what the public
record carries. No dollar amounts or any other facts are invented;
the source catalog holds none, and neither does the Base.

## Brand palettes

Every vendor in the catalog carries a palette (primary, secondary,
accent) and a source marker:

- researched: the vendor's brand colours are unambiguous public
  knowledge, seeded by exact registry vendor string in
  tools/export-catalog.js. 77 vendors are seeded today (the
  hyperscalers and large primes among them).
- default: the neutral federal finish (limestone, granite, bronze).
  597 vendors wear it today. A default is honest, not a gap to hide:
  no colour is ever presented as a vendor's brand unless it was
  researched. Info cards say which case applies, in plain language.

## Regenerate and test

The catalog is a snapshot, regenerated from the DeadRamp repo:

```sh
node tools/export-catalog.js     # writes data/base-catalog.json
node tools/test-export.js        # fidelity tests (the equivalence proof)
node verify/verify.js            # headless browser verification + screenshots
```

The fidelity tests assert numbers against the registry: 781 offerings,
674 vendors, 81 districts, every offering field verbatim, district
naming consistent with the deadramp groups tree, deterministic
byte-identical re-export, a mutation negative control (one flipped
field changes exactly one offering entry), and the brand palette
integrity rules (no dead seeds, defaults exactly the federal finish).

## Verification results (Phase 0 and 1, measured Nov 14, 2026)

- Exporter fidelity tests: 26 of 26 pass.
- Page load in headless Chrome: zero JavaScript errors, zero failed
  requests.
- The page's own rendered stats: 674 vendors rendered (673 buildings
  instanced plus 1 empty lot), 781 offerings indexed, 81 districts,
  471 lit-window instances, brand palettes 77 researched and 597
  default.
- Performance discipline: 18 draw calls and 48,242 triangles at spawn
  (11 draw calls in the district street view). Buildings, windows,
  trims, bands, and pylons are one InstancedMesh each; roads and
  district discs are one merged geometry each. (Frame rates measured
  in headless software rendering are not representative of device
  performance and are not claimed.)
- Pixel checks: spawn frame 53.7 percent non-background with 73
  distinct colours; district street frame 59.2 percent; overview
  frame 63.6 percent.
- Movement smoke test: forward input moved the camera 5.6 m in 1.2 s
  of wall time under headless throttling (walk speed is 14 m/s).
- Screenshots: verify/spawn.png, verify/district.png,
  verify/overview.png; full measurements in verify/results.json.

## Layout

The layout mathematics (spiral law, constants, placement rules,
determinism) and the federal grammar with its brand modulation are
documented in LAYOUT.md.

## License

Apache-2.0. See LICENSE. Three.js is vendored under vendor/ and is
MIT licensed (see the header in vendor/three.module.js).
