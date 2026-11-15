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
  stack unambiguous without collision geometry. One exception, the
  coil rule, in two parts: a player already on a ramp flight keeps
  that flight's surface while it offers one (continuity), and a
  ramp surface within a step (0.8 m, more than the largest
  single-frame rise at full walk speed) of the current height is
  mounted. Without it the coil is unclimbable on foot: the flat
  ring floor is generated at exactly the player's current height
  on any whole floor, so it won the nearest contest with distance
  0 forever and a walked coil held floor height at exactly 0 in
  every one of 368 samples (measured; verify/verify-walk.js is the
  walk-only proof, entry through the door and W held, no
  teleports). Beyond a step the flat floor keeps the contest, so
  the lobby floor still holds while walking under the coil where
  it passes metres overhead, and stepping off a landing into a
  room is unchanged.
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
- WebXR (Phase 3) inherits the rule in full: while a session is
  presenting, every prompt speaks controller / gaze language only
  ("Trigger — Enter …", "Trigger — Exit to the boulevard"), and the
  input-mode resolver ranks XR above touch, because a headset
  browser also reports touch points and the visitor is holding
  controllers, not a touchscreen. See the Phase 3 section below.

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
- In WebXR the same lifecycle drives an in-world panel on the same
  schedule (show on arrival and on context switches, fade after the
  same dwell), recalled by a controller grip squeeze, since the DOM
  block and the "?" button are invisible inside a headset.

## Phase 3: the WebXR control layer

Phase 3 replaced only the control layer, as the architecture always
intended. The world generation, interiors, movement model, and
player record are unchanged; VR is a third way of driving them.

### The rig

The camera rides in a rig group. The rig carries the player's
ground position and yaw (`rig.position = (player.x, player.y −
eye height, player.z)`, `rig.rotation.y = player.yaw`); the
camera's local transform is the eye. On flat screens the loop sets
the eye from player pitch at standing height, which composes to
exactly the pre-Phase-3 view. While an XR session presents, the
WebXR manager writes the headset pose into the camera's local
transform in reference space and reads the rig as its parent, so
physical head motion and room-scale steps layer onto the same
player position. Sessions therefore begin and end without moving
the visitor: position, yaw, interior, floor, and ramp flight all
live in the player record, never in the session, and all carry
across the boundary. On session end the manager leaves the camera
holding the headset's union projection, so the client restores the
flat field of view and aspect explicitly; leaving VR returns the
exact view the visitor left.

### Sessions

The Enter VR button is rendered only when feature detection
(`navigator.xr.isSessionSupported('immersive-vr')`) proves support;
it is never a dead button, and it is absent entirely where WebXR is
absent. The request runs on the button's click (a user gesture) and
negotiates the reference space down a ladder, ending any half-made
session cleanly before the next step:

1. `local-floor`, required: the visitor stands on the real floor.
2. `local`, with `local-floor` and `bounded-floor` optional.
3. `viewer`, a plain request: seated/standing height is then the
   reference origin's own, with no floor guarantee.

The granted type is recorded (`__BASE__.xr().refSpace`). While
presenting, the button reads Exit VR and ends the session.

### Locomotion

One movement integrator serves every device; XR only adds an input
source and changes the frame it is resolved in:

- Left thumbstick: move. Right thumbstick: snap turn, 45 degrees
  per push past the threshold, re-arming near centre. Snap turning
  is the comfort choice: rotating the world smoothly under a
  stationary head is the classic simulator-sickness trigger, and
  the visitor can always turn physically instead. A thumbstick
  click on either stick is the fast modifier (Shift's analogue).
- Movement is head-directed: the stick vector is resolved against
  the headset's world yaw, sampled per frame, so forward walks
  where the visitor looks. Speeds, the exterior's open bounds, the
  interior's bounds-only collision, and `interiorHeightAt` (with
  the coil rule) are literally the same code as on foot in 2D, so
  the spiral climb behaves identically in VR.
- Physical room-scale motion inside the guardian is the rig's
  gift: it moves the camera within the player anchor without
  touching the player record.

### Picking, records, and doors in VR

- Each controller gets a ray line (bronze, 30 m) parented to its
  target-ray space in the rig; the manager updates the pose per
  frame. The trigger (select) activates with the tap priority: a
  building or lot under the ray opens its record; otherwise an
  armed door (standing in a door zone outdoors, or at the EXIT door
  in a lobby) activates. No keyboard key exists in this vocabulary.
- Records open on an in-world card hung below the centre of view,
  carrying the same record as the DOM card (name, district, status,
  offerings, the framing) plus the door instruction in controller
  language. A grip squeeze closes an open record, dismisses the
  help while it is showing, or recalls the help otherwise.
- Door prompts and help appear as in-world panels (door prompt at
  the bottom of view, help above centre), synchronised with the
  same state that drives the DOM surfaces, so the mirror view and
  the headset never disagree. Panels draw above the world (depth
  test off) and are visible only while presenting.
- Gaze fallback: with no tracked-pointer source, a centre reticle
  appears and the gaze ray dwells: 1.2 seconds resting on a
  building (or resting anywhere while a door prompt is armed)
  activates it, with a 1.5 second cooldown so one dwell fires once.

### Comfort and performance

- Fixed foveation is set to 0.6 at boot and reasserted at session
  start. Three's manager defaults to 1.0 (maximum foveation); 0.6
  keeps peripheral text and signage readable while still easing
  the fragment load on the Quest 2 floor.
- No per-frame allocation in the XR layer: pose rays, dwell state,
  and stick state are module-scope temporaries; panel canvases
  redraw only when their text changes; the merged/instanced draw
  strategy is untouched, so exterior and interior draw calls are
  the Phase 1/2 numbers.

### Verification boundary

`verify/verify-xr.js` proves everything up to the session boundary
in headless Chrome: zero JS errors with WebXR absent, the
affordance agreeing with feature detection, the flat loop intact
under `renderer.setAnimationLoop`, and, against a stubbed
XRSystem, the affordance appearing and the full negotiation ladder
running in order and failing cleanly. Headless Chrome has no XR
runtime, so presentation itself (pose, locomotion feel, in-headset
legibility, frame rate on device) is verified on Aries's Quest 2;
the checklist is in the v0.3.0 release notes.

## Phase 4: skybridges, the platform deck, construction states

Three more records from DeadRamp become architecture. All three
are derived in the exporter from the source records and emitted in
the catalog; the client builds them at load and hardcodes nothing
per vendor.

### Union merges become skybridges

DeadRamp's merge record is a record of merged *builds*, not merged
vendors. A group build's `UNION-SPEC.md` carries a Lineage section;
18 builds state there that they do not start from zero, naming 19
parent edges (one build, customer-service-l3, merges two parents).
The parser takes the first bold phrase ending in "build" followed
by a parenthetical of group links in that section; later prose
mentions of other builds never take that shape and are never
mistaken for parents. The kind comes from the heading: a union
merge, or a cross-tier carry, downward or upward.

No vendor-to-vendor merge exists anywhere in the record, so no
bridge joins two buildings. A bridge joins the *gates of the two
districts* where the child and parent builds' offerings live. A
build's anchor district is the plurality district of the offerings
whose spec sheets live in that build, the same plurality rule as a
vendor's home district. For most builds the anchor is the district
named like the build; six merge builds anchor elsewhere (several to
the uncategorized districts), because that is where the
Marketplace files their forks. That is the record, not an error.

Geometry: a quadratic bezier from parent gate to child gate,
endpoints at 26 m, control point at the midpoint raised to
clamp(30 + distance × 0.16, 44, 150) m. Segments of about 26 m of
arc (8 to 44 per bridge), each a deck slab (3.4 m wide) and a top
rail tinted with the child district's tier trim; the slab is
granite mixed 25% toward the child district's colour. A bridgehead
pylon rises at every gate a bridge lands on. All segments of all
bridges are one InstancedMesh; instance id resolves back to the
merge edge, and picking a bridge opens its record: the two builds,
their fork counts, the Merge Rule (union, never intersection;
highest tier inherited in full; traceability; SSDF process), and
the spec the lineage came from. In VR the same record draws on the
in-world card.

### The platform layer becomes one deck

The 40 GAPS entries DeadRamp closed as `re-scoped` belong to no
vendor and no offering: they are properties of the deployment
platform, governed by the six decisions in `PLATFORM-LAYER.md`
(identity and authentication; FIPS-validated cryptography;
encryption at rest and in transit; audit retention; session lock
and termination; hosting substrate). They render as one shared
deck on the plaza, west of spawn at (−48, 26), facing spawn, in
the federal materials: granite slab, limestone inlay, bronze trim.
The six decisions stand as panels around a central walkway; a
directory board carries the entry record by owning GAPS section
(Group 2: 1, Group 3: 5, Group 4: 1, Group 8: 1, Group 36: 32),
counted from the catalog. The deck carries the clean-room framing
plaque, and picking anywhere on it opens the platform record.

One accounting note, kept visible: the GAPS batch decision
document (gaps-batch/DECISION.md, ratified 2026-11-07) accounts
for 39 re-scope closures (36 platform re-scopes and 3 written
re-scopes); GAPS.md itself carries 40 `re-scoped` entry lines.
The deck presents the 40 in GAPS.md, the fuller record.

### Construction states

A vendor's construction record is `frac`, the share of its own
offerings not yet FedRAMP Certified, computed in the exporter from
the registry statuses. Certified vendors (frac 0) stay finished
and lit, untouched. For any vendor with frac > 0 (227 buildings;
228 vendors counting the surveyed lot, which gets no treatment):

- A scaffold cage stands 0.55 m proud of the facade on all four
  faces, up to height × frac: corner poles and rail levels every
  ~2.3 m. A mixed vendor is scaffolded part-way over its finished,
  lit massing; a pipeline vendor to the top.
- A fully pending tower (frac 1) is wrapped in a translucent
  construction-orange netting shell.
- Three site barriers (orange, white, orange) close the front,
  and an UNDER CONSTRUCTION sign stands at the door side. The
  signage is generic construction vocabulary; no vendor artwork.
- Cranes are district equipment, assigned in the exporter by one
  rule: in each district with at least three fully-pipeline
  buildings, the tallest such building (registry order breaks
  ties) works under a crane: mast to height + 13 m beside the
  tower, jib across the roof, counter-jib and counterweight, a
  hook line and block over the building. 17 districts qualify.

The status weathering of Phase 1 stays exactly as it was; the
construction state extends it rather than replacing it. All
sitework (scaffolds, barriers, cranes, bridgeheads) is one
InstancedMesh; netting is a second; signs a third.

### Measured cost

Measured by `verify/verify.js`: at the fixed exterior viewpoint
(camera at (30, 34) looking at the origin, pitch level), draw
calls went 9 → 15; at the boot spawn view, 18 → 22 draw calls
and 48,242 → 125,220 triangles. The increase is the four
instanced populations (bridges: 824 instances over 412 segments;
sitework: 5,351 instances; netting: 202 shells; signs: 227
boards) plus the deck's merged slab and whichever of its panels
the frustum catches. Triangle growth is the honest cost of real
geometry for scaffolds and bridges; draw calls, the number that
gates phone frame rates, grew by single digits.
