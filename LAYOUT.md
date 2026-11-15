# DeadRamp Base: layout math and the federal grammar

This document describes the deterministic layout mathematics and the
visual grammar of the Base. All of it is original parametric work,
computed from the DeadRamp catalog. The only mathematics taken from
first-person game worlds is the shared underlying kind every such world
converges on: perspective projection, arc-length layout along a curve,
and distance-band detail. No game code, assets, layouts, or designs are
used. Rendering is Three.js (MIT). Generation owes a debt to the
procedural approach of Aries's own Polyglot Procedural Engine: the world
is computed from data, with zero hand-placed objects.

## The spiral law

One spiral at every scale. Path length along the spiral grows much
faster than the radius, so a compact world feels vast, and sightlines
always curve, which is also the streaming budget: the engine only ever
owes the visitor the next arc of the coil.

- World scale: districts sit on one Archimedean spiral boulevard that
  starts at the central plaza.
- District scale: each district is a smaller Archimedean spiral whose
  start point lies on the boulevard. That start point is the district
  gate, marked by a pylon in the district's tier colour.
- Later scales (building ramps, room exhibits) follow the same law in
  Phases 2 and beyond. They are not part of the Phase 1 build.

## Spiral mathematics

Both spirals are Archimedean: r(phi) = a + b * phi.

Arc length has no closed form worth using at runtime, so the exporter
builds a fixed-step arc-length table (step 0.002 radians, cumulative
Euclidean distance) and answers point and tangent queries by binary
search plus linear interpolation. The step is a layout constant, so the
table, and therefore every coordinate, is deterministic.

### Constants (layout version 1)

| Constant | Value | Meaning |
|---|---|---|
| worldA | 120 m | World spiral starting radius; leaves room for the plaza |
| worldB | 90 m per radian | World spiral growth; one turn separates by about 565 m |
| districtGap | 70 m | Clear arc between neighbouring district edges on the boulevard |
| districtB | 9.5 m per radian | District spiral growth; one turn separates by about 60 m |
| buildingArcSpacing | 24 m | Arc of district spiral per building |
| roadHalfWidth | 4.5 m | District road half width |
| lotClearance | 1.0 m | Gap between road edge and building face |
| roadSampleEvery | 5 m | Polyline sampling step for road ribbons |
| goldenAngle | 2.399963 rad | District orientation offset step (district index times this) |

### District placement

Districts are the (function, tier) pairs of the registry, ordered by
function slug, then tier rank (L1, L2, L3, untiered). A district's
radius is the radius of the sub-spiral that holds its buildings, plus
road, lot, and margin allowances. District centres advance along the
world spiral by previous radius plus own radius plus the district gap,
so districts never overlap along the boulevard.

### Vendor home district and building placement

A vendor's building stands in its home district: the district holding
the plurality of its offerings, ties broken by the district of its
earliest offering in registry order, then by district id. Inside the
district, buildings are placed in registry order along the sub-spiral,
alternating sides of the road. A building at arc position s sits at the
spiral point offset along the local normal by roadHalfWidth plus half
its depth plus lotClearance, and faces the road.

Building size follows offering count n:

- width = min(18, 10 + 2 * (n - 1)) metres
- depth = min(26, 12 + 3 * (n - 1)) metres
- height = min(60, 9 + 6 * (n - 1) + (n >= 5 ? 6 : 0)) metres

### Determinism

Coordinates are rounded to 3 decimals and emitted with a fixed key
order. Re-running the exporter on the same registry produces a
byte-identical catalog (proven by the fidelity tests, which also
include a mutation negative control: flip one field in a copy of the
registry and exactly that offering's entry changes).

## The federal grammar

One institutional architecture language across the whole Base: order,
symmetry, serious materials, gravitas. The grammar is the constant;
the vendor brand layer varies colour and finish inside it. Nothing
about a building's massing, signage system, or materials language is
vendor-specific.

Base finishes:

- Facade: limestone (#cfc9b8)
- Trim: granite (#4c5257)
- Signage band accent: bronze (#8c6a2f)
- Glass at dusk: warm lit windows on certified and mixed buildings

### Brand modulation (evocation only)

Each vendor carries a palette (primary, secondary, accent) and a
source marker, researched or default, in the catalog. The client
modulates the federal finish with the palette:

- Facade tint: researched vendors mix their primary 45 percent into
  the limestone. Default vendors wear plain limestone.
- Roof trim: the brand secondary (federal granite by default).
- Signage band: the brand accent (federal bronze by default).
- Glass tint: lit windows tint 30 percent toward the brand primary
  for researched vendors; default vendors keep warm glass.

Colours are a palette, not artwork. No logos, logotypes, wordmarks,
brand fonts, mascots, or trade dress elements are reproduced anywhere.

### Status weathering

Status is architecture, readable before any sign:

- Certified (every offering FedRAMP Certified): full finish, windows
  lit at dusk.
- Mixed: finish weathered 25 percent toward scaffold grey, windows lit.
- Pipeline (no certified offering): finish weathered 60 percent toward
  scaffold grey, trim and band greyed, windows dark.
- A vendor whose offerings are all unclassified in the DeadRamp build
  (exactly one today, TERIDA) renders as a surveyed empty lot with a
  marker, not a building.

### District and tier legibility

- Function: the district ground carries the function colour family,
  and the district name (function and tier) labels the gate area.
- Tier: the gate pylon wears the tier trim colour (L1 bronze, L2
  silver, L3 gold, untiered slate). Every building in a district
  shares the district tier by containment.
- The boulevard and district roads are one merged geometry each;
  district discs are one merged geometry. Buildings, window overlays,
  roof trims, signage bands, and gate pylons are one InstancedMesh
  each. Measured at spawn: 18 draw calls, 48,242 triangles for the
  whole visible world (see README verification results).

## The building-scale spiral (interiors, Phase 2)

The spiral law recurses into every building. An interior is a
cylindrical tower built on entry for one building and disposed on
exit, placed far below the exterior world so the two never interact.

- Floor height 3.4 m. Level 0 is the lobby; offering j (registry
  order) occupies level j+1, so a building's height is its offering
  count, the same read as its exterior massing.
- A solid core column (radius 3 m) carries the vendor's name band.
  The walkable ring runs from the core railing (5.6 m) to the outer
  wall (15 m). Chambers protrude outward from radius 14.2 m to
  23.4 m, 10 m wide, one per floor.
- The coil: door j sits at angle 0.9 + 1.35j radians. One ramp flight
  per floor winds from the previous door's landing to the next door
  along the ring's outer band (radius 10.4 to 13.6 m), so the climb
  is a single continuous spiral, never a stairwell switchback.
- Height rule: the floor under the player is the candidate surface
  (ring floor, ramp flight, door landing, chamber floor) nearest to
  the player's current height. Stacked floors share the same plan
  coordinates, and the nearest-candidate rule is what makes the
  stack unambiguous without collision geometry.
- Collision is bounds only, stated plainly: the walkable region is
  the ring plus the chamber of the floor the player is on (with a
  height tolerance of three quarters of a floor). Walls are bounds,
  not meshes; partition-level collision is not modeled.
- Brand: the lobby is federal with brand accents (trim, medallion,
  column band, panel title bars). In the rooms the vendor's scheme
  leads: wall treatment mixed from the researched primary, trim and
  door frames in the accent, signage band and accent light tinted by
  the palette. Default-palette vendors get the federal finish in
  their rooms too.
- Performance: one merged static mesh per interior (shell, floors,
  ramps, chamber shells, furniture), one merged mesh for animated
  server strips, panels and signs as individual textured planes.
  Measured on the largest building (IBM, 10 rooms): 19 draw calls in
  the spiral view, 5 to 6 in lobby and room views.

## Platform-matched prompts (standing rule)

Prompts name only the controls the visitor's device actually has
(Aries, Nov 14, 2026: "there is no 'press E' on VR or cellphone").
The client detects its input class at boot (coarse pointer, touch
points) and every instruction follows it:

- Keyboard visitors get the WASD / mouse / E copy, exactly as before.
- Touch visitors get tap language only; no instruction shown to them
  names a keyboard key. Doors are targets, not just signs: standing
  in a building's door zone, tapping the door itself (within a radius
  of its screen position) enters the building, and a tap while
  standing at the lobby EXIT door returns to the boulevard. Other
  taps keep the existing picking (record cards). The contextual door
  prompt speaks the same language ("Tap the door — Enter …",
  "Tap — Exit to the boulevard"). Tap duration is measured on the
  touch events' own timestamps, never on handler execution time: a
  long frame between the two handlers must not eat a genuine tap
  (measured under software rendering: a 206 ms tap whose handlers
  ran 2,566 ms apart).
- Phase 3 (WebXR) inherits the rule: prompts there will speak
  controller and gaze language, never keyboard language.

## The help lifecycle

The help block is an in-game tutorial, not a permanent overlay:

- It shows on arrival outdoors, and again, briefly, on the visitor's
  first entry into an interior, in that space's own variant (outdoor
  and indoor copy differ, each in keyboard and touch language).
- It fades after a 7 second dwell, or sooner once the visitor
  performs the action it describes (entering a building outdoors,
  leaving through the EXIT door indoors).
- A small persistent "?" button in the federal grammar (granite
  disc, bronze ring), touch-sized, recalls the help for the space
  the visitor is currently in, outdoors or indoors.
- The header title and the clean-room framing note are not tutorial
  text; they never fade.
