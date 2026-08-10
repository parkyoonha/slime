/* ─── Colors ─────────────────────────────────────────── */

// Slime and bead share the SAME colour palette. Keeps the design
// consistent (same swatches everywhere), lets coating tint follow
// slime colour directly, and lets us drop the old special-case
// coating palettes / forced-matte adjustments.
export type ColorId =
  | 'pearl'
  | 'pink'
  | 'peach'
  | 'lemon'
  | 'mint'
  | 'sky'
  | 'lavender'
  | 'ruby'
  | 'gold'
  | 'silver'
  | 'coral'
  | 'aqua'

/** Per-color HSL delta the user has dialled in via the adjustment
 *  sliders. Keyed on ColorId — each entry [dh, dl] where dh shifts
 *  hue in degrees (-30..30) and dl shifts lightness (-25..25). Colors
 *  without an entry render at their preset hex. Shared between slime
 *  and beads so an adjusted 아쿠아 reads the same across both surfaces. */
export type ColorAdjustments = Partial<Record<ColorId, readonly [number, number]>>

export const COLORS: readonly {
  id: ColorId
  label: string
  hex: number
}[] = [
  { id: 'pearl', label: '진주', hex: 0xfff8f4 },
  { id: 'pink', label: '핑크', hex: 0xff9ac9 },
  { id: 'peach', label: '피치', hex: 0xffb591 },
  { id: 'lemon', label: '레몬', hex: 0xffe25e },
  { id: 'mint', label: '민트', hex: 0x8fe8c4 },
  { id: 'sky', label: '하늘', hex: 0x8fc7ff },
  { id: 'lavender', label: '라벤더', hex: 0xc5a5f2 },
  { id: 'ruby', label: '루비', hex: 0xf24d6b },
  { id: 'gold', label: '골드', hex: 0xffcf5e },
  { id: 'silver', label: '실버', hex: 0xd6dbe1 },
  { id: 'coral', label: '코랄', hex: 0xff7d7d },
  { id: 'aqua', label: '아쿠아', hex: 0x5ee3d8 }
]

/** Resolve a ColorId to its numeric hex, optionally applying any
 *  hue / lightness delta the user has dialled in via the adjustment
 *  sliders. HSL space keeps the tweak "within family" (아쿠아 stays
 *  aqua-adjacent) instead of skewing into arbitrary hues. */
export function resolveColorHex(
  id: ColorId,
  adjustments?: ColorAdjustments
): number {
  const preset = COLORS.find((c) => c.id === id)
  const baseHex = preset?.hex ?? 0xffffff
  const delta = adjustments?.[id]
  if (!delta || (delta[0] === 0 && delta[1] === 0)) return baseHex
  return applyHslDelta(baseHex, delta[0], delta[1])
}

export function resolveColorLabel(id: ColorId): string {
  return COLORS.find((c) => c.id === id)?.label ?? String(id)
}

/** Shift `hex` by `dh` degrees in hue and `dl` in lightness (both
 *  in HSL, saturation preserved). Used by the per-color adjustment
 *  sliders to nudge a preset colour within its own family. */
export function applyHslDelta(hex: number, dh: number, dl: number): number {
  const r = ((hex >> 16) & 0xff) / 255
  const g = ((hex >> 8) & 0xff) / 255
  const b = (hex & 0xff) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  let h = 0
  let s = 0
  const l = (max + min) / 2
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break
      case g: h = (b - r) / d + 2; break
      case b: h = (r - g) / d + 4; break
    }
    h /= 6
  }
  // Apply deltas (dh in degrees, dl as percentage points).
  const h2 = (h + dh / 360 + 1) % 1
  const l2 = Math.max(0, Math.min(1, l + dl / 100))
  // Back to RGB.
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  let r2 = l2
  let g2 = l2
  let b2 = l2
  if (s !== 0) {
    const q = l2 < 0.5 ? l2 * (1 + s) : l2 + s - l2 * s
    const p = 2 * l2 - q
    r2 = hue2rgb(p, q, h2 + 1 / 3)
    g2 = hue2rgb(p, q, h2)
    b2 = hue2rgb(p, q, h2 - 1 / 3)
  }
  const R = Math.round(r2 * 255) & 0xff
  const G = Math.round(g2 * 255) & 0xff
  const B = Math.round(b2 * 255) & 0xff
  return (R << 16) | (G << 8) | B
}

/* ─── Coating colours ────────────────────────────────── */

/** Palette of colours that a non-`none` coating (wax / foil / ice)
 *  can be tinted with. Deliberately narrower and more saturated than the
 *  slime base COLORS palette because coatings are metallic / lacquered /
 *  baked surfaces — the six options match the deep, saturated hues real
 *  metallic foil sheets come in (bright gold, cool silver, deep magenta,
 *  saturated mint-teal, ink black, rich cocoa). */
export type CoatingColorId =
  | 'gold'
  | 'silver'
  | 'purple'
  | 'mint'
  | 'ink'
  | 'cocoa'

export const COATING_COLORS: readonly {
  id: CoatingColorId
  label: string
  hex: number
}[] = [
  { id: 'gold', label: '금색', hex: 0xd4a017 },
  { id: 'silver', label: '은색', hex: 0xb5bbc4 },
  { id: 'purple', label: '자주색', hex: 0x8b2c5e },
  { id: 'mint', label: '민트색', hex: 0x2ec498 },
  { id: 'ink', label: '먹색', hex: 0x1c1c24 },
  { id: 'cocoa', label: '코코아', hex: 0x6b3e2e }
]

/* ─── Materials ──────────────────────────────────────── */

/** Base slime look — the "inner" property. Controls how the slime body
 *  refracts light and how shiny/rough its bulk is. Combined at render time
 *  with a coating (wax / none) which layers an outer decorative surface. */
export type MaterialId = 'crystal' | 'glossy' | 'matte' | 'metal'

export interface MaterialParams {
  roughness: number
  metalness: number
  transmission: number
  thickness: number
  ior: number
  sheen: number
  sheenRoughness: number
  sheenColorHex: number
  iridescence: number
}

export const MATERIALS: readonly {
  id: MaterialId
  label: string
  params: MaterialParams
}[] = [
  {
    id: 'crystal',
    label: '크리스탈',
    params: {
      roughness: 0.05,
      metalness: 0,
      transmission: 0.95,
      thickness: 0.4,
      ior: 1.5,
      sheen: 0,
      sheenRoughness: 0.5,
      sheenColorHex: 0xffffff,
      iridescence: 0
    }
  },
  {
    id: 'glossy',
    label: '광택',
    params: {
      roughness: 0.18,
      metalness: 0,
      transmission: 0.35,
      thickness: 1.2,
      ior: 1.35,
      sheen: 0.4,
      sheenRoughness: 0.4,
      sheenColorHex: 0xffe0ee,
      iridescence: 0
    }
  },
  {
    id: 'matte',
    label: '폼',
    params: {
      roughness: 0.85,
      metalness: 0,
      transmission: 0,
      thickness: 0,
      ior: 1.4,
      sheen: 0,
      sheenRoughness: 0.5,
      sheenColorHex: 0xffffff,
      iridescence: 0
    }
  },
  {
    id: 'metal',
    label: '퍼티',
    params: {
      roughness: 0.28,
      metalness: 0.9,
      transmission: 0,
      thickness: 0,
      ior: 2.0,
      sheen: 0,
      sheenRoughness: 0.5,
      sheenColorHex: 0xffffff,
      iridescence: 0
    }
  }
]

/* ─── Coatings ───────────────────────────────────────── */

/** Outer surface treatment layered on top of the material. Three real
 *  coatings — wax (soft candle-like sheen tint of the coating colour, no
 *  cracks), foil (metallic sheet that tears under stress), ice (rigid
 *  frozen shell that shatters into plates on press with cracks revealing
 *  the slime interior) — plus `none` for a plain material. Non-`none`
 *  coatings pick their surface tint from a separately-selected
 *  `coatingColor`, so users can independently pick e.g. red wax, blue
 *  foil, or clear ice. */
export type CoatingId = 'none' | 'wax' | 'foil' | 'ice' | 'tube'

export interface CoatingParams {
  clearcoat: number
  clearcoatRoughness: number
  /** Additive metalness boost — foil pushes the surface into metallic
   *  territory regardless of the base material's metalness. */
  extraMetalness?: number
  /** Additive roughness — ice / wax push roughness up so the surface
   *  reads as a matte / soft shell rather than glossy anything. */
  extraRoughness?: number
  extraSheen?: number
  extraSheenRoughness?: number
  extraIridescence?: number
  /** When true, the coating's sheen tint comes from the user-picked
   *  `coatingColor` state rather than a fixed hex. All three real coatings
   *  use this so wax / foil / ice can be any colour. */
  usesUserColor?: boolean
  /** Enables the wax-crack shader on the slime — kneading damage draws
   *  spreading cracks under this coating (wax) or wrinkles / tears (foil). */
  hasCracks?: boolean
  /** When true, force the base material into a fully opaque matte state
   *  (no transmission, no metalness, no sheen, no iridescence, high
   *  roughness) so the coating tint reads with the same soft-pale colour
   *  feel as the standalone 'matte' material option. Without this, a
   *  transparent base like 'crystal' would leak through and wash the
   *  coating colour out. */
  forceMatteBase?: boolean
  /** When true, force the base material into a glassy CRYSTAL state
   *  (high transmission + thickness + low roughness) regardless of what
   *  the user picked for the base material. Used by the ice coating so
   *  the shell always reads as a transparent frozen crystal rather than
   *  a matte crust — the coating colour tints the crystal like stained
   *  glass instead of painting it opaque. */
  forceCrystalBase?: boolean
  /** When true, only force TRANSMISSION off (no other property
   *  changes) so a transparent-base coating like foil-on-crystal
   *  can't leak through crack reveals, while still keeping the
   *  metalness / roughness / sheen extras the coating adds on top. */
  forceOpaqueBase?: boolean
}

export const COATINGS: readonly {
  id: CoatingId
  label: string
  params: CoatingParams
}[] = [
  {
    id: 'none',
    label: '없음',
    params: {
      clearcoat: 0,
      clearcoatRoughness: 0
    }
  },
  {
    id: 'wax',
    label: '왁스',
    params: {
      // Solid candle-wax coating — fully matte crust with the same
      // colour feel as the 'matte' material option (forceMatteBase
      // overrides any transparency/gloss the underlying base material
      // contributes, so a crystal slime + wax coating still reads as
      // opaque matte wax). Kneading tears the crust open along
      // damage-accumulated seams (same shader path as foil), only
      // slower and with slightly thicker fragments — cracks widen
      // continuously with sustained pressure rather than snapping
      // into discrete shatter stages.
      clearcoat: 0,
      clearcoatRoughness: 0,
      usesUserColor: true,
      hasCracks: true,
      forceMatteBase: true
    }
  },
  {
    id: 'foil',
    label: '박지',
    params: {
      // Glossy metal coating — high metalness tints reflections with
      // the coating colour (F0 = colour for metals), low base roughness
      // + mirror-smooth clearcoat lacquer keeps those reflections
      // crisp so the sheet reads as polished / mirror-finish metal.
      // No iridescence — the coating colour carries the whole look.
      // Cracks reused as tears since foil deforms the same way under
      // kneading.
      // forceOpaqueBase (not Matte) so the transparency of a
      // crystal-base slime under foil doesn't leak through crack
      // reveals, while the extraMetalness below still makes the
      // outside read as polished metal. Using forceMatteBase would
      // have zeroed the metalness we just added, killing the metal
      // look entirely.
      clearcoat: 1.0,
      clearcoatRoughness: 0.02,
      extraMetalness: 0.85,
      usesUserColor: true,
      hasCracks: true,
      forceOpaqueBase: true
    }
  },
  {
    id: 'tube',
    label: '튜브',
    params: {
      // Glossy paper tube — matte paper body via forceMatteBase (opaque
      // pigment carries the coating colour) + mirror-smooth clearcoat
      // lacquer on top for the wet "shiny paper" look. Tears exactly
      // like foil does (reuses foil's damage shader path via
      // damageIsFoilUniform in SlimeSphere.setCoating), so kneading
      // opens the same wispy-edged rips as foil — just without the
      // metallic reflection.
      clearcoat: 1.0,
      clearcoatRoughness: 0.02,
      usesUserColor: true,
      hasCracks: true,
      forceMatteBase: true
    }
  },
  {
    id: 'ice',
    label: '카라멜',
    params: {
      // Transparent ice crystal shell — forceCrystalBase turns the base
      // into a glassy transmissive material (95% transmission, low
      // roughness, ior 1.5) so the coating colour tints it like stained
      // glass rather than painting it opaque. A high-clarity clearcoat
      // on top adds the wet-ice specular. Kneading shatters the shell
      // into a connected polygonal crack network revealing the slime
      // interior between fixed-size pieces.
      clearcoat: 1.0,
      clearcoatRoughness: 0.05,
      usesUserColor: true,
      hasCracks: true,
      forceCrystalBase: true
    }
  }
]

/* ─── Shapes ─────────────────────────────────────────── */

export type ShapeId = 'sphere' | 'cube' | 'twist'

export const SHAPES: readonly { id: ShapeId; label: string }[] = [
  { id: 'sphere', label: '구' },
  { id: 'cube', label: '네모' },
  { id: 'twist', label: '트위스트' }
]

/** Given a unit direction from origin on the base sphere, return the
 *  rest position (still normalised so the caller can scale by radius).
 *  Sphere passes through, cube pushes outward until the max component
 *  hits ±1, twist reshapes into a fluted soft-serve column with a
 *  helical rotation from bottom to top. */
export function shapeTransform(
  shape: ShapeId,
  nx: number,
  ny: number,
  nz: number
): [number, number, number] {
  switch (shape) {
    case 'sphere':
      return [nx, ny, nz]
    case 'cube': {
      const absMax = Math.max(
        Math.abs(nx),
        Math.abs(ny),
        Math.abs(nz)
      )
      if (absMax < 1e-6) return [nx, ny, nz]
      const s = 1 / absMax
      return [nx * s, ny * s, nz * s]
    }
    case 'twist': {
      // Piped whipped-cream dome — a nearly spherical body with a
      // tight ring of ridges that spiral from the base to a soft
      // peak on top, matching the "piping-tip cream rosette" look:
      // dense grooves running around the circumference and
      // spiralling upward once so the ridges tilt slightly as they
      // stack.
      const yStretch = 1.05
      const y = ny * yStretch
      const rxz = Math.sqrt(nx * nx + nz * nz)
      const yNorm = (y + yStretch) / (2 * yStretch)
      // Nearly full radius at the equator; the top narrows more
      // than the bottom so the silhouette reads as a piped mound
      // rather than a symmetric sphere.
      const equatorDist = Math.abs(yNorm - 0.45)
      const taper = 1 - Math.pow(equatorDist, 1.6) * 0.6
      const theta0 = Math.atan2(nz, nx)
      // ~1.4 turns end-to-end — gives the helix its visible spiral
      // without spinning the ridges too fast (which would blur them).
      const twistTurns = 1.4
      const theta = theta0 + yNorm * twistTurns * Math.PI * 2
      // 8 tight vertical ridges, higher amplitude → strong flutes.
      const flute = 1 + 0.11 * Math.cos(8 * theta)
      const rFinal = rxz * taper * flute
      return [rFinal * Math.cos(theta), y, rFinal * Math.sin(theta)]
    }
  }
}

/* ─── Beads ──────────────────────────────────────────── */

// Beads reuse the slime's COLORS palette (see Colors section
// above) so slime and bead pickers share one set of swatches.
// Kept these aliases so downstream code that references
// BeadColorId / BEAD_COLORS keeps compiling.
export type BeadColorId = ColorId
export const BEAD_COLORS = COLORS

/** 3D volumetric bead shape. Every bead in a layer shares the same shape. */
export type BeadShapeId = 'sphere' | 'cube' | 'torus' | 'star' | 'heart' | 'disc'

export const BEAD_SHAPES: readonly { id: BeadShapeId; label: string }[] = [
  { id: 'sphere', label: '구' },
  { id: 'cube', label: '큐브' },
  { id: 'torus', label: '도넛' },
  { id: 'star', label: '별' },
  { id: 'heart', label: '하트' },
  // 'disc' = 납작원기둥. Flat cylinder — its outward face is a full disc
  // so orthographic photo projection reads cleanly even at compact bead
  // sizes where a sphere's curved cap would collapse into a single pixel.
  { id: 'disc', label: '원반' }
]

/** Material style applied uniformly to every bead in the layer. */
export type BeadMaterialId = 'plastic' | 'crystal'

export const BEAD_MATERIALS: readonly {
  id: BeadMaterialId
  label: string
}[] = [
  { id: 'plastic', label: '플라스틱' },
  { id: 'crystal', label: '크리스탈' }
]

/** MeshPhysicalMaterial parameter presets per bead material. */
export interface BeadMaterialParams {
  roughness: number
  metalness: number
  clearcoat: number
  clearcoatRoughness: number
  transmission: number
  thickness: number
  ior: number
  sheen: number
  sheenRoughness: number
  iridescence: number
  iridescenceIOR: number
  envMapIntensity: number
}

export const BEAD_MATERIAL_PARAMS: Record<BeadMaterialId, BeadMaterialParams> = {
  // Classic plastic candy bead — glossy with strong clearcoat.
  plastic: {
    roughness: 0.12,
    metalness: 0.05,
    clearcoat: 1.0,
    clearcoatRoughness: 0.05,
    transmission: 0.0,
    thickness: 0.0,
    ior: 1.5,
    sheen: 0.25,
    sheenRoughness: 0.5,
    iridescence: 0.0,
    iridescenceIOR: 1.3,
    envMapIntensity: 1.3
  },
  crystal: {
    roughness: 0.02,
    metalness: 0.0,
    clearcoat: 1.0,
    clearcoatRoughness: 0.02,
    transmission: 0.95,
    thickness: 0.35,
    ior: 1.55,
    sheen: 0.0,
    sheenRoughness: 0.5,
    iridescence: 0.0,
    iridescenceIOR: 1.3,
    envMapIntensity: 1.2
  }
}

/** Bead layout combo. User picks one of these first, then adjusts sub-
 *  options within it — each combo bakes in a distinct rendering flavour:
 *    'none'    → beads disabled entirely (default). No sub-options.
 *    'compact' → small beads packed everywhere (default size 0.13, fill).
 *                No slime taffy bulge; count is ignored.
 *    'chunk'   → a few big beads sunk into the slime with taffy bulge
 *                (default size 0.44). Min 2 beads; max shrinks as size
 *                grows via beadChunkMaxCount(size). */
export type BeadCombo = 'none' | 'compact' | 'chunk'

export interface BeadsConfig {
  /** Which top-level layout preset this config belongs to — controls
   *  panel sub-options AND slime taffy activation in SlimeApp. */
  combo: BeadCombo
  colors: BeadColorId[]
  size: number // radius in local space
  count: number
  /** Multiple shapes render together — the total count is split evenly
   *  across each selected shape and beads are INTERLEAVED (index i goes to
   *  shapes[i % shapes.length]) so the mix is spread over the whole slime
   *  instead of clustered per hemisphere. Empty array = no beads rendered
   *  (an active bead layer needs at least one shape). */
  shapes: BeadShapeId[]
  material: BeadMaterialId
  /** Outer surface treatment layered on top of the bead material —
   *  identical option list to the slime's coating (none / wax / foil /
   *  ice-labelled-카라멜 / tube). Only the chunk combo exposes this in
   *  the panel; other combos leave it at 'none'. Applied to the shared
   *  bead MeshPhysicalMaterial in BeadsLayer.setConfig on top of the
   *  base material params. */
  coating: CoatingId
  /** When true, ignore `count` and pack beads as densely as possible across
   *  the whole surface — beads touch each other and hide most of the slime.
   *  Compact combo pins this to true; chunk combo pins it to false. */
  fill: boolean
  /** Compact-combo colour blend mode. `false` (default) = discrete
   *  N-band split (반반 나눠진 컬러 구성) — each bead picks the ONE palette
   *  colour whose Y-band it falls into. `true` = smooth gradient — each
   *  bead lerps between adjacent palette colours based on its Y position,
   *  producing a continuous top-to-bottom fade instead of hard bands. */
  gradient?: boolean
}

/** Combo defaults + slider limits. Compact allows small beads packed
 *  densely; chunk allows a few big beads and lets size grow past the
 *  compact ceiling. Panel reads the per-combo min/max so the size slider
 *  reflects the combo's intended range without a global override. */
export const BEAD_COMBOS: readonly {
  id: BeadCombo
  label: string
  defaults: Pick<BeadsConfig, 'size' | 'count' | 'fill'>
  sizeMin: number
  sizeMax: number
}[] = [
  {
    // Default entry — beads off entirely. Clicking this tile applies
    // fill=false + count=0 so BeadsLayer stops rendering; sizeMin/Max
    // are irrelevant (panel skips the size/count sub-cats for 'none').
    id: 'none',
    label: '미선택',
    defaults: { size: 0.13, count: 0, fill: false },
    sizeMin: 0.02,
    sizeMax: 0.3
  },
  {
    id: 'compact',
    label: '미니 꽉 채우기',
    // Default `fill: true` — 비즈 category always fills the whole
    // slime surface immediately on activation. The 양 sub-cat is
    // gone (no per-count control), so the surface is either fully
    // packed or off entirely.
    defaults: { size: 0.13, count: 0, fill: true },
    // 0.04 matches the sphere-shape floor so a sphere-only compact
    // layer can shrink all the way to 0.04 (was locked to 0.06 by
    // the combo's own min). Cube-shape mix still pushes the
    // effective min back up to 0.12 via beadShapesMinSize.
    sizeMin: 0.04,
    sizeMax: 0.3
  },
  {
    id: 'chunk',
    label: '속비즈',
    defaults: { size: 0.46, count: 2, fill: false },
    sizeMin: 0.3,
    sizeMax: 0.46
  }
]

/** Chunk combo max-count curve. Coefficient bumped from 12 → 50 so
 *  the smallest chunk size (~0.22) allows ~40 beads and the largest
 *  (~0.46) still allows ~9 — previously the cap topped out around
 *  9 at min size and 2 at max, which felt tight. */
export function beadChunkMaxCount(size: number): number {
  const raw = Math.floor(50 * (0.2 / size) * (0.2 / size))
  return Math.max(1, Math.min(200, raw))
}

/** Per-shape MIN size floor. Cubes need to be big enough for the
 *  rounded-corner radius (0.25 in local units) to read as pillowed
 *  rather than a shrunken block; spheres look fine at very small
 *  sizes. Other decorative shapes stay at the default sphere min
 *  since they're not visually compromised at low scale. */
const BEAD_SHAPE_MIN_SIZE: Record<BeadShapeId, number> = {
  sphere: 0.04,
  cube: 0.12,
  torus: 0.04,
  star: 0.04,
  heart: 0.04,
  // Disc's flat top is meant to hold a photo — floors match sphere so
  // compact mini-discs can still shrink under the size slider without
  // the shape's rounded edge becoming disproportionate.
  disc: 0.04
}

/** Given the currently selected bead shapes (multi-select), return the
 *  strictest MIN size any of them requires. Mixed cube + sphere
 *  therefore uses the cube's 0.12 floor since it's the harder
 *  constraint. Empty list falls back to the generic min. */
export function beadShapesMinSize(shapes: readonly BeadShapeId[]): number {
  if (shapes.length === 0) return 0.04
  let m = 0
  for (const s of shapes) {
    const v = BEAD_SHAPE_MIN_SIZE[s] ?? 0.04
    if (v > m) m = v
  }
  return m
}

/** Per-shape MAX size ceiling. Cube beads read cleanly at larger
 *  sizes than round shapes (their flat faces tile a cube slime face
 *  without leaving big pockets between beads), so their ceiling
 *  extends past the global 0.3. Other shapes stay capped at 0.3
 *  where they still fit visually. */
const BEAD_SHAPE_MAX_SIZE: Record<BeadShapeId, number> = {
  sphere: 0.3,
  cube: 0.4,
  torus: 0.3,
  star: 0.3,
  heart: 0.3,
  disc: 0.3
}

/** Given the currently selected bead shapes, return the LOWEST max
 *  size across them — mixing cube (0.4) + sphere (0.3) drops the
 *  effective ceiling back to 0.3 so no shape is oversized. */
export function beadShapesMaxSize(shapes: readonly BeadShapeId[]): number {
  if (shapes.length === 0) return 0.3
  let m = Infinity
  for (const s of shapes) {
    const v = BEAD_SHAPE_MAX_SIZE[s] ?? 0.3
    if (v < m) m = v
  }
  return m
}

/** App-level default is the INACTIVE combo — no beads rendered until
 *  the user picks 'compact' or 'chunk' from the panel. */
export const BEADS_DEFAULT: BeadsConfig = {
  combo: 'none',
  colors: [],
  size: 0.13,
  count: 0,
  shapes: ['sphere'],
  material: 'plastic',
  coating: 'none',
  fill: false
}

export const BEADS_LIMITS = {
  sizeMin: 0.02,
  // Global ceiling — every bead shape (sphere, cube, torus, star,
  // heart) caps at 0.3 so bigger beads never crowd the slime or push
  // through the far surface.
  sizeMax: 0.3,
  countMin: 1,
  countMax: 200
}

/* ─── Sprinkles ──────────────────────────────────────── */

/** Sprinkles are flat, paper-thin decorations that scatter across the slime
 *  surface — glitter flakes, paper stars, sugar bits. Unlike beads they have
 *  negligible thickness and sit tangent to the surface, catching light on one
 *  face and blending into the surface below. */

export type SprinkleColorId =
  | 'gold'
  | 'silver'
  | 'rose'
  | 'pink'
  | 'sky'
  | 'lavender'
  | 'mint'
  | 'peach'
  | 'ruby'
  | 'holo'
  | 'white'
  | 'black'

export const SPRINKLE_COLORS: readonly {
  id: SprinkleColorId
  label: string
  hex: number
}[] = [
  { id: 'gold', label: '골드', hex: 0xffcf5e },
  { id: 'silver', label: '실버', hex: 0xdde3ea },
  { id: 'rose', label: '로즈골드', hex: 0xffb197 },
  { id: 'pink', label: '핑크', hex: 0xff9ac9 },
  { id: 'sky', label: '하늘', hex: 0x8fc7ff },
  { id: 'lavender', label: '라벤더', hex: 0xc5a5f2 },
  { id: 'mint', label: '민트', hex: 0x8fe8c4 },
  { id: 'peach', label: '피치', hex: 0xffb591 },
  { id: 'ruby', label: '루비', hex: 0xf24d6b },
  { id: 'holo', label: '홀로', hex: 0xf4f6ff },
  { id: 'white', label: '화이트', hex: 0xfff8f4 },
  { id: 'black', label: '블랙', hex: 0x2a2a35 }
]

export type SprinkleShapeId = 'dot' | 'star' | 'heart' | 'bar' | 'diamond'

export const SPRINKLE_SHAPES: readonly {
  id: SprinkleShapeId
  label: string
}[] = [
  { id: 'dot', label: '점' },
  { id: 'star', label: '별' },
  { id: 'heart', label: '하트' },
  { id: 'bar', label: '막대' },
  { id: 'diamond', label: '다이아' }
]

export type SprinkleMaterialId =
  | 'paper'
  | 'glitter'
  | 'holo'
  | 'chalk'
  | 'crystal'

export const SPRINKLE_MATERIALS: readonly {
  id: SprinkleMaterialId
  label: string
}[] = [
  { id: 'paper', label: '무광' },
  { id: 'glitter', label: '반짝이' },
  { id: 'holo', label: '홀로그램' },
  { id: 'chalk', label: '분필' },
  { id: 'crystal', label: '크리스탈' }
]

/** Sprinkle "kind" — the top-level choice under the sprinkle panel. Each
 *  type owns a different set of tunable sub-options:
 *    paper  → flat confetti (color / count / size / shape / material)
 *    powder → small particles (color / count / material: 반짝이 or 분필)
 *    ink    → in-slime marble swirls (color / count)
 *  Ink is rendered inside the slime shader, not as surface sprinkles. */
export type SprinkleTypeId = 'paper' | 'powder' | 'ink'

export const SPRINKLE_TYPES: readonly {
  id: SprinkleTypeId
  label: string
}[] = [
  { id: 'paper', label: '납작종이' },
  { id: 'powder', label: '가루' },
  { id: 'ink', label: '잉크' }
]

/** Sub-categories surfaced in the panel for each type. Empty entries let
 *  us hide options that don't apply (e.g. ink has no size/shape/material). */
export const SPRINKLE_SUB_CATEGORIES: Record<
  SprinkleTypeId,
  readonly { id: string; label: string }[]
> = {
  paper: [
    { id: 'count', label: '양' },
    { id: 'color', label: '색상' },
    { id: 'size', label: '크기' },
    { id: 'shape', label: '모양' },
    { id: 'material', label: '재질' }
  ],
  powder: [
    { id: 'count', label: '양' },
    { id: 'color', label: '색상' },
    { id: 'material', label: '재질' }
  ],
  ink: [
    { id: 'count', label: '양' },
    { id: 'color', label: '색상' }
  ]
}

/** Which SprinkleMaterialId values are valid per sprinkle type. Used to
 *  filter the material chip list so users only see options that make
 *  sense for the type they're customising. */
export const SPRINKLE_MATERIALS_BY_TYPE: Record<
  SprinkleTypeId,
  readonly SprinkleMaterialId[]
> = {
  paper: ['paper', 'glitter', 'crystal'],
  powder: ['glitter', 'chalk'],
  ink: []
}

export interface SprinkleMaterialParams {
  roughness: number
  metalness: number
  clearcoat: number
  clearcoatRoughness: number
  sheen: number
  sheenRoughness: number
  iridescence: number
  iridescenceIOR: number
  envMapIntensity: number
  /** Optional physical transmission — non-zero makes the sprinkle
   *  material translucent (see-through), used by the crystal preset. */
  transmission?: number
  thickness?: number
  ior?: number
}

export const SPRINKLE_MATERIAL_PARAMS: Record<
  SprinkleMaterialId,
  SprinkleMaterialParams
> = {
  // Flat paper — matte, no reflection, catches ambient light softly.
  paper: {
    roughness: 0.95,
    metalness: 0.0,
    clearcoat: 0.0,
    clearcoatRoughness: 0.0,
    sheen: 0.5,
    sheenRoughness: 0.9,
    iridescence: 0.0,
    iridescenceIOR: 1.3,
    envMapIntensity: 0.4
  },
  // Foil / metallic glitter — high metalness, low roughness so it sparkles.
  glitter: {
    roughness: 0.18,
    metalness: 0.9,
    clearcoat: 1.0,
    clearcoatRoughness: 0.1,
    sheen: 0.0,
    sheenRoughness: 0.5,
    iridescence: 0.2,
    iridescenceIOR: 1.3,
    envMapIntensity: 1.8
  },
  // Holographic — strong iridescence + clearcoat for the rainbow shimmer.
  holo: {
    roughness: 0.28,
    metalness: 0.5,
    clearcoat: 1.0,
    clearcoatRoughness: 0.08,
    sheen: 0.0,
    sheenRoughness: 0.5,
    iridescence: 1.0,
    iridescenceIOR: 1.5,
    envMapIntensity: 1.6
  },
  // Chalk / powder — bone-dry matte look: high roughness, no clearcoat,
  // very light sheen just enough to catch ambient light like chalk dust.
  chalk: {
    roughness: 0.98,
    metalness: 0,
    clearcoat: 0,
    clearcoatRoughness: 0,
    sheen: 0.3,
    sheenRoughness: 0.95,
    iridescence: 0,
    iridescenceIOR: 1.3,
    envMapIntensity: 0.25
  },
  // Crystal — clear glass gem: high physical transmission so the
  // sprinkle reads as TRUE glass (slime shows through the chip).
  // Mirror clearcoat on top adds crisp specular highlights so the
  // sprinkle still catches the eye instead of vanishing into the
  // slime it's floating on.
  crystal: {
    roughness: 0.04,
    metalness: 0,
    clearcoat: 1.0,
    clearcoatRoughness: 0.02,
    sheen: 0,
    sheenRoughness: 0.5,
    iridescence: 0.1,
    iridescenceIOR: 1.4,
    envMapIntensity: 1.3,
    transmission: 0.92,
    thickness: 0.3,
    ior: 1.5
  }
}

/** Per-type sprinkle settings. Each type lives in its own slot inside
 *  SprinklesConfig so paper / powder / ink can all be simultaneously
 *  active with independent colour palettes, counts, and (for paper) shape
 *  and size. count === 0 is the "inactive" state: layers/shaders skip
 *  rendering entirely for that type. */
export interface PaperSprinklesConfig {
  colors: SprinkleColorId[]
  size: number
  count: number
  shape: SprinkleShapeId
  material: SprinkleMaterialId
  fill: boolean
}

export interface PowderSprinklesConfig {
  colors: SprinkleColorId[]
  count: number
  material: SprinkleMaterialId
  /** When true, powder is packed as a UNIFORM Fibonacci scatter across
   *  the entire surface at max density — the "꽉 채우기" coating look. When
   *  false, the count slider drives a marble-ribbon distribution instead
   *  (grains concentrate along swirls, mirroring the ink pattern). */
  fill: boolean
}

export interface InkSprinklesConfig {
  colors: SprinkleColorId[]
  count: number
}

/** Composite sprinkles state — one bucket per type, all coexisting. Any
 *  combination can be active, so a user can layer e.g. paper confetti +
 *  glitter powder + coloured ink swirls together. Rendering order (bottom
 *  → top): ink is inside the slime shader, then paper sits above the
 *  beads, then powder tops paper. */
export interface SprinklesConfig {
  paper: PaperSprinklesConfig
  powder: PowderSprinklesConfig
  ink: InkSprinklesConfig
}

export const SPRINKLES_DEFAULT: SprinklesConfig = {
  paper: {
    colors: [],
    size: 0.035,
    count: 0,
    shape: 'star',
    material: 'glitter',
    fill: false
  },
  powder: {
    colors: [],
    count: 0,
    material: 'glitter',
    fill: false
  },
  ink: {
    colors: [],
    count: 0
  }
}

export const SPRINKLES_LIMITS = {
  sizeMin: 0.03,
  sizeMax: 0.08,
  countMin: 0,
  countMax: 400,
  /** Per-type slider maxes. Paper caps at 260 because visually adding more
   *  pieces past that produces no perceptible extra density. Powder keeps
   *  the original 400 range. Ink extends past 400 so users can push into
   *  a wider marble area — the shader's ink amount is normalised against
   *  the shared 400 divisor, letting the amount pass 1.0 for wider bands. */
  paperCountMax: 260,
  powderCountMax: 400,
  inkCountMax: 500,
  /** Powder's minimum active count — below ~85 grains the marble
   *  ribbon distribution is too sparse to read as a distinct powder
   *  layer, so the slider is floored here rather than at 0. */
  powderCountMin: 85,
  /** Divisor used to normalise ink count into the shader's uInkAmount.
   *  Kept fixed at 400 so pushing the slider past 400 produces
   *  amount > 1.0 (progressively wider ink area). */
  inkAmountDivisor: 400
}

/* ─── Themes ─────────────────────────────────────────── */

/** Designer-curated preset that configures the whole slime — colour, coating,
 *  shape, beads, and sprinkles — around a specific vibe. Applying a theme
 *  overwrites the current customisation with the preset's values. */
export type ThemeId =
  | 'deepsea'
  | 'space'
  | 'jungle'
  | 'christmas'
  | 'spring'
  | 'summer'
  | 'autumn'
  | 'winter'
  | 'safari'
  | 'farm'
  | 'panda'
  | 'unicorn'
  | 'valentine'
  | 'halloween'
  | 'birthday'
  | 'dessert'
  | 'fruit'
  | 'tropical'
  | 'newyear'
  | 'magic'

/** A theme is just a NAMED PALETTE of emoji characters. Selecting a theme
 *  in the panel exposes that palette so the user can pick which specific
 *  emojis to add to the slime as emoji beads — themes no longer overwrite
 *  the slime's colour / material / coating / beads. */
export interface ThemePreset {
  id: ThemeId
  label: string
  emojis: string[]
}

/** State of the emoji-beads sprinkle layer. Themes populate the palette
 *  (via `themeId`), the user then toggles which emojis they want in
 *  `emojis`, and the emoji beads render at `size` and `count`. When
 *  `emojis` is empty or `count` is 0, the layer stays inactive. */
export interface EmojiBeadsConfig {
  themeId: ThemeId | null
  emojis: string[]
  size: number
  count: number
}

export const EMOJI_BEADS_DEFAULT: EmojiBeadsConfig = {
  themeId: null,
  emojis: [],
  size: 0.3,
  count: 0
}

export const EMOJI_BEADS_LIMITS = {
  sizeMin: 0.25,
  sizeMax: 0.5,
  countMin: 0,
  countMax: 20
}

/** 커스텀비즈: 이모지처럼 몇 개만 슬라임에 얹혀 강조 역할을 하는
 *  컬러 3D 비즈. 미니비즈와 달리 전체 면을 덮지 않고, 사용자가 지정한
 *  color / count / size / shape 조합으로 낱개가 붙는다. 배치·이동은
 *  이모지 시스템의 물리를 재사용. `flatness` 0..1 슬라이더로 각 비즈의
 *  outward 축을 압축해 코인/디스크 느낌으로 만들 수 있다. */
export interface CustomBeadsConfig {
  colors: BeadColorId[]
  shapes: BeadShapeId[]
  size: number
  count: number
  /** 0 = 원래 비율 그대로, 1 = 완전히 납작한 원반. 로컬 +Z (outward
   *  방향)에 대한 스케일 배수 = mix(1.0, 0.15, flatness). */
  flatness: number
}

export const CUSTOM_BEADS_DEFAULT: CustomBeadsConfig = {
  colors: [],
  // Custom beads never render as a plain sphere — sphere shape was
  // removed from the panel because it collapses the photo decal into
  // a tiny cap. Default to disc so accent beads read as flat coins
  // out of the box.
  shapes: ['disc'],
  size: 0.28,
  count: 0,
  flatness: 0
}

export const CUSTOM_BEADS_LIMITS = {
  sizeMin: 0.15,
  sizeMax: 0.45,
  countMin: 0,
  countMax: 20
}

export const THEMES: readonly ThemePreset[] = [
  {
    id: 'deepsea',
    label: '심해',
    emojis: ['🐙', '🐢', '🐠', '🐡', '🦀', '⭐', '🐚', '🪼', '🪸', '🦑']
  },
  {
    id: 'space',
    label: '우주',
    emojis: ['🚀', '🛸', '🪐', '⭐', '🌙', '✨', '☄️', '🌠', '🌏']
  },
  {
    id: 'jungle',
    label: '정글',
    emojis: ['🐒', '🦁', '🐘', '🐅', '🦒', '🦜', '🌴', '🍌', '🐍']
  },
  {
    id: 'christmas',
    label: '크리스마스',
    emojis: ['🎄', '🎅', '🦌', '🎁', '⛄', '❄️', '🔔', '🎀', '🕯️']
  },
  {
    id: 'spring',
    label: '봄',
    emojis: ['🌸', '🌷', '🌼', '🐝', '🦋', '🌱', '🐰', '🐣']
  },
  {
    id: 'summer',
    label: '여름',
    emojis: ['🍉', '🌻', '🍦', '🏖️', '⛱️', '🌞', '🩴', '🍹', '🐚']
  },
  {
    id: 'autumn',
    label: '가을',
    emojis: ['🍁', '🍂', '🌰', '🎃', '🌾', '🐿️', '🍄', '🍎']
  },
  {
    id: 'winter',
    label: '겨울',
    emojis: ['⛄', '❄️', '🎿', '🧣', '🐧', '🏔️', '🌨️', '☃️']
  },
  {
    id: 'safari',
    label: '사파리',
    emojis: ['🦁', '🐘', '🦓', '🦒', '🦏', '🐆', '🐫', '🌵']
  },
  {
    id: 'farm',
    label: '목장',
    emojis: ['🐄', '🐖', '🐓', '🐑', '🐐', '🌾', '🚜', '🌽']
  },
  {
    id: 'panda',
    label: '판다',
    emojis: ['🐼', '🎋', '🌿', '🍃', '🐨', '🐢', '🌱']
  },
  {
    id: 'unicorn',
    label: '유니콘',
    emojis: ['🦄', '🌈', '✨', '💖', '🌸', '🍭', '🎀', '🌟', '🍬']
  },
  {
    id: 'valentine',
    label: '발렌타인',
    emojis: ['💖', '💝', '💕', '🌹', '🍫', '🎁', '💌', '❤️']
  },
  {
    id: 'halloween',
    label: '할로윈',
    emojis: ['🎃', '👻', '🦇', '🕷️', '🕸️', '🧙‍♀️', '💀', '🍬', '🕯️']
  },
  {
    id: 'birthday',
    label: '생일',
    emojis: ['🎂', '🎁', '🎈', '🎉', '🎊', '🍰', '🎀', '🥳']
  },
  {
    id: 'dessert',
    label: '디저트',
    emojis: ['🍰', '🧁', '🍮', '🍩', '🍪', '🍫', '🍦', '🍭', '🍯']
  },
  {
    id: 'fruit',
    label: '과일',
    emojis: ['🍓', '🍑', '🍒', '🍇', '🍉', '🥝', '🍍', '🥭', '🍏']
  },
  {
    id: 'tropical',
    label: '열대',
    emojis: ['🌺', '🌴', '🐦', '🦋', '🌈', '🥥', '🍹', '🍍']
  },
  {
    id: 'newyear',
    label: '새해',
    emojis: ['🎊', '🎇', '🍾', '🥂', '🧧', '🎆', '⏰', '🌟', '🎁']
  },
  {
    id: 'magic',
    label: '마법',
    emojis: ['🔮', '✨', '🌟', '💫', '🎆', '🪄', '🧚‍♀️', '🌌', '🌠']
  }
]

