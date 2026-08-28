import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import {
  BEAD_MATERIAL_PARAMS,
  MATERIALS,
  COATINGS,
  resolveColorHex,
  resolveInnerCoatingHex,
  type BeadColorId,
  type BeadMaterialId,
  type MaterialId,
  type BeadShapeId,
  type BeadsConfig,
  type CoatingId,
  type ColorAdjustments,
  type ShapeId
} from './presets'
import { type WeightedTip } from './SlimeSphere'

const MAX_BEADS = 10000

/**
 * A decorative layer of round beads that latch onto specific vertex indices,
 * so they follow the soft-body deformation each frame. Uses InstancedMesh for
 * one-draw-call rendering of up to `MAX_BEADS` beads.
 *
 * Two positioning strategies live in this class:
 *  - Normal mode: beads pinned to individual mesh vertices (max ~2562 beads
 *    for the icosphere-detail-4 slime). Each bead may sink a random depth
 *    into the surface so the layer reads as "mixed in".
 *  - Fill mode: beads sit on Fibonacci-sphere directions instead, so we can
 *    scale count with bead size and achieve real dense coverage even for
 *    tiny beads. Each fill bead borrows its radial magnitude from the
 *    nearest slime vertex so it still follows the mesh's deformation.
 *
 * Foam beads additionally squish along their outward axis when the
 * underlying vertex is being pressed inward, easing back to full size once
 * pressure lifts — the classic sponge bounce without per-bead physics.
 */
/** One rendering slot per bead shape — beads with the same shape share an
 *  InstancedMesh (and its wrap-shell counterpart). Beads assigned to this
 *  shape live at consecutive indices from 0 to count-1. Beads are
 *  DISTRIBUTED across slots by index modulo shapes.length in setConfig,
 *  which gives the interleaved / mixed appearance the user wanted (rather
 *  than clustering each shape in its own hemisphere). */
interface ShapeSlot {
  shape: BeadShapeId
  instanced: THREE.InstancedMesh
  wrapInstanced: THREE.InstancedMesh
  count: number
  /** Per-instance damage attribute on this slot's geometry — read by
   *  the bead crack shader to widen voronoi cracks with accumulated
   *  press damage. Same aDamage attribute name as slime's per-vertex
   *  damage; per-instance semantics because beads share one geometry. */
  damageAttr: THREE.InstancedBufferAttribute
  /** Per-instance crackLevel (0..5) — bumped on the rising edge of
   *  each press event for wax / ice coatings, drives layer-2 and
   *  layer-3 subdivisions in the crack fragment shader. */
  crackLevelAttr: THREE.InstancedBufferAttribute
  /** Per-instance press-origin direction in slime-local frame —
   *  used by the foil / tube crack branch to grow the tear as a
   *  cone expanding from where the finger first landed on the bead,
   *  rather than shredding the whole shell uniformly. */
  pressPointAttr: THREE.InstancedBufferAttribute
  /** Per-instance photo quadrant index (0-3) — which slot of the
   *  2×2 photo atlas this bead samples when 사진 비즈 is active.
   *  A value of -1 means "no photo assigned"; the fragment shader
   *  early-outs the photo mix in that case even when uBeadPhotoUse
   *  is on, so photo beads and plain beads can coexist within one
   *  layer (each instance decides independently). */
  photoQuadrantAttr: THREE.InstancedBufferAttribute
}

export class BeadsLayer {
  readonly group: THREE.Group
  private slots: ShapeSlot[] = []
  private beadMaterial: THREE.MeshPhysicalMaterial | null = null
  // Wrap mesh: a second InstancedMesh sharing the bead geometry but scaled
  // ~1.09× larger with a slime-matching material. Each frame we mirror the
  // bead matrix onto this mesh so every bead ends up with a translucent
  // "slime jacket" clinging to its shape. The wrap material's params are
  // synced from SlimeSphere.getSurfaceParams() whenever the slime changes,
  // so wrap colour / roughness / transmission etc. always match the slime
  // underneath — matte slime → matte opaque wrap that hides beads; crystal
  // slime → transparent wrap that reveals beads through the coating.
  private wrapMaterial: THREE.MeshPhysicalMaterial | null = null
  // Per-bead gradient — when 2+ colours are picked, each bead's fragment
  // shader samples this LUT keyed off WORLD Y (relative to the bead's
  // centre, normalised by its size), so every bead reads bottom-to-top
  // in the same world-vertical direction regardless of its orientation.
  // Sampling local Y instead put front-facing beads' gradient nearly
  // parallel to the camera → most of the visible face showed a single
  // colour. World Y keeps the palette fully visible on every bead.
  private readonly gradientUseUniform = { value: 0.0 }
  private readonly gradientTexUniform: { value: THREE.Texture | null } = {
    value: null
  }
  private readonly gradientSizeUniform = { value: 0.13 }
  private gradientTexture: THREE.DataTexture | null = null
  // Ink uniforms borrowed from SlimeSphere so the wrap shell paints the same
  // marble swirls on top of every bead. Held as refs (not copies) so one
  // slime.setInk() call updates both layers in lockstep with no re-emit.
  private inkColorUniform: { value: THREE.Color } | null = null
  /** Live ref to SlimeSphere.materialIsMatteUniform — set via
   *  setMatteFoamUniform so the wrap-shell can gate its foam pass on
   *  the exact same flag the slime shader uses. */
  private matteFoamUniform: { value: number } | null = null
  private inkAmountUniform: { value: number } | null = null
  // Slime gradient uniforms borrowed the same way — lets the wrap sample
  // the same top-to-bottom colour band the slime is painted with, so
  // compact-fill beads under a multi-colour slime still show every colour
  // instead of monotonously reading the slime's first (mat.color) hue.
  private slimeGradientUseUniform: { value: number } | null = null
  private slimeGradientTexUniform: { value: THREE.Texture | null } | null =
    null
  private slimeGradientRadiusUniform: { value: number } | null = null
  private readonly _wrapMatrix = new THREE.Matrix4()
  private readonly _wrapScale = new THREE.Vector3()
  // Latest slime params, cached so a wrap material created LATER (via
  // ensureInstanced on first setConfig) still picks them up on birth
  // without needing SlimeApp to re-emit the sync call.
  private slimeSurfaceCache: {
    color: THREE.Color
    roughness: number
    metalness: number
    transmission: number
    thickness: number
    ior: number
    sheen: number
    sheenRoughness: number
    sheenColor: THREE.Color
    iridescence: number
    iridescenceIOR: number
    clearcoat: number
    clearcoatRoughness: number
  } | null = null

  // Normal (vertex-anchored) mode state ─────────────────
  private vertexIndices: number[] = []
  private depthOffsets: Float32Array = new Float32Array(0)
  private restMagnitudes: Float32Array = new Float32Array(0)
  // Grid-mode layout (cube slime + cube bead + fill). Beads render at
  // FIXED positions on each cube face, oriented so their +Z faces the
  // face normal — not the usual outward-from-origin direction. This
  // gives the tight face-aligned "cube of cubes" look the user expects
  // for the cube-cube combo; every other slime/bead mix bypasses this
  // path entirely and uses the vertex / fibonacci flows.
  private gridMode = false
  private gridPositions: Float32Array = new Float32Array(0)
  /** For every grid bead, the mesh vertex nearest to its rest position
   *  and that vertex's REST world coordinates. Update adds
   *  (currentVertex − restVertex) to the fixed grid position so beads
   *  follow the slime's local deformation instead of sitting frozen
   *  when the surface underneath them is pressed. */
  private gridAnchorIdx: Uint32Array = new Uint32Array(0)
  private gridRestAnchor: Float32Array = new Float32Array(0)
  // Scratch space for bead-bead collision resolution. First pass fills
  // these with each bead's target position / normal / scale (from the
  // usual per-vertex logic); a relaxation pass then pushes overlapping
  // beads apart so kneading actually compresses them against each other
  // instead of letting them phase through. Reallocated only when N
  // changes so most frames pay zero heap cost.
  private colPos: Float32Array = new Float32Array(0)
  private colOut: Float32Array = new Float32Array(0)
  private colScale: Float32Array = new Float32Array(0)
  /** Max distance from origin allowed for each bead center — matches the
   *  "fully inside slime" clamp so collision can push beads around
   *  without popping them out of the surface. */
  private colMaxLen: Float32Array = new Float32Array(0)
  /** Chunk-combo per-bead tangential offset from anchor. Kicks fire
   *  ONLY when actual finger/pointer press is active this frame (via
   *  the `pressure` param on update); the offset decays back to zero
   *  when press stops, so beads settle instead of drifting off from
   *  idle physics jitter. */
  private beadSlipOffset: Float32Array = new Float32Array(0)
  /** Per-bead random tangent direction seed. Combined with a slow global
   *  time offset so a bead's slip path curves organically instead of
   *  being a straight line, and different beads slip different ways. */
  private beadSlipSeed: Float32Array = new Float32Array(0)

  // Fill (Fibonacci-anchored) mode state ────────────────
  private fillMode = false
  /** For each fill bead, 3 nearest slime vertex indices (n × 3). */
  private fillVertexIdx: Uint32Array = new Uint32Array(0)
  /** Barycentric-ish weights matching fillVertexIdx (n × 3). */
  private fillVertexWeight: Float32Array = new Float32Array(0)
  /** Original Fibonacci direction per bead (n × 3). Preserved verbatim so
   *  angular coverage doesn't warp toward whichever mesh vertex happens to be
   *  closest — the mesh only supplies radial magnitude, never direction. */
  private fillDirs: Float32Array = new Float32Array(0)
  /** Rest magnitude (interpolated across the 3 nearest vertices) per bead. */
  private fillRestMag: Float32Array = new Float32Array(0)

  private currentMaterialId: BeadMaterialId | MaterialId = 'plastic'
  private currentCoatingId: CoatingId = 'none'

  // Per-bead damage / crackLevel / press-edge tracking, indexed by
  // GLOBAL bead index (0..n-1). Update() distributes each bead's values
  // to its slot's per-instance attribute via the same
  // (i % slotCount, perSlotCursor) mapping used for matrices.
  private beadDamage: Float32Array = new Float32Array(0)
  /** Total press force landed on ANY bead in this layer during the
   *  most recent update() — read externally by SlimeApp so coating
   *  loop sounds can be gated on whether the user's tips actually
   *  touched a coated bead, not just any press on the outer slime. */
  private _pressForceThisFrame = 0
  get pressForceThisFrame(): number {
    return this._pressForceThisFrame
  }
  private beadCrackLevel: Float32Array = new Float32Array(0)
  private beadWasPressed: Uint8Array = new Uint8Array(0)
  // Per-bead press-origin direction (slime-local frame, unit vector),
  // 3 floats per bead. Snapped on the FIRST press event, LERPed on
  // subsequent presses so the foil tear origin follows sustained
  // finger movement without jumping around. Used only by foil / tube
  // cracks — wax / ice ignore it and shatter uniformly.
  private beadPressPoint: Float32Array = new Float32Array(0)
  // Per-bead squish factor in [0, SQUISH_MAX]. Grows when a coated
  // chunk bead is pressed and decays back to 0 when the press releases.
  // Applied as a volume-preserving scale — bead's local Z (aligned
  // outward after the bead's setFromUnitVectors rotation) compresses,
  // and X/Y expand by 1/√Z_scale so total volume stays the same. Only
  // coated chunk beads squish; uncoated / non-chunk beads keep the
  // rigid uniform scale.
  private beadSquish: Float32Array = new Float32Array(0)

  // Coating-state uniforms consumed by the bead crack shader. Kept as
  // three separate flags (not one enum) so the fragment shader can
  // branch on `if (uCoatingIsWax > 0.5)` mirroring the slime crack
  // shader convention. Foil and tube share the same tear model on
  // slime, so both flip uCoatingIsFoil.
  private readonly beadDamageEnabledUniform = { value: 0.0 }
  private readonly beadIsWaxUniform = { value: 0.0 }
  private readonly beadIsIceUniform = { value: 0.0 }
  private readonly beadIsFoilUniform = { value: 0.0 }
  /** 1 when the ball's coating is 젤 (tube). Same tear shader as foil
   *  but a glossy PAPER shell (no metal), so this extra flag lets the
   *  shell branches override foil's metallic override for tube. */
  private readonly beadIsTubeUniform = { value: 0.0 }
  /** 1 when the layer is in the 속비즈 preset (chunk combo, single bead
   *  at slime origin). Tells the foil/tube branch of the crack shader
   *  to drop the press-point cone gate so tears spread across the whole
   *  bead surface like the slime's own foil coating — a small
   *  fully-embedded bead would otherwise only rip in a narrow patch
   *  facing the last press, reading as wax-style angular cracks. */
  private readonly beadFoilFullSurfaceUniform = { value: 0.0 }
  /** Coating colour tint for the bead surface — independent from the per-
   *  instance bead colour so a green ball can wear a gold wax coating.
   *  `beadCoatingTintUniform` holds the RGB, `beadCoatingAlphaUniform`
   *  gates it (0 = no tint, coating renders as raw bead colour; 1 = tint
   *  fully paints the surface). The crack pass in the fragment shader
   *  snapshots the pre-tint diffuse so cracks reveal the ball's own bead
   *  colour underneath, matching the slime's coating-crack behaviour. */
  private readonly beadCoatingTintUniform = {
    value: new THREE.Color(1, 1, 1)
  }
  private readonly beadCoatingAlphaUniform = { value: 0.0 }
  /** 1 when the bead's material is the slime 'matte' preset, 0 otherwise.
   *  Enables the same procedural foam pattern the slime shader applies for
   *  matte material so a matte 슬라임볼 reads as aerated bath foam rather
   *  than a plain rough sphere. Only meaningful when useSlimeMaterials is
   *  true (regular bead layers can't pick 'matte'). */
  private readonly beadMaterialIsMatteUniform = { value: 0.0 }
  /** 슬라임볼 (single-centered buried ball) press-dent uniforms — mimic
   *  the outer slime's per-vertex indentation with a vertex-shader that
   *  pushes vertices inward inside a soft cone around each active dent.
   *  `uBallDentEnabled` gates the whole pass so multi-count 슬라임볼 (on
   *  surface) doesn't get dented. Each slot in `uBallDents` is a vec4
   *  (dir.xyz, strength): dir is a unit direction in bead-local frame
   *  (= slime-local for the buried ball since its instance rotation is
   *  identity), strength is 0..~0.35 indicating how much to push vertices
   *  inward as a fraction of bead radius. Persists across frames — the
   *  slime feels like clay, not spring. */
  private readonly ballDentEnabledUniform = { value: 0.0 }
  private readonly ballDentsUniform: { value: THREE.Vector4[] } = {
    value: (() => {
      const a: THREE.Vector4[] = []
      for (let i = 0; i < 8; i++) a.push(new THREE.Vector4(1, 0, 0, 0))
      return a
    })()
  }
  /** DECOUPLED bulge amount — separate from dent slot strengths so
   *  the ball's overall envelope can start expanding the moment ANY
   *  press touches the slime, without waiting for the touch-through
   *  filter (which delays dent accumulation until the slime surface
   *  physically reaches the ball). Without this, the outer slime
   *  bulged first and the buried ball read as "shrunk" relative to
   *  the growing slime silhouette until dents finally kicked in. */
  private readonly ballBulgeUniform = { value: 0.0 }
  // 사진 비즈 uniforms. `uBeadPhotoUse` gates the whole photo pass so
  // beads without a photo assigned early-out. The atlas is a 2×2 grid
  // (up to 4 photos, each in one quadrant) so a single sampler carries
  // every active photo without needing WebGL 2 sampler arrays. Each
  // instance picks its quadrant via aPhotoQuadrant (0..3, or -1 for
  // "no photo"). uBeadPhotoSlotCount is unused in the shader but kept
  // as a hook for future logic (e.g. randomising within slots).
  private readonly beadPhotoUseUniform = { value: 0.0 }
  private readonly beadPhotoAtlasUniform: {
    value: THREE.Texture | null
  } = { value: null }
  private beadPhotoAtlas: THREE.CanvasTexture | null = null
  /** Currently-applied photo textures (up to 4). Null entries are empty
   *  slots. Kept as state so setConfig can rebuild per-instance quadrant
   *  assignments when the bead count changes without SlimeApp having to
   *  re-push the photos. */
  private currentPhotos: (THREE.Texture | null)[] = [null, null, null, null]
  /** Per-colour HSL deltas applied to bead palette hexes via the
   *  adjustment sliders. Read by colorsToHex during setConfig / re-
   *  colour so nudging a colour ripples immediately without any
   *  external re-emit of the config. */
  private currentColorAdjustments: ColorAdjustments = {}
  /** Cached inputs to the last color-assignment pass, used by
   *  setColorAdjustments to re-run just the colour loop without
   *  rebuilding instance matrices / geometry. */
  private lastUnitDirs: Float32Array = new Float32Array(0)
  private lastEffectiveCount = 0

  private config: BeadsConfig = {
    combo: 'none',
    colors: [],
    size: 0.13,
    count: 0,
    shapes: ['sphere'],
    material: 'plastic',
    coating: 'none',
    fill: false
  }

  private readonly _matrix = new THREE.Matrix4()
  private readonly _pos = new THREE.Vector3()
  private readonly _scale = new THREE.Vector3()
  private readonly _quat = new THREE.Quaternion()
  // Local axis aligned with outward. Uses +Z so flat shapes (torus,
  // star, heart) whose extrude/hole axis is Z lie FLAT on the slime
  // surface — otherwise a torus stood on its side and only half of it
  // poked out of the slime. Sphere and cube are rotationally symmetric
  // enough that the choice doesn't matter for them.
  private readonly _forward = new THREE.Vector3(0, 0, 1)
  private readonly _outward = new THREE.Vector3()
  private readonly _color = new THREE.Color()

  /** When true, single chunk beads sit at the slime SURFACE (like any
   *  other chunk bead) instead of collapsing to the slime's origin.
   *  Used by the inner-slime layer so its single-ball preset bulges the
   *  outer slime instead of vanishing inside its own volume. */
  private readonly alwaysSurface: boolean
  /** When true, this layer's `config.material` id is resolved against the
   *  slime MATERIALS palette (crystal / glossy / matte / metal) instead of
   *  the bead-specific BEAD_MATERIAL_PARAMS table. Used by the 슬라임볼
   *  (innerSlime) layer so its material picker matches the slime's own. */
  private readonly useSlimeMaterials: boolean

  constructor(opts?: {
    alwaysSurface?: boolean
    useSlimeMaterials?: boolean
  }) {
    this.group = new THREE.Group()
    this.alwaysSurface = opts?.alwaysSurface ?? false
    this.useSlimeMaterials = opts?.useSlimeMaterials ?? false
  }

  get currentConfig(): Readonly<BeadsConfig> {
    return this.config
  }

  /** Compute a "nearest bead direction" (unit vector) for every slime
   *  vertex, packed vertexCount × 3. SlimeSphere.setBeadInfluence uses
   *  this to stretch each vertex outward toward its nearest bead so the
   *  slime surface taffy-pulls up over every bead instead of getting
   *  cleanly pierced by the bead sphere. Direction is the bead's REST
   *  unit direction — stable under physics deformation because both
   *  slime and beads deform together. Returns null when no beads active. */
  computeBeadInfluence(slimeUnitDirs: Float32Array): Float32Array | null {
    const active = this.config.fill || this.config.count > 0
    if (!active) return null

    const vertexCount = slimeUnitDirs.length / 3
    const out = new Float32Array(vertexCount * 3)

    let beadDirs: Float32Array
    if (this.config.fill) {
      beadDirs = this.fillDirs
    } else {
      const n = this.vertexIndices.length
      beadDirs = new Float32Array(n * 3)
      for (let i = 0; i < n; i++) {
        const vi = this.vertexIndices[i]
        beadDirs[i * 3] = slimeUnitDirs[vi * 3]
        beadDirs[i * 3 + 1] = slimeUnitDirs[vi * 3 + 1]
        beadDirs[i * 3 + 2] = slimeUnitDirs[vi * 3 + 2]
      }
    }
    const beadCount = beadDirs.length / 3
    if (beadCount === 0) return null

    // O(V x B) nearest-direction search — up to ~25M dot products for
    // max fill (fine, only runs at setConfig time).
    for (let v = 0; v < vertexCount; v++) {
      const vx = slimeUnitDirs[v * 3]
      const vy = slimeUnitDirs[v * 3 + 1]
      const vz = slimeUnitDirs[v * 3 + 2]
      let bestDot = -Infinity
      let bestX = 0
      let bestY = 0
      let bestZ = 0
      for (let b = 0; b < beadCount; b++) {
        const bx = beadDirs[b * 3]
        const by = beadDirs[b * 3 + 1]
        const bz = beadDirs[b * 3 + 2]
        const d = vx * bx + vy * by + vz * bz
        if (d > bestDot) {
          bestDot = d
          bestX = bx
          bestY = by
          bestZ = bz
        }
      }
      out[v * 3] = bestX
      out[v * 3 + 1] = bestY
      out[v * 3 + 2] = bestZ
    }
    return out
  }

  /** Rest position of every currently placed bead's CENTER, packed as n × 3.
   *  This accounts for per-bead depth offsets, so it matches the bead's
   *  visible center (not the direction it sits along). Used by the sprinkles
   *  layer to place sprinkles exactly on each bead's spherical surface via
   *  ray-sphere intersection — critical for tight visual contact. */
  getBeadRestPositions(
    _unitDirs: Float32Array,
    restPositions: Float32Array
  ): Float32Array {
    if (this.gridMode) {
      // Grid beads sit directly on the cube face at their fixed rest
      // positions — return a copy so downstream layers (sprinkles bead-
      // lift) can safely hold the reference.
      return this.gridPositions.slice()
    }
    if (this.config.fill) {
      // Fill beads: no static depth offset, centers ride on the slime rest
      // surface at each Fibonacci direction. Multiply direction by the rest
      // magnitude at that direction so non-spherical rest shapes work too.
      const n = this.fillDirs.length / 3
      const out = new Float32Array(n * 3)
      for (let i = 0; i < n; i++) {
        const restMag = this.fillRestMag[i]
        out[i * 3] = this.fillDirs[i * 3] * restMag
        out[i * 3 + 1] = this.fillDirs[i * 3 + 1] * restMag
        out[i * 3 + 2] = this.fillDirs[i * 3 + 2] * restMag
      }
      return out
    }
    // Vertex-anchored beads: rest position = restPositions[vi] × (1 − depth).
    const n = this.vertexIndices.length
    const out = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      const vi = this.vertexIndices[i]
      const rx = restPositions[vi * 3]
      const ry = restPositions[vi * 3 + 1]
      const rz = restPositions[vi * 3 + 2]
      const len = Math.hypot(rx, ry, rz) || 1
      const s = Math.max(0, 1 - this.depthOffsets[i] / len)
      out[i * 3] = rx * s
      out[i * 3 + 1] = ry * s
      out[i * 3 + 2] = rz * s
    }
    return out
  }

  /** Rebuild the per-shape rendering slots to match the current config.
   *  Reuses the bead + wrap material across shapes (their look is uniform
   *  regardless of shape) so material changes stay a single hot-path
   *  assignment. Called from setConfig whenever `shapes` differs from the
   *  currently mounted slot set. */
  private syncSlots(nextShapes: readonly BeadShapeId[]) {
    if (!this.beadMaterial) {
      this.beadMaterial = new THREE.MeshPhysicalMaterial({ color: 0xffffff })
      this.applyBeadBaseParams(this.beadMaterial, this.config)
      this.applyBeadCoatingParams(this.beadMaterial, this.config.coating)
      this.currentMaterialId = this.config.material
      this.currentCoatingId = this.config.coating
      this.installBeadGradientShader(this.beadMaterial)
    }
    if (!this.wrapMaterial) {
      // Slime-wrap shell material — see class-level comment on wrap-shell.
      // Params get filled in from `slimeSurfaceCache` right after creation
      // (or later via syncWrapToSlime); the initial values here just cover
      // the brief window before the first sync call arrives.
      this.wrapMaterial = new THREE.MeshPhysicalMaterial({
        color: 0xffffff,
        side: THREE.DoubleSide
      })
      if (this.slimeSurfaceCache) {
        this.applySlimeParamsToWrap(this.wrapMaterial, this.slimeSurfaceCache)
      }
      this.installWrapInkShader(this.wrapMaterial)
    }

    // Fast path: exact match of shape sequence — reuse slots as-is.
    const sameShapes =
      this.slots.length === nextShapes.length &&
      this.slots.every((s, i) => s.shape === nextShapes[i])
    if (sameShapes) return

    // Shape set changed — dispose old slots and rebuild. Geometries are
    // shape-specific and can't be recycled across a shape switch.
    for (const s of this.slots) {
      this.group.remove(s.instanced)
      this.group.remove(s.wrapInstanced)
      s.instanced.geometry.dispose()
      // wrap shares the SAME geometry object as the bead mesh — already
      // disposed above.
    }
    this.slots = []
    for (const shape of nextShapes) {
      const geo = buildBeadGeometry(shape)
      const im = new THREE.InstancedMesh(geo, this.beadMaterial, MAX_BEADS)
      im.frustumCulled = false
      im.count = 0
      im.instanceColor = new THREE.InstancedBufferAttribute(
        new Float32Array(MAX_BEADS * 3),
        3
      )
      // Per-instance damage + crackLevel attributes for the crack
      // shader on coated beads. Pre-allocated at MAX_BEADS to match
      // instanceColor sizing; update() only touches the active count.
      // Same attribute NAMES as the slime uses so the fragment-shader
      // varying wiring reads the same way, per-instance instead of
      // per-vertex.
      const damageAttr = new THREE.InstancedBufferAttribute(
        new Float32Array(MAX_BEADS),
        1
      )
      damageAttr.setUsage(THREE.DynamicDrawUsage)
      geo.setAttribute('aDamage', damageAttr)
      const crackLevelAttr = new THREE.InstancedBufferAttribute(
        new Float32Array(MAX_BEADS),
        1
      )
      crackLevelAttr.setUsage(THREE.DynamicDrawUsage)
      geo.setAttribute('aCrackLevel', crackLevelAttr)
      const pressPointAttr = new THREE.InstancedBufferAttribute(
        new Float32Array(MAX_BEADS * 3),
        3
      )
      pressPointAttr.setUsage(THREE.DynamicDrawUsage)
      geo.setAttribute('aPressPoint', pressPointAttr)
      // Photo quadrant defaults to -1 (no photo) — setPhotos + setConfig
      // overwrite this whenever the assignment changes so plain beads
      // keep their neutral value.
      const photoQuadrantAttr = new THREE.InstancedBufferAttribute(
        new Float32Array(MAX_BEADS),
        1
      )
      ;(photoQuadrantAttr.array as Float32Array).fill(-1)
      photoQuadrantAttr.setUsage(THREE.DynamicDrawUsage)
      geo.setAttribute('aPhotoQuadrant', photoQuadrantAttr)
      this.group.add(im)
      const wim = new THREE.InstancedMesh(geo, this.wrapMaterial, MAX_BEADS)
      wim.frustumCulled = false
      wim.count = 0
      wim.renderOrder = 1
      this.group.add(wim)
      this.slots.push({
        shape,
        instanced: im,
        wrapInstanced: wim,
        count: 0,
        damageAttr,
        crackLevelAttr,
        pressPointAttr,
        photoQuadrantAttr
      })
    }
  }

  /** 슬라임 안 mode — shrink the bead instanced meshes AND the wrap-
   *  shell meshes independently. Group-scaling everything (the naive
   *  approach) dragged the wrap fully inward and the slime "skin"
   *  disappeared; scaling only beads left the wrap sitting on the
   *  surface as bead-shaped bulges that read as beads-on-surface. The
   *  compromise: beads drop deep (small `beadScale`) while the wrap
   *  moves inward only slightly (large `wrapScale` near 1) so the
   *  slime keeps a soft bead-textured skin but the actual bead cores
   *  read as separated inclusions well behind that skin. `beadScale =
   *  wrapScale = 1` restores surface-anchored behaviour. */
  setInsideScale(beadScale: number, wrapScale: number) {
    for (const s of this.slots) {
      s.instanced.scale.setScalar(beadScale)
      s.wrapInstanced.scale.setScalar(wrapScale)
    }
  }

  /** Copy the slime's current surface look onto the wrap-shell material.
   *  Called by SlimeApp after every slime setter (color / material /
   *  coating / coating colour). Also caches the params so if the wrap
   *  material hasn't been created yet, ensureInstanced will pick them up. */
  syncWrapToSlime(params: NonNullable<BeadsLayer['slimeSurfaceCache']>) {
    this.slimeSurfaceCache = params
    if (this.wrapMaterial) {
      this.applySlimeParamsToWrap(this.wrapMaterial, params)
    }
    // Coated beads mirror the slime's surface look — if the slime just
    // changed material / coating, refresh the bead material so a coated
    // chunk bead updates in lockstep with the slime (matte slime →
    // matte bead body under the coating, crystal slime → transparent
    // bead body, etc.). Uncoated beads keep their bead-material presets.
    if (this.beadMaterial && this.currentCoatingId !== 'none') {
      this.applyBeadBaseParams(this.beadMaterial, this.config)
      this.applyBeadCoatingParams(this.beadMaterial, this.currentCoatingId)
    }
  }

  /** Adopt the slime's live ink uniform refs so the wrap-shell paints the
   *  same marble swirls on top of every bead. Sharing refs (not copying
   *  values) means a single slime.setInk() call ripples to both layers with
   *  no re-emit. Safe to call before or after ensureInstanced — the shader
   *  gets installed lazily whichever comes second. */
  setInkUniforms(
    colorUniform: { value: THREE.Color },
    amountUniform: { value: number }
  ) {
    this.inkColorUniform = colorUniform
    this.inkAmountUniform = amountUniform
    if (this.wrapMaterial) this.installWrapInkShader(this.wrapMaterial)
  }

  /** Adopt the slime's live gradient uniform refs so the wrap-shell
   *  samples the SAME multi-colour band the slime is painted with.
   *  Sharing refs (not copies) means one slime.setColors() call ripples
   *  to both layers without a re-emit. Follows the same before/after
   *  ensureInstanced tolerance as setInkUniforms. */
  setSlimeGradientUniforms(
    useUniform: { value: number },
    texUniform: { value: THREE.Texture | null },
    radiusUniform: { value: number }
  ) {
    this.slimeGradientUseUniform = useUniform
    this.slimeGradientTexUniform = texUniform
    this.slimeGradientRadiusUniform = radiusUniform
    if (this.wrapMaterial) this.installWrapInkShader(this.wrapMaterial)
  }

  /** Adopt the slime's matte-material flag uniform so the wrap-shell
   *  can render the same darker-tone foam pattern the slime body does.
   *  Under compact-fill layers, wrap shells cover almost the whole
   *  slime surface — without foam on the wrap, the aerated look
   *  disappears whenever any beads are active. */
  setMatteFoamUniform(uniform: { value: number }) {
    this.matteFoamUniform = uniform
    if (this.wrapMaterial) this.installWrapInkShader(this.wrapMaterial)
  }

  /** Turn the 슬라임볼 per-vertex dent pass on/off. On for the buried
   *  single-centered ball, off for every other layout so a surface bead
   *  under a finger doesn't ALSO indent at every stored dent direction. */
  setBallDentEnabled(on: boolean) {
    this.ballDentEnabledUniform.value = on ? 1.0 : 0.0
  }

  /** Write one dent slot. `dir` is a unit vector in bead-local frame
   *  (= slime-local for the buried ball since its instance rotation is
   *  identity), `strength` is 0..~0.35 = fraction of bead radius the
   *  vertex is pushed inward at the centre of the cone. Zero strength
   *  disables the slot. */
  setBallDent(
    i: number,
    dx: number,
    dy: number,
    dz: number,
    strength: number
  ) {
    const arr = this.ballDentsUniform.value
    if (i < 0 || i >= arr.length) return
    arr[i].set(dx, dy, dz, strength)
  }

  /** Number of dent slots the shader iterates over. Kept in sync with
   *  the ballDentsUniform initialiser + the shader loop bound. */
  get ballDentCapacity(): number {
    return this.ballDentsUniform.value.length
  }

  /** Set the ball's overall bulge amount. Value is roughly a "press
   *  time × pressure" accumulator; the shader curves it through an
   *  exponential asymptote so a long press keeps expanding the ball
   *  without ever hitting a hard cap. Independent from dent slots
   *  so the bulge can lead / trail the local dent freely. */
  setBallBulgeAmount(v: number) {
    this.ballBulgeUniform.value = v
  }

  /** Attach onBeforeCompile that mixes ink swirls into the wrap fragment
   *  colour. Samples turbulence in the wrap's local (post-instance) position
   *  — the bead group lives at identity under slime.mesh, so this coord
   *  space matches the slime's `vRest` sampling frame, giving one continuous
   *  swirl pattern that flows from the slime through every bead's coating. */
  private installWrapInkShader(mat: THREE.MeshPhysicalMaterial) {
    if (!this.inkColorUniform || !this.inkAmountUniform) return
    const colorU = this.inkColorUniform
    const amountU = this.inkAmountUniform
    const gradUseU = this.slimeGradientUseUniform
    const gradTexU = this.slimeGradientTexUniform
    const gradRadiusU = this.slimeGradientRadiusUniform
    const matteU = this.matteFoamUniform
    // All shader mixins (ink + slime-gradient sampling + matte foam)
    // share one onBeforeCompile — a material only supports a single
    // hook so we fold them into the same replace path. Gradient runs
    // BEFORE ink so ink still paints its swirls on top of the gradient
    // base; foam runs LAST so darker pockets tint whatever colour ended
    // up in diffuseColor (gradient, ink, or plain slime base).
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uInkColor = colorU
      shader.uniforms.uInkAmount = amountU
      if (gradUseU && gradTexU && gradRadiusU) {
        shader.uniforms.uWrapGradientUse = gradUseU
        shader.uniforms.uWrapGradient = gradTexU
        shader.uniforms.uWrapGradientRadius = gradRadiusU
      }
      if (matteU) {
        shader.uniforms.uWrapMaterialIsMatte = matteU
      }

      shader.vertexShader =
        `varying vec3 vWrapLocal;\n` +
        shader.vertexShader.replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           vec4 wrapPos = vec4(transformed, 1.0);
           #ifdef USE_INSTANCING
             wrapPos = instanceMatrix * wrapPos;
           #endif
           vWrapLocal = wrapPos.xyz;`
        )

      shader.fragmentShader =
        `uniform vec3 uInkColor;
         uniform float uInkAmount;
         uniform float uWrapGradientUse;
         uniform sampler2D uWrapGradient;
         uniform float uWrapGradientRadius;
         uniform float uWrapMaterialIsMatte;
         varying vec3 vWrapLocal;

         float wrapInkTurb(vec3 p) {
           float n = 0.0;
           float amp = 1.0;
           for (int i = 0; i < 4; i++) {
             n += amp * sin(
               p.x * 1.7 +
               sin(p.y * 1.3 + p.z * 0.9) * 2.0
             );
             p *= 2.05;
             amp *= 0.5;
           }
           return n;
         }

         // Foam noise helpers — mirror SlimeSphere's foamHash3 /
         // foamNoise / foamFbm so wrap shells sampled in the same
         // slime-local frame produce the identical foam pattern that
         // flows across the slime body onto every bead.
         float wrapFoamHash3(vec3 p) {
           p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
           p *= 17.0;
           return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
         }
         float wrapFoamNoise(vec3 p) {
           vec3 i = floor(p);
           vec3 f = fract(p);
           vec3 u = f * f * (3.0 - 2.0 * f);
           float n000 = wrapFoamHash3(i);
           float n100 = wrapFoamHash3(i + vec3(1.0, 0.0, 0.0));
           float n010 = wrapFoamHash3(i + vec3(0.0, 1.0, 0.0));
           float n110 = wrapFoamHash3(i + vec3(1.0, 1.0, 0.0));
           float n001 = wrapFoamHash3(i + vec3(0.0, 0.0, 1.0));
           float n101 = wrapFoamHash3(i + vec3(1.0, 0.0, 1.0));
           float n011 = wrapFoamHash3(i + vec3(0.0, 1.0, 1.0));
           float n111 = wrapFoamHash3(i + vec3(1.0, 1.0, 1.0));
           float nx00 = mix(n000, n100, u.x);
           float nx10 = mix(n010, n110, u.x);
           float nx01 = mix(n001, n101, u.x);
           float nx11 = mix(n011, n111, u.x);
           float nxy0 = mix(nx00, nx10, u.y);
           float nxy1 = mix(nx01, nx11, u.y);
           return mix(nxy0, nxy1, u.z);
         }
         float wrapFoamFbm(vec3 p) {
           float total = 0.0;
           float amp = 0.5;
           for (int i = 0; i < 4; i++) {
             total += wrapFoamNoise(p) * amp;
             p *= 2.15;
             amp *= 0.55;
           }
           return total;
         }
        ` +
        shader.fragmentShader.replace(
          '#include <map_fragment>',
          `#include <map_fragment>
           // Slime gradient sampling — keyed off the wrap vertex's
           // Y in slime-local space (same frame the slime shader uses
           // for its own gradient), so compact beads under a multi-
           // colour slime pick up the SAME top-to-bottom colour band
           // instead of every wrap flat-tinting to slime.mat.color.
           if (uWrapGradientUse > 0.5) {
             float gt = clamp(
               (vWrapLocal.y / uWrapGradientRadius + 1.0) * 0.5,
               0.0,
               1.0
             );
             diffuseColor.rgb =
               texture2D(uWrapGradient, vec2(gt, 0.5)).rgb;
           }
           if (uInkAmount > 0.005) {
             float t = wrapInkTurb(vWrapLocal * 1.6);
             float threshold = 0.05 + 0.65 * uInkAmount;
             float band = 1.0 - smoothstep(0.0, threshold, abs(t));
             diffuseColor.rgb =
               mix(diffuseColor.rgb, uInkColor, clamp(band, 0.0, 1.0));
           }
           // Matte foam — same darker-tone bubble mottling that the
           // slime body renders. Sampled in slime-local space so the
           // pattern lines up continuously across the slime and every
           // wrap-covered bead, giving one unified aerated look under
           // dense compact-fill layers.
           if (uWrapMaterialIsMatte > 0.5) {
             float fbm = wrapFoamFbm(vWrapLocal * 22.0);
             float fine = wrapFoamNoise(vWrapLocal * 55.0);
             float foam = clamp(fbm * 0.72 + fine * 0.32, 0.0, 1.0);
             float bright = smoothstep(0.48, 0.82, foam);
             float shade  = smoothstep(0.58, 0.18, foam);
             diffuseColor.rgb = mix(
               diffuseColor.rgb,
               diffuseColor.rgb * 0.65,
               bright * 0.55
             );
             diffuseColor.rgb = mix(
               diffuseColor.rgb,
               diffuseColor.rgb * 0.55,
               shade * 0.6
             );
             float _wRareDark = smoothstep(0.2, 0.7, wrapFoamNoise(vWrapLocal * 8.0));
             diffuseColor.rgb = mix(
               diffuseColor.rgb,
               diffuseColor.rgb * 0.2,
               shade * _wRareDark
             );
           }`
        )
    }
    mat.needsUpdate = true
  }

  /** Install a fragment-shader mixin on the bead material that samples a
   *  1D gradient LUT keyed off SCREEN-Y (each vertex's position in view
   *  space, relative to its bead's centre, normalised by bead radius).
   *  Sampling by screen-Y instead of world-Y keeps the gradient
   *  vertical on the CAMERA every frame — so no matter how the slime
   *  is rotated, every visible bead face still shows the palette top-
   *  to-bottom across itself. Sampling by world Y made the gradient
   *  rotate with the slime, which after a slime spin looked like each
   *  bead was one flat colour (front/back of the sphere). Off unless
   *  uBeadGradientUse > 0.5. */
  private installBeadGradientShader(mat: THREE.MeshPhysicalMaterial) {
    const useU = this.gradientUseUniform
    const texU = this.gradientTexUniform
    const sizeU = this.gradientSizeUniform
    const damageOnU = this.beadDamageEnabledUniform
    const isWaxU = this.beadIsWaxUniform
    const isIceU = this.beadIsIceUniform
    const isFoilU = this.beadIsFoilUniform
    const isTubeU = this.beadIsTubeUniform
    const foilFullU = this.beadFoilFullSurfaceUniform
    const photoUseU = this.beadPhotoUseUniform
    const photoAtlasU = this.beadPhotoAtlasUniform
    const coatingTintU = this.beadCoatingTintUniform
    const coatingAlphaU = this.beadCoatingAlphaUniform
    const matteU = this.beadMaterialIsMatteUniform
    const ballDentEnabledU = this.ballDentEnabledUniform
    const ballDentsU = this.ballDentsUniform
    const ballDentSlots = ballDentsU.value.length
    const ballBulgeU = this.ballBulgeUniform
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uBeadGradientUse = useU
      shader.uniforms.uBeadGradient = texU
      shader.uniforms.uBeadSize = sizeU
      // Crack shader uniforms — mirror the slime's coating-branch names
      // (uCoatingIsWax / Ice / Foil, uDamageEnabled) so the fragment
      // logic below stays visually consistent with slime cracks.
      shader.uniforms.uBeadDamageEnabled = damageOnU
      shader.uniforms.uBeadCoatingIsWax = isWaxU
      shader.uniforms.uBeadCoatingIsIce = isIceU
      shader.uniforms.uBeadCoatingIsFoil = isFoilU
      shader.uniforms.uBeadCoatingIsTube = isTubeU
      shader.uniforms.uBeadFoilFullSurface = foilFullU
      // Coating tint — independent from the per-bead colour so ball's
      // coating can be a different hue than its body.
      shader.uniforms.uBeadCoatingTint = coatingTintU
      shader.uniforms.uBeadCoatingAlpha = coatingAlphaU
      // Slime-matte foam pattern flag for inner-slime layers.
      shader.uniforms.uBeadMaterialIsMatte = matteU
      // 사진 비즈 uniforms — atlas is a 2×2 grid of up to 4 photos.
      // aPhotoQuadrant tells each instance which quadrant to sample
      // (0..3, -1 = no photo).
      shader.uniforms.uBeadPhotoUse = photoUseU
      shader.uniforms.uBeadPhotoAtlas = photoAtlasU
      // 슬라임볼 dent uniforms — pushed inward in the vertex shader
      // around each active dent's direction. See ballDentsUniform doc.
      shader.uniforms.uBallDentEnabled = ballDentEnabledU
      shader.uniforms.uBallDents = ballDentsU
      shader.uniforms.uBallBulge = ballBulgeU

      shader.vertexShader =
        `varying float vBeadGradT;
         uniform float uBeadSize;
         // Per-instance damage + crackLevel from the slot geometry's
         // InstancedBufferAttribute — all vertices of one bead see the
         // same value, so voronoi cell size scales in bead-LOCAL space
         // (via the position attribute) rather than world space.
         attribute float aDamage;
         attribute float aCrackLevel;
         attribute vec3 aPressPoint;
         attribute float aPhotoQuadrant;
         varying float vBeadDamage;
         varying float vBeadCrackLevel;
         varying vec3 vBeadLocal;
         varying vec3 vBeadPressDir;
         varying vec3 vBeadVertexDir;
         varying float vBeadPhotoQuadrant;
         uniform float uBallDentEnabled;
         uniform vec4 uBallDents[${ballDentSlots}];
         uniform float uBallBulge;
        ` +
        shader.vertexShader.replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           // 슬라임볼 dent + volume-preserving bulge. Runs BEFORE the
           // varying hookups below so subsequent view-space calculations
           // pick up the already-displaced position (bead centre stays
           // at origin so vBeadVertexDir still resolves correctly). Two
           // passes together mimic how the outer slime deforms under a
           // press:
           //   (1) UNIFORM BULGE — every vertex scales outward by a
           //       factor proportional to the total dent load. This is
           //       the "the ball's volume expands with the slime" pass:
           //       without it, adding dents only pushed vertices IN and
           //       the ball read as shrinking even though the slime
           //       around it was clearly bulging outward.
           //   (2) LOCAL DENT — inside each dent's cone, subtract along
           //       the outward direction to carve a concave depression
           //       where the finger landed. Dent strength is tuned to
           //       overwhelm the bulge at the cone centre so the
           //       depression stays clearly concave regardless of how
           //       many dents are active.
           // uBallDentEnabled gates the whole pass off for anything but
           // the buried single-centered ball.
           if (uBallDentEnabled > 0.5) {
             // Bulge is DECOUPLED from dent slots — driven by
             // uBallBulge (a press-time × pressure accumulator on
             // the CPU) so the ball's outer envelope starts
             // expanding the instant any finger touches the slime,
             // BEFORE the touch-through filter admits tips for the
             // local dent. Without this decoupling, the outer slime
             // bulges first and the buried ball reads as "shrunk"
             // relative to the growing slime silhouette until dent
             // accumulation finally catches up.
             //
             // Local dent still uses the touch-filtered slot strengths
             // (only tips that reached the ball's skin populate a
             // slot), so the concave depression only appears at the
             // press point AFTER contact — but by then the ball is
             // already puffed and there's no perceived shrink.
             //
             // Strict cap keeps cone-centre verts at (rest .. rest+bulge)
             // so the ball's front surface never recedes past its rest
             // position in perspective view.
             vec3 _bDir = normalize(transformed);
             float _bLocalDent = 0.0;
             for (int i = 0; i < ${ballDentSlots}; i++) {
               vec4 _bD = uBallDents[i];
               if (_bD.w > 0.001) {
                 float _bCos = dot(_bDir, _bD.xyz);
                 float _bFall = smoothstep(0.55, 1.0, _bCos);
                 _bLocalDent = max(_bLocalDent, _bD.w * _bFall);
               }
             }
             float _bBulge = 0.3 * (1.0 - exp(-uBallBulge * 2.0));
             transformed *= (1.0 + _bBulge);
             _bLocalDent = min(_bLocalDent, _bBulge);
             transformed -= _bDir * _bLocalDent;
           }
           vBeadDamage = aDamage;
           vBeadCrackLevel = aCrackLevel;
           vBeadPressDir = aPressPoint;
           vBeadPhotoQuadrant = aPhotoQuadrant;
           vBeadLocal = position;
           // Direction from bead centre to this vertex, expressed in
           // the SLIME-local frame (same frame press-point lives in).
           // Foil crack branch uses this to gate the tear pattern to
           // a cone around the press point, so the shell rips from
           // where the finger landed rather than uniformly all over.
           #ifdef USE_INSTANCING
             vec4 _bVert = instanceMatrix * vec4(position, 1.0);
             vec4 _bCenter = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
             vBeadVertexDir = normalize(_bVert.xyz - _bCenter.xyz);
           #else
             vBeadVertexDir = normalize(position);
           #endif

           // View-space position of this vertex and its bead centre.
           // modelViewMatrix already folds in the slime mesh's rotation,
           // so screen up ends up as view-space +Y no matter how the
           // user has spun the ball.
           vec4 vPos = vec4(transformed, 1.0);
           vec4 vCenter = vec4(0.0, 0.0, 0.0, 1.0);
           #ifdef USE_INSTANCING
             vPos = instanceMatrix * vPos;
             vCenter = instanceMatrix * vCenter;
           #endif
           vPos = modelViewMatrix * vPos;
           vCenter = modelViewMatrix * vCenter;
           float relY = vPos.y - vCenter.y;
           vBeadGradT = clamp((relY / uBeadSize + 1.0) * 0.5, 0.0, 1.0);`
        )

      shader.fragmentShader =
        `uniform float uBeadGradientUse;
         uniform sampler2D uBeadGradient;
         uniform float uBeadDamageEnabled;
         uniform float uBeadCoatingIsWax;
         uniform float uBeadCoatingIsIce;
         uniform float uBeadCoatingIsFoil;
         uniform float uBeadCoatingIsTube;
         uniform float uBeadFoilFullSurface;
         uniform vec3 uBeadCoatingTint;
         uniform float uBeadCoatingAlpha;
         uniform float uBeadMaterialIsMatte;
         uniform float uBeadPhotoUse;
         uniform sampler2D uBeadPhotoAtlas;
         varying float vBeadGradT;
         varying float vBeadDamage;
         varying float vBeadCrackLevel;
         varying vec3 vBeadLocal;
         varying vec3 vBeadPressDir;
         varying vec3 vBeadVertexDir;
         varying float vBeadPhotoQuadrant;

         // Matte foam noise — same aerated bubble pattern the slime
         // shader draws for its 'matte' material. Ported inline so the
         // bead shader doesn't need to share GLSL with SlimeSphere.
         // Declared AFTER the varyings so the compiler sees the full
         // top-level qualifier block before any function bodies.
         float beadFoamHash3(vec3 p) {
           p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
           p *= 17.0;
           return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
         }
         float beadFoamNoise(vec3 p) {
           vec3 i = floor(p);
           vec3 f = fract(p);
           vec3 u = f * f * (3.0 - 2.0 * f);
           float n000 = beadFoamHash3(i);
           float n100 = beadFoamHash3(i + vec3(1.0, 0.0, 0.0));
           float n010 = beadFoamHash3(i + vec3(0.0, 1.0, 0.0));
           float n110 = beadFoamHash3(i + vec3(1.0, 1.0, 0.0));
           float n001 = beadFoamHash3(i + vec3(0.0, 0.0, 1.0));
           float n101 = beadFoamHash3(i + vec3(1.0, 0.0, 1.0));
           float n011 = beadFoamHash3(i + vec3(0.0, 1.0, 1.0));
           float n111 = beadFoamHash3(i + vec3(1.0, 1.0, 1.0));
           float nx00 = mix(n000, n100, u.x);
           float nx10 = mix(n010, n110, u.x);
           float nx01 = mix(n001, n101, u.x);
           float nx11 = mix(n011, n111, u.x);
           float nxy0 = mix(nx00, nx10, u.y);
           float nxy1 = mix(nx01, nx11, u.y);
           return mix(nxy0, nxy1, u.z);
         }
         float beadFoamFbm(vec3 p) {
           float total = 0.0;
           float amp = 0.5;
           for (int i = 0; i < 4; i++) {
             total += beadFoamNoise(p) * amp;
             p *= 2.15;
             amp *= 0.55;
           }
           return total;
         }

         float beadCrackHash(vec2 p) {
           p = fract(p * vec2(233.34, 851.73));
           p += dot(p, p + 23.45);
           return fract(p.x * p.y);
         }

         // Worley/voronoi F2-F1 boundary distance + per-cell random.
         // Ported from the slime crack shader — cells sampled in the
         // bead's LOCAL frame so each bead has its own stable pattern
         // regardless of its world position.
         vec2 beadCrackVoronoi(vec3 p) {
           vec2 uv = p.xy + p.z * 0.7;
           vec2 gi = floor(uv);
           vec2 gf = fract(uv);
           float d1 = 10.0;
           float d2 = 10.0;
           vec2 nearest = vec2(0.0);
           for (int y = -1; y <= 1; y++) {
             for (int x = -1; x <= 1; x++) {
               vec2 o = vec2(float(x), float(y));
               vec2 cp = o + vec2(
                 beadCrackHash(gi + o),
                 beadCrackHash(gi + o + 17.3)
               );
               float d = length(gf - cp);
               if (d < d1) {
                 d2 = d1;
                 d1 = d;
                 nearest = gi + o;
               } else if (d < d2) {
                 d2 = d;
               }
             }
           }
           return vec2(d2 - d1, beadCrackHash(nearest * 3.1415));
         }
        ` +
        shader.fragmentShader
          .replace(
            '#include <map_fragment>',
            `#include <map_fragment>
             // Gradient runs BEFORE color_fragment so the per-instance
             // color_fragment multiply still folds vColor (= white for
             // gradient beads, since gradient bakes into the fragment
             // sample itself) into the gradient sample.
             if (uBeadGradientUse > 0.5) {
               diffuseColor.rgb =
                 texture2D(uBeadGradient, vec2(vBeadGradT, 0.5)).rgb;
             }
             // 사진 비즈: orthographic (x, y) projection of the photo
             // onto the OUTWARD hemisphere of each bead. Cube +Z faces
             // read cleanly; small sphere beads have their geometry
             // flattened into a coin in the vertex shader (aFlatten)
             // so the whole outward face becomes a flat photo tablet.
             if (uBeadPhotoUse > 0.5 && vBeadPhotoQuadrant >= 0.0) {
               vec2 localUV = vec2(
                 vBeadLocal.x * 0.5 + 0.5,
                 1.0 - (vBeadLocal.y * 0.5 + 0.5)
               );
               float rXY = length(vec2(vBeadLocal.x, vBeadLocal.y));
               float radialMask = 1.0 - smoothstep(0.94, 1.0, rXY);
               float zMask = smoothstep(0.0, 0.35, vBeadLocal.z);
               float photoAlpha = radialMask * zMask;
               if (photoAlpha > 0.001) {
                 // 2×2 atlas: quadrant 0 = canvas top-left, 1 = top-
                 // right, 2 = bottom-left, 3 = bottom-right. three.js
                 // uploads with flipY = true so canvas Y-down inverts
                 // to GPU V-up — canvas top-half quadrants (qy=0) end
                 // up in GPU V range 0.5..1.0, bottom-half (qy=1) in
                 // V range 0..0.5.
                 float qx = mod(vBeadPhotoQuadrant, 2.0);
                 float qy = floor(vBeadPhotoQuadrant / 2.0);
                 vec2 atlasUV = vec2(
                   qx * 0.5 + localUV.x * 0.5,
                   1.0 - qy * 0.5 - localUV.y * 0.5
                 );
                 vec3 photoRGB =
                   texture2D(uBeadPhotoAtlas, atlasUV).rgb;
                 diffuseColor.rgb =
                   mix(diffuseColor.rgb, photoRGB, photoAlpha);
               }
             }`
          )
          .replace(
            '#include <color_fragment>',
            `#include <color_fragment>
           // Matte foam pattern — mottle the bead's diffuse with the same
           // aerated bubble pockets the slime shader draws for its matte
           // material, so a matte 슬라임볼 reads as foam. Sampled in the
           // bead's LOCAL frame (each bead gets its own stable pattern).
           // Runs BEFORE the base-colour snapshot so cracks reveal the
           // foam texture beneath the coating tint, matching the slime's
           // coating-crack behaviour on matte material.
           float vBeadFoam = 0.0;
           if (uBeadMaterialIsMatte > 0.5) {
             float bfbm = beadFoamFbm(vBeadLocal * 22.0);
             float bfine = beadFoamNoise(vBeadLocal * 55.0);
             vBeadFoam = clamp(bfbm * 0.72 + bfine * 0.32, 0.0, 1.0);
             float bBright = smoothstep(0.48, 0.82, vBeadFoam);
             float bShade  = smoothstep(0.58, 0.18, vBeadFoam);
             diffuseColor.rgb = mix(
               diffuseColor.rgb,
               diffuseColor.rgb * 0.65,
               bBright * 0.55
             );
             diffuseColor.rgb = mix(
               diffuseColor.rgb,
               diffuseColor.rgb * 0.55,
               bShade * 0.6
             );
             float _bRareDark = smoothstep(0.2, 0.7, beadFoamNoise(vBeadLocal * 8.0));
             diffuseColor.rgb = mix(
               diffuseColor.rgb,
               diffuseColor.rgb * 0.2,
               bShade * _bRareDark
             );
           }
           // Snapshot the bead's own diffuse (post per-instance colour
           // multiply, post foam) so cracks reveal the actual bead colour
           // beneath the coating tint.
           vec3 _beadBaseColor = diffuseColor.rgb;
           if (uBeadCoatingAlpha > 0.001) {
             diffuseColor.rgb = mix(
               diffuseColor.rgb,
               uBeadCoatingTint,
               clamp(uBeadCoatingAlpha, 0.0, 1.0)
             );
           }
           // ── Bead crack pass ─────────────────────────────────────
           // Runs AFTER color_fragment so it modifies the FINAL per-
           // instance colour (base material * instanceColor). If we
           // ran before color_fragment, our mix toward wetReveal would
           // get multiplied by instanceColor immediately after, which
           // for a white base material collapses back to instanceColor
           // — cracks would be invisible.
           // Per-coating crack behaviour, matched to the slime crack
           // shader:
           //   ICE / caramel — SHATTER: many hairline gaps with hard
           //     crisp edges (smoothstep with 25% AA), a second
           //     voronoi layer subdivides pieces once crackLevel > 1.2.
           //   WAX — TEAR with HARD angular voronoi boundaries; gaps
           //     widen progressively through successive presses. A
           //     second layer subdivides pieces at crackLevel 3+.
           //   FOIL / TUBE — TEAR with SOFT wispy feathered edges,
           //     WIDE gaps that grow aggressively so the surface
           //     visibly rips open. Cells are LARGER (few big tears)
           //     rather than many small crack lines.
           // All cracks reveal a bright wet-cream tone (as on the
           // slime), so torn / cracked regions read as exposing a
           // glistening interior — this is what makes a foil "tear"
           // visually distinct from a mere darkened crack line.
           float crackReveal = 0.0;
           float revealTone = 0.4;
           if (uBeadDamageEnabled > 0.5) {
             // ── ICE / caramel — SHATTER ────────────────────────
             // MANY small hairline gaps forming a dense polygonal
             // network. Piece SIZES stay constant (voronoi scale
             // fixed), gap widths stay THIN even at max damage —
             // the shell breaks along countless boundaries rather
             // than a few big tears. Layer 2 subdivides plates
             // further once damage crosses 0.5.
             if (uBeadCoatingIsIce > 0.5 && vBeadDamage > 0.01) {
               // Medium-density voronoi (scale 6) so pieces are big
               // enough for the gap to READ — a scale of 8+ made
               // hairlines invisible on a small bead.
               vec2 v1 = beadCrackVoronoi(vBeadLocal * 6.0);
               float visibility = smoothstep(0.01, 0.1, vBeadDamage);
               // Thicker gap range: 0.05 → 0.28 over damage 0.02..0.7
               // (nearly 2× the previous thickness) so caramel
               // shatter reads as chunky fractures rather than
               // hairlines.
               float gapWidth =
                 mix(0.05, 0.28, smoothstep(0.02, 0.7, vBeadDamage));
               float gapEdge = gapWidth * 0.75;
               float layer1 =
                 (1.0 - smoothstep(gapEdge, gapWidth, v1.x)) * visibility;
               vec2 v2 =
                 beadCrackVoronoi(vBeadLocal * 12.0 + vec3(37.1, 11.3, 88.7));
               float visLayer2 = smoothstep(0.5, 0.85, vBeadDamage);
               float layer2 =
                 (1.0 - smoothstep(gapEdge, gapWidth, v2.x)) * visLayer2;
               crackReveal = max(layer1, layer2);
               revealTone = 0.7;
             }
             // ── WAX — CHUNKY WISPY-EDGE TEAR with SUBDIVISION ─
             // Two voronoi layers so a long press keeps SHATTERING the
             // shell into MORE, SMALLER wax pieces instead of just
             // widening the gaps until existing pieces vanish. Layer
             // 1 (freq 2.4) opens the initial chunky slabs; layer 2
             // (freq 5.5) subdivides those slabs once damage crosses
             // 0.4, adding fresh crack lines through pieces rather
             // than eroding them. Base gap width is trimmed vs. the
             // old single-layer version so no single layer can widen
             // a gap far enough to erase a piece — the pieces stay
             // visible, they just keep dividing.
             else if (uBeadCoatingIsWax > 0.5 && vBeadDamage > 0.01) {
               float visibility = smoothstep(0.01, 0.15, vBeadDamage);
               float baseWidth = smoothstep(0.02, 0.7, vBeadDamage) * 0.4;
               vec2 v1 = beadCrackVoronoi(vBeadLocal * 2.4);
               float perCell1 = 0.3 + v1.y * 2.0;
               float crackWidth1 = min(baseWidth * perCell1, 0.55);
               float edgeBand1 = min(0.15, crackWidth1 * 0.4);
               float layer1 = (1.0 - smoothstep(
                 crackWidth1 - edgeBand1,
                 crackWidth1,
                 v1.x
               )) * visibility;
               vec2 v2 = beadCrackVoronoi(
                 vBeadLocal * 5.5 + vec3(42.7, 19.3, 77.1)
               );
               float visLayer2 = smoothstep(0.4, 0.75, vBeadDamage);
               float perCell2 = 0.3 + v2.y * 2.0;
               float crackWidth2 = min(baseWidth * perCell2, 0.5);
               float edgeBand2 = min(0.12, crackWidth2 * 0.4);
               float layer2 = (1.0 - smoothstep(
                 crackWidth2 - edgeBand2,
                 crackWidth2,
                 v2.x
               )) * visLayer2;
               crackReveal = max(layer1, layer2);
               revealTone = 0.65;
             }
             // ── FOIL / TUBE — SLIME-FOIL WISPY TEAR ────────────
             // Mirror the slime option's foil coating shader as
             // closely as possible: voronoi at freq 2.3, damage-only
             // width ramp (no stretch proxy), tight width cap so the
             // tear opens cleanly instead of splitting into loose
             // fragments. No press-cone gate (whole-ball tears
             // uniformly) and no edge-shadow (rim darkening is
             // suppressed for foil/tube below so the boundary reads
             // as a sharp hairline exactly like the slime's).
             else if (uBeadCoatingIsFoil > 0.5 && vBeadDamage > 0.005) {
               vec2 v = beadCrackVoronoi(vBeadLocal * 2.3);
               // Gradual visibility ramp — first tap only hints at
               // hairline tears, more taps / sustained press open the
               // reveal further. Matches the slime option's "조금씩
               // 찢기는" foil behaviour instead of full-crack response
               // on the very first tap.
               float visibility = smoothstep(0.05, 0.55, vBeadDamage);
               float damageWidth = smoothstep(0.15, 0.85, vBeadDamage) * 0.38;
               float perCell = 0.3 + v.y * 1.8;
               float crackWidth = min(damageWidth * perCell, 0.68);
               float edgeBand = min(0.004, crackWidth * 0.15);
               crackReveal = (1.0 - smoothstep(
                 crackWidth - edgeBand,
                 crackWidth,
                 v.x
               )) * visibility;
               revealTone = 0.9;
             }
           }

           // Cracks reveal a bright wet-cream tone for the classic
           // wet-slime look. Near-WHITE beads are a special case:
           // brightening a white bead further to white leaves no
           // visible crack, so those specifically darken instead —
           // detected via min(r,g,b) > 0.85 so coloured beads (even
           // saturated bright ones like yellow / cyan) keep the
           // original brighten-to-white reveal.
           // Special case: 속비즈 (single centred bead) with foil/tube
           // coating reveals PURE WHITE regardless of the bead colour
           // — matches the slime coating's "inside is white under
           // coating" convention so the whole app reads consistently.
           // Crack reveals the ball's own picked colour faithfully — no
           // whitewash toward vec3(1.0), no darken. Previous wet-cream
           // reveal blended up to 90% white into the crack diffuse for
           // foil, which combined with the diffuse boost pushed saturated
           // ball colours (crystal / glossy plastic) to look solid white.
           vec3 _crackReveal = _beadBaseColor;
           // Darken the crack RIM (where crackReveal ramps from 0 to
           // 1) so the boundary between intact coating and exposed
           // slime reads as a visible shadow line — foil is a
           // physical sheet, torn edges have thickness that catches
           // less light. SUPPRESSED for foil / tube coatings: the
           // slime option's own foil/tube uses a sharp hairline rim
           // and the ball's version should match — the rim shadow
           // read as a soft blur + spawned tiny fragmented dark
           // islands along the tear boundary. Wax/ice still get
           // the shadow so their chunky slabs read with depth.
           float edgeShadow = 4.0 * crackReveal * (1.0 - crackReveal);
           float rimAtten =
             (uBeadCoatingIsFoil > 0.5 || uBeadCoatingIsTube > 0.5)
               ? 0.0
               : 0.55;
           _crackReveal *= (1.0 - edgeShadow * rimAtten);
           diffuseColor.rgb =
             mix(diffuseColor.rgb, _crackReveal, clamp(crackReveal, 0.0, 1.0));`
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
           // Coating's shell material response — wax forces matte,
           // foil forces polished metal — is applied to the intact
           // SHELL area only. Crack area reverts to the ball's own
           // material (plastic / crystal) so a torn foil on a matte
           // ball still shows matte through the tear.
           float _bBaseR = roughnessFactor;
           // Matte foam roughness variation — bright bubble spots drop
           // roughness so tiny highlights read as bubble tops, shaded
           // pockets bump roughness so cavities feel dry. Matches the
           // slime shader's matte-material foam response.
           if (uBeadMaterialIsMatte > 0.5) {
             float bBright = smoothstep(0.55, 0.95, vBeadFoam);
             float bShade  = smoothstep(0.45, 0.05, vBeadFoam);
             _bBaseR = clamp(
               _bBaseR + bShade * 0.15 - bBright * 0.35,
               0.05,
               1.0
             );
           }
           float _bShellR = _bBaseR;
           // Wax shell at 0.4 (satin matte) instead of 0.9 so a white
           // wax coating on the ball reads as bright matte instead of
           // washing out to mid-grey under the env map.
           if (uBeadCoatingIsWax > 0.5) _bShellR = 0.4;
           else if (uBeadCoatingIsTube > 0.5) _bShellR = 0.15;
           else if (uBeadCoatingIsFoil > 0.5) _bShellR = 0.2;
           else if (uBeadCoatingIsIce > 0.5) _bShellR = 0.05;
           // Crack roughness clamped to a satin minimum so a crystal
           // bead (0.02 rough) doesn't turn the tear into a mirror that
           // hides the ball's colour behind the env reflection.
           float _bCrackR = max(_bBaseR, 0.3);
           roughnessFactor = mix(_bShellR, _bCrackR, crackReveal);`
        )
        .replace(
          '#include <metalnessmap_fragment>',
          `#include <metalnessmap_fragment>
           float _bBaseM = metalnessFactor;
           float _bShellM = _bBaseM;
           if (uBeadCoatingIsWax > 0.5) _bShellM = 0.0;
           else if (uBeadCoatingIsTube > 0.5) _bShellM = 0.0;
           else if (uBeadCoatingIsFoil > 0.5) _bShellM = 0.9;
           else if (uBeadCoatingIsIce > 0.5) _bShellM = 0.0;
           metalnessFactor = mix(_bShellM, _bBaseM, crackReveal);`
        )
        .replace(
          '#include <lights_physical_fragment>',
          `#include <lights_physical_fragment>
           // Drop the foil coating's mirror clearcoat inside crack
           // areas so torn foil reveals the raw ball colour instead
           // of a lacquered wash of it.
           #ifdef USE_CLEARCOAT
             material.clearcoat *= mix(1.0, 0.15, clamp(crackReveal, 0.0, 1.0));
           #endif`
        )
    }
    mat.needsUpdate = true
  }

  private applySlimeParamsToWrap(
    mat: THREE.MeshPhysicalMaterial,
    p: NonNullable<BeadsLayer['slimeSurfaceCache']>
  ) {
    mat.color.copy(p.color)
    mat.roughness = p.roughness
    mat.metalness = p.metalness
    mat.transmission = p.transmission
    mat.thickness = p.thickness
    mat.ior = p.ior
    mat.sheen = p.sheen
    mat.sheenRoughness = p.sheenRoughness
    mat.sheenColor.copy(p.sheenColor)
    mat.iridescence = p.iridescence
    mat.iridescenceIOR = p.iridescenceIOR
    mat.clearcoat = p.clearcoat
    mat.clearcoatRoughness = p.clearcoatRoughness
    mat.needsUpdate = true
  }

  private applyMaterialParams(
    mat: THREE.MeshPhysicalMaterial,
    id: BeadMaterialId | MaterialId
  ) {
    // Inner-slime layer (useSlimeMaterials = true) resolves its material
    // id against the slime MATERIALS palette so the ball shares the outer
    // slime's material presets. Every other bead layer falls back to the
    // bead-specific BEAD_MATERIAL_PARAMS table. When the id doesn't exist
    // in the preferred palette (e.g. a legacy 'plastic' inner-slime that
    // predates this migration), fall back to the other table so we still
    // render something sane instead of leaving the material untouched.
    if (this.useSlimeMaterials) {
      const slime = MATERIALS.find((m) => m.id === id)?.params
      if (slime) {
        mat.roughness = slime.roughness
        mat.metalness = slime.metalness
        // Crystal and ice inner-slime keep the slime material's own
        // transmission so the ball reads as a glass sphere just like
        // the slime option's crystal / 아이스 material. All other
        // inner-slime materials render opaque (the gradient path
        // further forces transmission=0 when multi-colour is active
        // regardless).
        const _transparentGlass = id === 'crystal' || id === 'ice'
        mat.transmission = _transparentGlass ? slime.transmission : 0
        mat.thickness = _transparentGlass ? slime.thickness : 0
        mat.ior = slime.ior
        mat.sheen = slime.sheen
        mat.sheenRoughness = slime.sheenRoughness
        mat.sheenColor.setHex(slime.sheenColorHex)
        mat.iridescence = slime.iridescence
        mat.iridescenceIOR = 1.3
        // Glossy ball gets a mirror-smooth clearcoat lacquer on top so it
        // reads as polished candy — sheen alone at 0.4 is subtle and the
        // ball was reading like plain plastic without this lift.
        mat.clearcoat = id === 'glossy' ? 1.0 : 0
        mat.clearcoatRoughness = id === 'glossy' ? 0.05 : 0
        mat.envMapIntensity = 1.0
        mat.needsUpdate = true
        return
      }
    }
    const p = BEAD_MATERIAL_PARAMS[id as BeadMaterialId]
    if (!p) {
      // Fallback for an id valid in MATERIALS but not BEAD_MATERIAL_PARAMS
      // (e.g. 'glossy' set on a regular bead layer via a stale config) —
      // best-effort sample from the slime palette so the material still
      // gets applied instead of silently no-op.
      const slime = MATERIALS.find((m) => m.id === id)?.params
      if (!slime) return
      mat.roughness = slime.roughness
      mat.metalness = slime.metalness
      mat.transmission = slime.transmission
      mat.thickness = slime.thickness
      mat.ior = slime.ior
      mat.sheen = slime.sheen
      mat.sheenRoughness = slime.sheenRoughness
      mat.sheenColor.setHex(slime.sheenColorHex)
      mat.iridescence = slime.iridescence
      mat.iridescenceIOR = 1.3
      mat.clearcoat = 0
      mat.clearcoatRoughness = 0
      mat.envMapIntensity = 1.0
      mat.needsUpdate = true
      return
    }
    mat.roughness = p.roughness
    mat.metalness = p.metalness
    mat.clearcoat = p.clearcoat
    mat.clearcoatRoughness = p.clearcoatRoughness
    mat.transmission = p.transmission
    mat.thickness = p.thickness
    mat.ior = p.ior
    mat.sheen = p.sheen
    mat.sheenRoughness = p.sheenRoughness
    mat.iridescence = p.iridescence
    mat.iridescenceIOR = p.iridescenceIOR
    mat.envMapIntensity = p.envMapIntensity
    mat.needsUpdate = true
  }

  /** Base-layer params for the bead material — picks between the bead's
   *  own presets (plastic / crystal) and the SLIME's live surface params
   *  based on whether a coating is active. Coated beads borrow the
   *  slime's roughness / transmission / sheen / iridescence so the
   *  coating shell reads exactly the same way it does on the slime;
   *  uncoated beads fall back to the punchy bead presets. Bead colour
   *  is per-instance (InstancedMesh instanceColor), so we deliberately
   *  DON'T copy `slimeSurfaceCache.color` — every bead keeps its own
   *  picked-from-the-palette colour even when the base params mirror
   *  the slime. */
  private applyBeadBaseParams(
    mat: THREE.MeshPhysicalMaterial,
    config: BeadsConfig
  ) {
    // Always use the bead's own material presets (plastic / crystal)
    // regardless of coating — coating shouldn't change the underlying
    // material. The coating's shell response (matte for wax, polished
    // metal for foil) is enforced in the shader instead so crack reveals
    // return roughness / metalness to the bead's own material values.
    this.applyMaterialParams(mat, config.material)
    // Regular bead layers (꽉비즈 compact / 비즈볼 chunk) with crystal
    // material — real MeshPhysicalMaterial transmission collides with
    // the outer slime's own transmission (three.js excludes trans-
    // missive objects from other transmissive objects' background
    // pass, so a transparent bead inside a transparent slime became
    // invisible). Substitute alpha transparency: transmission = 0
    // moves beads out of the transmission pass, transparent + opacity
    // renders them via the standard alpha-blended pass which composes
    // correctly over the slime. Crystal's low roughness + full
    // clearcoat still reads as polished glass, and the picked palette
    // colour tints through the alpha blend so each bead shows its own
    // hue while the outer slime remains visible around them.
    // Inner-slime crystal ball keeps real transmission (single
    // instance, wrap-tint handles visibility differently).
    if (
      !this.useSlimeMaterials &&
      config.material === 'crystal'
    ) {
      mat.transmission = 0
      mat.thickness = 0
      mat.transparent = true
      // Strong opacity so the palette colour reads clearly.
      mat.opacity = 0.85
      mat.depthWrite = false
      // depthTest OFF — three.js writes the outer slime's front-surface
      // depth in the transmission pass, and the transparent pass's
      // default depth-test then rejects any bead pixel behind that
      // depth (i.e. every bead sitting inside the slime volume).
      // Disabling depth test on chunk crystal beads lets them render
      // over the slime pixel regardless of position, so the palette
      // colour is visible everywhere on the bead instead of only
      // where it pokes above the slime skin.
      mat.depthTest = false
      mat.needsUpdate = true
    } else {
      mat.transparent = false
      mat.opacity = 1
      mat.depthWrite = true
      mat.depthTest = true
    }
  }

  /** Layer coating params (clearcoat / extra metalness / sheen / forced
   *  matte or crystal base) on top of the current bead material. Mirrors
   *  the slime's _applyLook coating branch minus the crack shader hookup
   *  (beads have no per-vertex damage) and minus the coating-color sheen
   *  tint (beads carry their own per-instance colors, so a shared tint
   *  would clash with the multi-colored beads). Assumes the caller has
   *  just re-applied the base material params so any accumulated
   *  additive changes from a previous coating are reset. */
  private applyBeadCoatingParams(
    mat: THREE.MeshPhysicalMaterial,
    id: CoatingId
  ) {
    const c = COATINGS.find((x) => x.id === id)?.params
    if (!c) return
    // Only clearcoat is applied from the coating preset — foil's mirror
    // lacquer, wax's dry matte finish. Roughness / metalness overrides
    // happen in the shader (roughnessmap_fragment) so they can be reverted
    // per-fragment inside crack areas.
    mat.clearcoat = c.clearcoat
    mat.clearcoatRoughness = c.clearcoatRoughness
    // Zero transmission / sheen / iridescence on any coated bead so the
    // coating diffuse reads the SAME tone regardless of underlying bead
    // material (crystal's 95% transmission would otherwise wash the
    // coating out; sheen would tint it). Matches the slime's coating
    // path — coating colour has to be deterministic across materials.
    if (id !== 'none') {
      mat.transmission = 0
      mat.thickness = 0
      mat.sheen = 0
      mat.iridescence = 0
    }
    // 글레이즈 (ice) coating renders the ball as CRYSTAL — bring the
    // transmission back on so the ball reads as clear glass through
    // the glaze rather than an opaque tinted marble.
    if (id === 'ice') {
      mat.transmission = 0.9
      mat.thickness = 0.4
      mat.ior = 1.5
    }
    mat.needsUpdate = true
  }

  /** Sync the bead crack shader's coating-branch flags to a coating id.
   *  Foil and tube share a tear model (same as on the slime), so both
   *  flip uCoatingIsFoil. Any non-cracking coating ('none') also turns
   *  the master damage-enabled flag off so the fragment shader early-
   *  exits the crack pass entirely. */
  private updateBeadCrackUniforms(id: CoatingId) {
    const cracks =
      id === 'wax' ||
      id === 'thinwax' ||
      id === 'ice' ||
      id === 'foil' ||
      id === 'tube'
    this.beadDamageEnabledUniform.value = cracks ? 1.0 : 0.0
    this.beadIsWaxUniform.value =
      id === 'wax' || id === 'thinwax' ? 1.0 : 0.0
    this.beadIsIceUniform.value = id === 'ice' ? 1.0 : 0.0
    this.beadIsFoilUniform.value =
      id === 'foil' || id === 'tube' ? 1.0 : 0.0
    this.beadIsTubeUniform.value = id === 'tube' ? 1.0 : 0.0
  }

  /** Ensure damage / crackLevel / wasPressed arrays are sized to fit
   *  `n` beads. Growth zero-fills so newly appearing beads start
   *  uncracked; shrinkage is a no-op — we simply ignore trailing
   *  entries when writing to the per-slot attributes. */
  private ensureDamageCapacity(n: number) {
    if (this.beadDamage.length >= n) return
    const grow = (a: Float32Array) => {
      const b = new Float32Array(n)
      b.set(a)
      return b
    }
    const growVec3 = (a: Float32Array) => {
      const b = new Float32Array(n * 3)
      b.set(a)
      return b
    }
    const growU8 = (a: Uint8Array) => {
      const b = new Uint8Array(n)
      b.set(a)
      return b
    }
    this.beadDamage = grow(this.beadDamage)
    this.beadCrackLevel = grow(this.beadCrackLevel)
    this.beadWasPressed = growU8(this.beadWasPressed)
    this.beadPressPoint = growVec3(this.beadPressPoint)
    this.beadSquish = grow(this.beadSquish)
  }

  /** Reset all per-bead damage state — called externally when the
   *  user hits reset or explicitly clears the slime. Sizes stay put
   *  so callers don't need to reallocate on next update. Also zeroes
   *  the per-slot instanced attributes so any lingering crack pattern
   *  from a previous configuration clears immediately, without
   *  waiting for the next press to trigger an upload. */
  /** Aggregate crack progress across every bead's coating in 0..1.
   *  Returns 0 when the layer isn't running a crackable coating,
   *  matching SlimeSphere.coatingCrackProgress so the caller can
   *  gate coating loop sounds uniformly. */
  get coatingCrackProgress(): number {
    const id = this.currentCoatingId
    let cap = 0
    if (id === 'ice') cap = 3
    else if (
      id === 'wax' ||
      id === 'thinwax' ||
      id === 'foil' ||
      id === 'tube'
    )
      cap = 5
    else return 0
    const cl = this.beadCrackLevel
    const n = this.lastEffectiveCount
    if (n <= 0) return 0
    let sum = 0
    for (let i = 0; i < n; i++) sum += cl[i] ?? 0
    const max = n * cap
    return max > 0 ? sum / max : 0
  }

  resetDamage() {
    this.beadDamage.fill(0)
    this.beadCrackLevel.fill(0)
    this.beadWasPressed.fill(0)
    this.beadPressPoint.fill(0)
    this.beadSquish.fill(0)
    for (const slot of this.slots) {
      ;(slot.damageAttr.array as Float32Array).fill(0)
      ;(slot.crackLevelAttr.array as Float32Array).fill(0)
      ;(slot.pressPointAttr.array as Float32Array).fill(0)
      slot.damageAttr.needsUpdate = true
      slot.crackLevelAttr.needsUpdate = true
      slot.pressPointAttr.needsUpdate = true
    }
  }

  /** Register up to 4 photos to be printed on the existing beads. The
   *  bead pool is split evenly across the ACTIVE photo slots so 1 photo
   *  covers every bead, 2 photos each cover half, 3 cover thirds, etc.
   *  Non-null entries in `photos` count as active — null slots are
   *  ignored so users can remove a middle slot without collapsing the
   *  quadrant indices assigned to the others (quadrant = slot index
   *  in `photos`, not "nth active"). */
  setPhotos(photos: readonly (THREE.Texture | null)[]) {
    // Cap to 4 slots (2×2 atlas). Extra entries are ignored.
    const next: (THREE.Texture | null)[] = [null, null, null, null]
    for (let i = 0; i < Math.min(photos.length, 4); i++) {
      next[i] = photos[i]
    }
    this.currentPhotos = next
    this.rebuildPhotoAtlas()
    this.assignPhotoQuadrants()
  }

  /** Rebuild the 2×2 photo atlas from currentPhotos. Empty quadrants
   *  stay transparent (never sampled since aPhotoQuadrant ≥ 0 gates
   *  the branch). Called on every setPhotos change; the previous
   *  atlas texture is disposed to keep GPU memory bounded. */
  private rebuildPhotoAtlas() {
    if (this.beadPhotoAtlas) {
      this.beadPhotoAtlas.dispose()
      this.beadPhotoAtlas = null
      this.beadPhotoAtlasUniform.value = null
    }
    const anyPhoto = this.currentPhotos.some((t) => t !== null)
    if (!anyPhoto) {
      this.beadPhotoUseUniform.value = 0.0
      return
    }
    // 1024×1024 canvas = 512² per quadrant. Matches loadPhotoTexture
    // in SlimeApp — no upscaling needed and keeps GPU upload small.
    const TILE = 512
    const canvas = document.createElement('canvas')
    canvas.width = TILE * 2
    canvas.height = TILE * 2
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      this.beadPhotoUseUniform.value = 0.0
      return
    }
    // Fill transparent — reveals through where no photo was placed.
    ctx.clearRect(0, 0, TILE * 2, TILE * 2)
    for (let i = 0; i < 4; i++) {
      const tex = this.currentPhotos[i]
      if (!tex) continue
      const src = (tex as THREE.CanvasTexture).image as
        | HTMLCanvasElement
        | HTMLImageElement
        | undefined
      if (!src) continue
      const qx = i % 2
      const qy = Math.floor(i / 2)
      ctx.drawImage(src, qx * TILE, qy * TILE, TILE, TILE)
    }
    const atlas = new THREE.CanvasTexture(canvas)
    atlas.colorSpace = THREE.SRGBColorSpace
    atlas.needsUpdate = true
    this.beadPhotoAtlas = atlas
    this.beadPhotoAtlasUniform.value = atlas
    this.beadPhotoUseUniform.value = 1.0
  }

  /** Assign each active bead to one of the currently occupied photo
   *  quadrants (round-robin split so N photos = 1/N of the beads
   *  each). Beads outside the active pool keep aPhotoQuadrant = -1
   *  so the shader's early-out skips them. */
  private assignPhotoQuadrants() {
    // Build the list of occupied quadrant indices (0..3) so 반띵 logic
    // works even when the middle slots are empty (e.g. photos in
    // slots 0 and 2 only → beads alternate between quadrants 0 and 2).
    const occupied: number[] = []
    for (let i = 0; i < 4; i++) {
      if (this.currentPhotos[i] !== null) occupied.push(i)
    }
    const N = occupied.length
    // Total active beads across all slots = sum of slot.count. Use
    // the running global index (i) to distribute quadrants; beads in
    // each slot compute their local index via i / slotCount.
    let totalActive = 0
    for (const slot of this.slots) totalActive += slot.count
    // Wipe every slot's array back to -1 before assignment so beads
    // beyond effectiveCount stay marked as "no photo" from prior
    // configurations that had more beads.
    for (const slot of this.slots) {
      ;(slot.photoQuadrantAttr.array as Float32Array).fill(-1)
      slot.photoQuadrantAttr.needsUpdate = true
    }
    if (N === 0 || totalActive === 0) return
    // Match the same interleave rule setConfig uses: bead i lives in
    // slot (i % slotCount) at position floor(i / slotCount). Walk
    // the same schedule so each bead's global rank matches its
    // physical position on the slime.
    const slotCount = this.slots.length
    if (slotCount === 0) return
    const perSlotCursor = new Array(slotCount).fill(0)
    for (let i = 0; i < totalActive; i++) {
      const slotIdx = i % slotCount
      const slot = this.slots[slotIdx]
      const localIdx = perSlotCursor[slotIdx]++
      if (localIdx >= slot.count) continue
      // Even split — bead i is in bucket floor(i * N / totalActive).
      const bucket = Math.min(
        N - 1,
        Math.floor((i * N) / totalActive)
      )
      const quadrant = occupied[bucket]
      ;(slot.photoQuadrantAttr.array as Float32Array)[localIdx] = quadrant
    }
    for (const slot of this.slots) slot.photoQuadrantAttr.needsUpdate = true
  }

  /** Accumulate press damage on each chunk bead based on distance from
   *  press tips this frame. Rising-edge of press also bumps
   *  crackLevel for wax / ice coatings, mirroring the slime's crack
   *  propagation gating (minus propagation itself — each bead is a
   *  single point, no neighbours to spread to). Requires that
   *  update() has already been called this frame so this.colPos
   *  holds each bead's resolved position — SlimeApp calls damage AFTER
   *  update() in the animation loop for that reason. */
  applyPressDamage(tips: readonly WeightedTip[], dt: number) {
    // Reset the per-frame press force accumulator FIRST so any early
    // return below zeroes it out — sound routing reads this uniform
    // every frame, and leaving a stale value from a previous frame
    // (e.g. when SlimeApp passes an empty tips list to gate a locked
    // coated ball) would keep the coating hiss playing even though
    // no damage is accumulating. Empty tips → zero press force →
    // silent coating channel.
    this._pressForceThisFrame = 0
    if (this.currentCoatingId === 'none') return
    if (this.config.combo !== 'chunk') return
    if (tips.length === 0) return
    let n = 0
    for (const s of this.slots) n += s.count
    if (n === 0) return
    this.ensureDamageCapacity(n)

    // Slow damage accumulation so cracks GROW over sustained presses
    // rather than saturating in a single frame. Rising-edge bumps
    // (below) carry most of the per-press progression; the continuous
    // rate adds gentle growth while a press is held.
    const damageRate = 0.3
    // Angular alignment threshold — tips are on the sphere SURFACE
    // (radius ~1 in slime-local space) while chunk beads sit sunk
    // INSIDE the slime (radius ~1 − size). Euclidean distance
    // between them is always ≥ the sink depth, so a plain radius
    // check misses most presses that visually land on a bead. An
    // angular check ignores the sink offset and just asks "is the
    // press pointing at this bead?" — dot(tipDir, beadDir) > 0.5
    // ≈ a 60° cone around each bead, generous enough that any
    // finger touching the bead's visible silhouette counts.
    const angleCosThreshold = 0.5

    // Precompute per-bead unit direction from origin — used both by
    // the tip→bead nearest-neighbour lookup and by the per-bead press
    // application loop below.
    const beadDirs = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      const bx = this.colPos[i * 3]
      const by = this.colPos[i * 3 + 1]
      const bz = this.colPos[i * 3 + 2]
      const beadLen = Math.sqrt(bx * bx + by * by + bz * bz) || 1
      beadDirs[i * 3] = bx / beadLen
      beadDirs[i * 3 + 1] = by / beadLen
      beadDirs[i * 3 + 2] = bz / beadLen
    }

    // TIP-FIRST assignment: for each tip, find the SINGLE closest
    // bead (highest dot with tip direction) and route this tip's
    // force to that bead only. Prevents one finger tap from
    // squishing every bead inside a 60° cone — each tip picks a
    // winner. Beads targeted by multiple tips still accumulate all
    // their forces.
    const perBeadForce = new Float32Array(n)
    const perBeadBestForce = new Float32Array(n)
    const perBeadPress = new Float32Array(n * 3)
    // 속비즈 preset: single bead centred at slime origin. Its "direction
    // from origin" is undefined so the angular routing below can never
    // match it — any tip that landed on the outer slime this frame is
    // treated as pressing the buried ball. The old radius gate required
    // the tip to sit inside a (size + 0.15) sphere around origin, but
    // fingertips ride the slime SURFACE (~1.0 from origin) and almost
    // never dip into that inner sphere — the ball's coating would then
    // never receive damage and never visibly crack.
    const singleCenteredBead =
      n === 1 &&
      this.colPos[0] === 0 &&
      this.colPos[1] === 0 &&
      this.colPos[2] === 0
    for (const t of tips) {
      const tipLen = Math.sqrt(
        t.pos.x * t.pos.x + t.pos.y * t.pos.y + t.pos.z * t.pos.z
      ) || 1
      const tdx = t.pos.x / tipLen
      const tdy = t.pos.y / tipLen
      const tdz = t.pos.z / tipLen
      let bestIdx = -1
      let bestDot = angleCosThreshold
      if (singleCenteredBead) {
        bestIdx = 0
        bestDot = 1.0
      } else {
        for (let i = 0; i < n; i++) {
          const dot =
            tdx * beadDirs[i * 3] +
            tdy * beadDirs[i * 3 + 1] +
            tdz * beadDirs[i * 3 + 2]
          if (dot > bestDot) {
            bestDot = dot
            bestIdx = i
          }
        }
      }
      if (bestIdx < 0) continue
      // Smooth cone falloff — dead-centre press hits full weight,
      // tapering to 0 at the cone edge.
      const falloff =
        (bestDot - angleCosThreshold) / (1.0 - angleCosThreshold)
      const thisForce = t.weight * falloff
      perBeadForce[bestIdx] += thisForce
      if (thisForce > perBeadBestForce[bestIdx]) {
        perBeadBestForce[bestIdx] = thisForce
        const bx = this.colPos[bestIdx * 3]
        const by = this.colPos[bestIdx * 3 + 1]
        const bz = this.colPos[bestIdx * 3 + 2]
        const dx = t.pos.x - bx
        const dy = t.pos.y - by
        const dz = t.pos.z - bz
        const dlen = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1
        perBeadPress[bestIdx * 3] = dx / dlen
        perBeadPress[bestIdx * 3 + 1] = dy / dlen
        perBeadPress[bestIdx * 3 + 2] = dz / dlen
      }
    }
    // Sum across all beads for external gating (coating sound
    // shouldn't play if no tip landed on any bead this frame).
    let totalForce = 0
    for (let i = 0; i < n; i++) totalForce += perBeadForce[i]
    this._pressForceThisFrame = totalForce

    for (let i = 0; i < n; i++) {
      const localForce = perBeadForce[i]
      const bestForce = perBeadBestForce[i]
      const bestPdx = perBeadPress[i * 3]
      const bestPdy = perBeadPress[i * 3 + 1]
      const bestPdz = perBeadPress[i * 3 + 2]
      // Update stored press point. First press snaps; subsequent
      // presses LERP so the tear origin drifts smoothly as the
      // finger moves rather than jumping around.
      if (bestForce > 0) {
        const px = this.beadPressPoint[i * 3]
        const py = this.beadPressPoint[i * 3 + 1]
        const pz = this.beadPressPoint[i * 3 + 2]
        const alreadyPressed = px * px + py * py + pz * pz > 0.01
        if (!alreadyPressed) {
          this.beadPressPoint[i * 3] = bestPdx
          this.beadPressPoint[i * 3 + 1] = bestPdy
          this.beadPressPoint[i * 3 + 2] = bestPdz
        } else {
          const lerp = 0.1
          let nx = px * (1 - lerp) + bestPdx * lerp
          let ny = py * (1 - lerp) + bestPdy * lerp
          let nz = pz * (1 - lerp) + bestPdz * lerp
          const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1
          this.beadPressPoint[i * 3] = nx / nlen
          this.beadPressPoint[i * 3 + 1] = ny / nlen
          this.beadPressPoint[i * 3 + 2] = nz / nlen
        }
      }
      // 속비즈 (single centred bead) receives EVERY tip's full weight
      // (routing bypasses the angular check and uses falloff = 1.0).
      // Scale accumulation down for this case so one touch only nicks
      // the coating, matching slime foil's "small tear at press site"
      // behaviour. Rising-edge bump kept large enough that a FIRST
      // tap immediately crosses the shader's visibility threshold.
      const damageScale = singleCenteredBead ? 0.35 : 1.0
      const edgeBumpScale = singleCenteredBead ? 0.6 : 1.0
      if (localForce > 0) {
        const d = this.beadDamage[i] + localForce * dt * damageRate * damageScale
        this.beadDamage[i] = d < 1 ? d : 1
        const squishRate = 4.0
        const squishMax = 0.45
        const s = this.beadSquish[i] + localForce * dt * squishRate
        this.beadSquish[i] = s < squishMax ? s : squishMax
      }
      // Rising-edge press step — each distinct press bumps damage by
      // ~0.12 (so 6-7 quick presses saturate at 1.0), giving every
      // tap a clearly-visible crack widening even before the slow
      // continuous rate has time to add up. Same treatment slime's
      // coating uses — both taps and long-press accumulate damage
      // naturally.
      const wasPressed = this.beadWasPressed[i] === 1
      if (!wasPressed && localForce > 0.05) {
        this.beadDamage[i] = Math.min(
          1,
          this.beadDamage[i] + 0.12 * edgeBumpScale
        )
        this.beadWasPressed[i] = 1
      } else if (wasPressed && localForce < 0.01) {
        this.beadWasPressed[i] = 0
      }
    }
    this.uploadPerSlotDamage(n)
  }

  /** Push updated damage / crackLevel values from the global-index
   *  arrays into each slot's per-instance InstancedBufferAttribute.
   *  Mirrors the (i % slotCount, perSlotCursor) mapping used for
   *  matrix + colour uploads in update(). */
  private uploadPerSlotDamage(n: number) {
    const slotCount = this.slots.length
    if (slotCount === 0) return
    const perSlotCursor = new Array(slotCount).fill(0)
    for (let i = 0; i < n; i++) {
      const slotIdx = i % slotCount
      const localIdx = perSlotCursor[slotIdx]++
      const slot = this.slots[slotIdx]
      slot.damageAttr.setX(localIdx, this.beadDamage[i])
      slot.crackLevelAttr.setX(localIdx, this.beadCrackLevel[i])
      slot.pressPointAttr.setXYZ(
        localIdx,
        this.beadPressPoint[i * 3],
        this.beadPressPoint[i * 3 + 1],
        this.beadPressPoint[i * 3 + 2]
      )
    }
    for (const slot of this.slots) {
      slot.damageAttr.needsUpdate = true
      slot.crackLevelAttr.needsUpdate = true
      slot.pressPointAttr.needsUpdate = true
    }
  }

  setConfig(
    config: BeadsConfig,
    unitDirs: Float32Array,
    restPositions: Float32Array,
    slimeShape: ShapeId = 'sphere'
  ) {
    // Empty shapes = nothing to render. Drop all slots and return early;
    // the layer is effectively disabled until the user picks at least one.
    const shapes: readonly BeadShapeId[] =
      config.shapes.length > 0 ? config.shapes : ['sphere']
    this.syncSlots(shapes)
    // Capture old-config comparisons BEFORE overwriting this.config —
    // downstream reset logic needs to know if combo / size / count /
    // shapes changed.
    const prevCombo = this.config.combo
    const prevSize = this.config.size
    const prevCount = this.config.count
    const prevShapesKey = this.config.shapes.join(',')
    this.config = { ...config, colors: [...config.colors] }

    // Re-apply base material + coating together when EITHER changes. The
    // additive coating params (extraMetalness / extraRoughness etc.)
    // stack on top of the base, so we always reset the base first and
    // then layer the coating — otherwise switching coating without
    // resetting would keep piling extras on the previous coating's state.
    //
    // When a coating is active, the bead's BASE material switches from
    // the bead-specific presets (plastic / crystal) to the SLIME's
    // current surface params so the coated bead reads as a piece of
    // slime — same roughness / transmission / sheen — with the coating
    // shell layered on top, matching the slime's own coated look. When
    // no coating is active, we fall back to the bead material presets.
    const materialOrCoatingChanged =
      config.material !== this.currentMaterialId ||
      config.coating !== this.currentCoatingId
    if (materialOrCoatingChanged && this.beadMaterial) {
      this.applyBeadBaseParams(this.beadMaterial, config)
      this.applyBeadCoatingParams(this.beadMaterial, config.coating)
      this.currentMaterialId = config.material
      this.currentCoatingId = config.coating
    }
    // Sync crack-shader coating flags every setConfig (cheap uniform
    // assignment). Reset damage arrays whenever coating turns off,
    // combo switches, or size changes — bead anchor points depend on
    // combo/count so keeping stale damage against a new layout would
    // pin cracks to arbitrary beads.
    // Any of combo / size / count / shape changing reshuffles bead
    // anchor positions, so keeping stale damage would pin cracks to
    // beads at new arbitrary locations. Reset in that case (plus
    // whenever coating turns off).
    const layoutChanged =
      config.combo !== prevCombo ||
      config.size !== prevSize ||
      config.count !== prevCount ||
      config.shapes.join(',') !== prevShapesKey
    this.updateBeadCrackUniforms(config.coating)
    // Coating tint — independent from the bead colour. When a coating is
    // active, always paint the shell (fallback to white when no colour
    // picked so the coating is visible and cracks show against a shell
    // instead of collapsing to raw bead colour everywhere). thinwax uses
    // the same 0.72 translucent overlay as the outer slime's thinwax so
    // the ball's inner colour shows through; wax paints fully opaque.
    // Inner-slime coating tints go through the `ic:` adjustment namespace
    // so they stay independent from outer-slime and wax-coating tunes.
    // Regular bead layers don't expose a coating colour picker so they
    // fall through with the same helper — no coatingColors on them
    // means the map yields an empty array.
    const coatingColorHexes = (config.coatingColors ?? []).map((id) =>
      this.useSlimeMaterials
        ? resolveInnerCoatingHex(id, this.currentColorAdjustments)
        : resolveColorHex(id, this.currentColorAdjustments)
    )
    if (config.coating !== 'none') {
      // Ball's coating tint is a single RGB (no LUT sampling on the
      // bead shader yet), so multi-colour coating picks blend into one
      // average tint — at least the picked palette visibly influences
      // the coating instead of only the first colour taking effect.
      let hex = 0xffffff
      if (coatingColorHexes.length === 1) {
        hex = coatingColorHexes[0]
      } else if (coatingColorHexes.length > 1) {
        let r = 0
        let g = 0
        let b = 0
        for (const h of coatingColorHexes) {
          r += (h >> 16) & 0xff
          g += (h >> 8) & 0xff
          b += h & 0xff
        }
        const n = coatingColorHexes.length
        r = Math.round(r / n)
        g = Math.round(g / n)
        b = Math.round(b / n)
        hex = (r << 16) | (g << 8) | b
      }
      this.beadCoatingTintUniform.value.setHex(hex)
      const firstCoatingIsWhite =
        (config.coatingColors ?? [])[0] === 'white'
      // 씬왁스 (thinwax) always renders translucent regardless of colour
      // (thin coat = translucent by definition); 왁스 (wax) picks the
      // translucent shell only when the coating colour is white and
      // otherwise paints a solid opaque shell; 글레이즈 (ice) paints a
      // semi-transparent crystal wash regardless of colour so the
      // ball's material shows through the glaze.
      if (config.coating === 'thinwax') {
        this.beadCoatingAlphaUniform.value = 0.30
      } else if (config.coating === 'wax') {
        this.beadCoatingAlphaUniform.value = firstCoatingIsWhite ? 0.80 : 1.0
      } else if (config.coating === 'ice') {
        // 글레이즈 crystal shell — hint of tint over transmission.
        this.beadCoatingAlphaUniform.value = 0.15
      } else {
        this.beadCoatingAlphaUniform.value = 1.0
      }
    } else {
      this.beadCoatingAlphaUniform.value = 0.0
    }
    // Matte-material foam pattern flag — only applies to inner-slime
    // layers (useSlimeMaterials) picking the slime 'matte' material.
    this.beadMaterialIsMatteUniform.value =
      this.useSlimeMaterials && config.material === 'matte' ? 1.0 : 0.0
    // 속비즈 preset — chunk combo + 1 bead lands at slime origin (see
    // update()'s special case), which makes the localized cone in the
    // foil crack shader collapse to a small patch and read like wax.
    // Flag the full-surface tear path so foil/tube behave like the
    // slime coating's own foil.
    this.beadFoilFullSurfaceUniform.value =
      config.combo === 'chunk' && config.count === 1 ? 1.0 : 0.0
    if (config.coating === 'none' || layoutChanged) {
      this.resetDamage()
    }
    // Coated beads carry their own coating shell — the wrap-shell
    // "slime jacket" would sit OUTSIDE that shell and hide both the
    // coating tint and any crack pattern beneath. Hide the wrap
    // whenever coating is active so the coated bead reads as the
    // outermost surface.
    //
    // Multi-colour palettes drive the per-bead gradient shader (see
    // applyInstanceColors), but the wrap material renders as a flat
    // colour — leaving the wrap visible would mask the gradient with
    // a solid tint. So we also drop the wrap whenever a gradient
    // palette is active on chunk beads (inner slime + main chunk),
    // exposing the raw gradient-bead directly.
    const hasGradientPalette =
      config.colors.length >= 2 && config.combo === 'chunk'
    // Inner-slime ball with a multi-colour gradient palette must render
    // OPAQUE regardless of the picked material — a crystal / glossy ball
    // (transmission > 0) would transmit most of the gradient colour
    // through, leaving the ball nearly invisible. Force transmission = 0
    // whenever the gradient is active on an inner-slime layer so the
    // gradient LUT reads cleanly on an opaque bead body.
    // Inner-slime body setup — applied consistently regardless of
    // single vs multi colour so both cases render identically (user
    // asked to unify single-colour rendering with the multi-colour
    // path). Crystal keeps its transmission for the glass look and
    // uses depth-off so the ball renders inside the outer slime; the
    // wrap is hidden for all crystal states (see suppress block below).
    // Non-crystal materials always render opaque with default depth.
    if (this.useSlimeMaterials && this.beadMaterial) {
      if (config.material === 'crystal' || config.material === 'ice') {
        this.beadMaterial.transparent = false
        this.beadMaterial.opacity = 1
        this.beadMaterial.depthWrite = false
        this.beadMaterial.depthTest = false
      } else if (hasGradientPalette) {
        this.beadMaterial.transmission = 0
        this.beadMaterial.thickness = 0
        this.beadMaterial.transparent = false
        this.beadMaterial.opacity = 1
        this.beadMaterial.depthWrite = true
        this.beadMaterial.depthTest = true
      } else {
        this.beadMaterial.transparent = false
        this.beadMaterial.opacity = 1
        this.beadMaterial.depthWrite = true
        this.beadMaterial.depthTest = true
      }
      this.beadMaterial.needsUpdate = true
    }
    // Inner-slime hides the wrap for OPAQUE ball materials (matte /
    // glossy / soft / etc.) since the ball's own body renders visibly.
    // For CRYSTAL and 아이스 inner-slime balls the body is transparent —
    // inside an opaque outer slime it would be invisible without the
    // wrap shell (three.js transmission fails to composite an inner
    // transparent object inside an outer transparent one), so we
    // keep the wrap on and let it tint to the ball's picked colour
    // (see applyInstanceColors). Wrap shell = the "visible glass ball".
    const opaqueBallMaterial =
      this.useSlimeMaterials &&
      config.material !== 'crystal' &&
      config.material !== 'ice'
    // Wrap ("slime jacket") visibility:
    //   Inner-slime opaque material → hide (show the ball's material)
    //   Inner-slime + gradient palette → hide (show the gradient LUT bead)
    //   Any coating → hide (the coating shell IS the outer surface)
    //   Otherwise → wrap visible (compact single / multi-colour AND
    //     chunk all get the slime-jacket look; wrap.color is set from
    //     the slime cache above, never from the bead palette — so the
    //     old "adjusting one bead colour tints every wrap" problem no
    //     longer applies and the wrap can stay on multi-colour compact).
    // Crystal inner-slime ball is exempt from the "hide wrap for
    // gradient" rule too — the wrap is the ball's only visible surface
    // in this case, so hiding it would make the multi-colour crystal
    // ball invisible. It only shows the first palette colour on the
    // wrap (wrap material lacks the gradient LUT hookup), but the ball
    // stays visible.
    // Inner-slime wrap suppression:
    //   Multi-colour non-crystal → hide wrap so body's gradient / per-
    //     instance colours read directly.
    //   Crystal (any colour count) → hide wrap so single ↔ multi-colour
    //     rendering stays consistent (body always renders directly with
    //     depth-off + transmission, no wrap layered on top). User
    //     specifically asked to unify single-colour crystal with the
    //     multi-colour rendering path.
    const suppressForInnerGradient =
      (this.useSlimeMaterials && hasGradientPalette) ||
      (this.useSlimeMaterials && config.material === 'crystal') ||
      (this.useSlimeMaterials && config.material === 'ice')
    for (const slot of this.slots) {
      slot.wrapInstanced.visible =
        !opaqueBallMaterial &&
        config.coating === 'none' &&
        !suppressForInnerGradient
    }

    // Reset gridMode — only the cube-grid branch below turns it back
    // on. Prevents a previous cube-cube layout from lingering after the
    // user swaps to a different combo.
    this.gridMode = false

    // Special case — cube slime + cube-only bead + fill → arrange beads
    // in a face-aligned grid on each of the 6 cube faces instead of
    // Fibonacci-scattering them. Reads as a tight cube-of-cubes rather
    // than a random cluster, which is what a cube-cube combination
    // visually calls for.
    const isCubeGridLayout =
      slimeShape === 'cube' &&
      config.shapes.length === 1 &&
      config.shapes[0] === 'cube' &&
      config.fill

    let effectiveCount: number
    if (isCubeGridLayout) {
      // Slime radius is fixed at 1 (icosphere unit radius); the slime
      // mesh's world scale is applied by SlimeApp via slime.mesh.scale.
      const grid = buildCubeGridLayout(config.size, 1)
      effectiveCount = Math.min(MAX_BEADS, grid.positions.length / 3)
      this.gridPositions = grid.positions.slice(0, effectiveCount * 3)
      // Anchor every grid bead to its nearest mesh vertex so update()
      // can propagate slime deformation to it (delta = current − rest).
      this.gridAnchorIdx = new Uint32Array(effectiveCount)
      this.gridRestAnchor = new Float32Array(effectiveCount * 3)
      const totalVerts = unitDirs.length / 3
      for (let i = 0; i < effectiveCount; i++) {
        const gx = this.gridPositions[i * 3]
        const gy = this.gridPositions[i * 3 + 1]
        const gz = this.gridPositions[i * 3 + 2]
        const len = Math.hypot(gx, gy, gz) || 1
        const dx = gx / len
        const dy = gy / len
        const dz = gz / len
        let best = 0
        let bestDot = -Infinity
        for (let k = 0; k < totalVerts; k++) {
          const d =
            unitDirs[k * 3] * dx +
            unitDirs[k * 3 + 1] * dy +
            unitDirs[k * 3 + 2] * dz
          if (d > bestDot) {
            bestDot = d
            best = k
          }
        }
        this.gridAnchorIdx[i] = best
        this.gridRestAnchor[i * 3] = restPositions[best * 3]
        this.gridRestAnchor[i * 3 + 1] = restPositions[best * 3 + 1]
        this.gridRestAnchor[i * 3 + 2] = restPositions[best * 3 + 2]
      }
      this.gridMode = true
      this.fillMode = false
      // Wipe every other layout's scratch so the update path picks the
      // grid branch and doesn't read stale index / dir arrays.
      this.vertexIndices = []
      this.depthOffsets = new Float32Array(0)
      this.restMagnitudes = new Float32Array(0)
      this.fillVertexIdx = new Uint32Array(0)
      this.fillVertexWeight = new Float32Array(0)
      this.fillDirs = new Float32Array(0)
      this.fillRestMag = new Float32Array(0)
    } else if (config.fill) {
      // Sphere area is 4π and each bead covers π·effR² where effR is the
      // bead's in-plane silhouette radius (torus is 1.4× the base sphere,
      // star is 1.1×, etc). Using the MAX collision radius across every
      // active shape prevents flat shapes from over-packing and
      // interpenetrating on the surface. Sphere-only layouts fall
      // through with the original 4/size² density.
      const maxRadMul = Math.max(
        ...this.slots.map((s) => shapeCollisionRadius(s.shape))
      )
      const effR = config.size * maxRadMul
      const target = Math.ceil((4 * 1.35) / (effR * effR))
      effectiveCount = Math.min(MAX_BEADS, Math.max(64, target))
      this.fillMode = true
      this.buildFillLayout(effectiveCount, unitDirs, restPositions)
      this.vertexIndices = []
      this.depthOffsets = new Float32Array(0)
      this.restMagnitudes = new Float32Array(0)
    } else {
      const totalVerts = unitDirs.length / 3
      effectiveCount = Math.min(config.count, MAX_BEADS, totalVerts)
      this.fillMode = false
      this.vertexIndices = pickIndices(unitDirs, effectiveCount)
      this.buildVertexLayout(this.vertexIndices, restPositions)
      this.fillVertexIdx = new Uint32Array(0)
      this.fillVertexWeight = new Float32Array(0)
      this.fillDirs = new Float32Array(0)
      this.fillRestMag = new Float32Array(0)
    }

    // Assign beads to slots by index modulo shape count: bead i renders
    // with shape (i % slots.length). This interleaves the shapes across
    // the whole slime — sphere/heart/sphere/heart… — instead of grouping
    // each shape into its own hemisphere. Each slot's `count` is how many
    // beads landed on it, which is at most ceil(total/slots.length).
    const perShape = new Array(this.slots.length).fill(0)
    for (let i = 0; i < effectiveCount; i++) perShape[i % this.slots.length]++
    for (let s = 0; s < this.slots.length; s++) {
      this.slots[s].count = perShape[s]
      this.slots[s].instanced.count = perShape[s]
      this.slots[s].wrapInstanced.count = perShape[s]
    }

    // Colour assignment per bead, per combo:
    //   • 1 colour             → every bead solid, that colour.
    //   • 2+ colours + CHUNK   → each of the few big beads paints the
    //     full palette across its OWN surface via the fragment-shader
    //     LUT (uBeadGradientUse = 1). Instance colours forced white so
    //     the shader's sampled gradient reads unmultiplied.
    //   • 2+ colours + COMPACT → each small bead gets a SINGLE colour
    //     sampled from the palette gradient at its own vertical slime
    //     position, so the whole compact layer reads as one big
    //     top-to-bottom gradient across the sphere. Per-bead shader
    //     gradient is a poor read on the tiny compact beads anyway.
    this.lastUnitDirs = unitDirs
    this.lastEffectiveCount = effectiveCount
    this.applyInstanceColors()
    // Re-run photo quadrant assignment now that per-slot counts are
    // final. Changing bead size / count / combo would otherwise leave
    // stale assignments (older bead indices > new count still marked
    // with a quadrant, new beads past the old count still at -1).
    this.assignPhotoQuadrants()
  }

  /** Push HSL deltas that shift each palette colour within its own
   *  family. Cached with the last setConfig args so the colour loop
   *  can rerun without touching bead positions / matrices. */
  setColorAdjustments(adjustments: ColorAdjustments) {
    this.currentColorAdjustments = adjustments
    if (this.slots.length === 0 || this.lastEffectiveCount === 0) return
    this.applyInstanceColors()
  }

  /** Extracted color-assignment loop. Reads from this.config +
   *  cached lastUnitDirs / lastEffectiveCount + this.gridMode /
   *  fillMode / vertexIndices, so it can be called both from
   *  setConfig (initial + count change) and from setColorAdjustments
   *  (delta-only update). */
  private applyInstanceColors() {
    const config = this.config
    const effectiveCount = this.lastEffectiveCount
    const unitDirs = this.lastUnitDirs
    const paletteHex = colorsToHex(
      config.colors.length > 0 ? config.colors : ['pearl'],
      this.currentColorAdjustments
    )
    const paletteColors = paletteHex.map((h) => new THREE.Color(h))
    // Wrap-shell colour: when the user has explicitly picked a
    // palette for THIS bead layer (not just the default pearl),
    // tint the wrap to match so the "slime jacket" reads as the
    // bead's own colour instead of the outer slime's colour. This
    // is what makes inner-slime chunks show up as coloured balls
    // even without any coating.
    // Wrap-shell colour source:
    //   Inner-slime layer (useSlimeMaterials): the wrap IS the ball's
    //     own shell around a buried core, so it tints with the ball's
    //     picked colour when one is set.
    //   Regular bead layers: the wrap is a slime-jacket AROUND each
    //     bead — it should always read as SLIME (not as the bead's
    //     colour). Per the user spec, adjusting bead colours must not
    //     tint the wrap at all — wrap stays locked on the slime cache
    //     colour, and bead colours show only through the wrap's
    //     transparency (crystal slime) or the beads themselves when
    //     the wrap is hidden (compact combo, see below).
    if (this.wrapMaterial) {
      if (this.useSlimeMaterials && paletteColors.length > 0) {
        if (paletteColors.length === 1) {
          this.wrapMaterial.color.copy(paletteColors[0])
        } else {
          // Multi-colour inner-slime with a TRANSPARENT crystal body:
          // the ball body's gradient LUT is invisible through the
          // wrap, so blend palette colours into a single tint for the
          // wrap shell. Users still see the picked palette influence
          // the ball's colour instead of only the first pick.
          let r = 0
          let g = 0
          let b = 0
          for (const c of paletteColors) {
            r += c.r
            g += c.g
            b += c.b
          }
          const n = paletteColors.length
          this.wrapMaterial.color.setRGB(r / n, g / n, b / n)
        }
      } else if (this.slimeSurfaceCache) {
        this.wrapMaterial.color.copy(this.slimeSurfaceCache.color)
      }
    }
    // Per-bead gradient ONLY when user explicitly toggled it on —
    // except for single-centered inner-slime ball, where multi-colour
    // ALWAYS enables the gradient LUT so the palette shows top-to-
    // bottom on the ball automatically. sphereGradient (compact)
    // still requires the toggle.
    const isSingleCenteredInnerBall =
      this.useSlimeMaterials &&
      config.combo === 'chunk' &&
      effectiveCount === 1
    const perBeadShader =
      paletteColors.length >= 2 &&
      config.combo === 'chunk' &&
      (!!config.gradient || isSingleCenteredInnerBall)
    const sphereGradient =
      paletteColors.length >= 2 && !perBeadShader && !!config.gradient
    if (perBeadShader) {
      this.rebuildBeadGradientTexture(paletteHex)
      this.gradientUseUniform.value = 1
      this.gradientSizeUniform.value = config.size
    } else {
      this.gradientUseUniform.value = 0
    }
    const perSlotCursor = new Array(this.slots.length).fill(0)
    for (let i = 0; i < effectiveCount; i++) {
      const s = i % this.slots.length
      const localIdx = perSlotCursor[s]++
      if (perBeadShader) {
        this._color.setRGB(1, 1, 1)
      } else if (sphereGradient) {
        // gridMode (cube slime + cube beads) uses the bead's world Y
        // POSITION on the cube — the face NORMAL collapsed side-face
        // beads to yDir=0 (identical mid-gradient colour). Positions
        // vary from -1..+1 across the cube's vertical extent.
        const yDir = this.gridMode
          ? this.gridPositions[i * 3 + 1]
          : this.fillMode
            ? this.fillDirs[i * 3 + 1]
            : unitDirs[this.vertexIndices[i] * 3 + 1]
        const t = Math.max(0, Math.min(1, (yDir + 1) * 0.5))
        // Smooth gradient — lerp between adjacent palette entries by
        // bead's Y position. sphereGradient is now only reached when
        // config.gradient is on, so this always renders as smooth.
        const scaled = t * (paletteColors.length - 1)
        const lo = Math.floor(scaled)
        const hi = Math.min(lo + 1, paletteColors.length - 1)
        const frac = scaled - lo
        this._color.copy(paletteColors[lo]).lerp(paletteColors[hi], frac)
      } else if (paletteColors.length > 1) {
        // Multi-colour WITHOUT gradient toggle. For a single-instance
        // layer (single-centred inner-slime), plain index-cycle would
        // just pick paletteColors[0] and the picked palette would be
        // invisible on the ball — tags show every colour but the ball
        // shows only one. Blend the palette into an average tint so
        // the palette selection visibly influences the ball colour
        // even without the gradient toggle. Multi-instance layers
        // (chunk / compact) still cycle so each bead reads distinctly.
        if (effectiveCount === 1) {
          let br = 0
          let bg = 0
          let bb = 0
          for (const c of paletteColors) {
            br += c.r
            bg += c.g
            bb += c.b
          }
          const n = paletteColors.length
          this._color.setRGB(br / n, bg / n, bb / n)
        } else {
          this._color.copy(paletteColors[i % paletteColors.length])
        }
      } else {
        this._color.copy(paletteColors[0])
      }
      this.slots[s].instanced.setColorAt(localIdx, this._color)
    }
    for (const slot of this.slots) {
      if (slot.instanced.instanceColor) {
        slot.instanced.instanceColor.needsUpdate = true
      }
    }
  }

  private rebuildBeadGradientTexture(hexes: readonly number[]) {
    if (this.gradientTexture) this.gradientTexture.dispose()
    const size = 64
    const data = new Uint8Array(size * 4)
    const cA = new THREE.Color()
    const cB = new THREE.Color()
    for (let i = 0; i < size; i++) {
      const t = i / (size - 1)
      const scaled = t * (hexes.length - 1)
      const lo = Math.floor(scaled)
      const hi = Math.min(lo + 1, hexes.length - 1)
      const frac = scaled - lo
      cA.setHex(hexes[lo])
      cB.setHex(hexes[hi])
      const r = cA.r * (1 - frac) + cB.r * frac
      const g = cA.g * (1 - frac) + cB.g * frac
      const b = cA.b * (1 - frac) + cB.b * frac
      data[i * 4] = Math.round(r * 255)
      data[i * 4 + 1] = Math.round(g * 255)
      data[i * 4 + 2] = Math.round(b * 255)
      data[i * 4 + 3] = 255
    }
    const tex = new THREE.DataTexture(data, size, 1, THREE.RGBAFormat)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.minFilter = THREE.LinearFilter
    tex.magFilter = THREE.LinearFilter
    tex.wrapS = THREE.ClampToEdgeWrapping
    tex.wrapT = THREE.ClampToEdgeWrapping
    tex.needsUpdate = true
    this.gradientTexture = tex
    this.gradientTexUniform.value = tex
  }

  private buildVertexLayout(
    vertexIndices: number[],
    restPositions: Float32Array
  ) {
    const n = vertexIndices.length
    this.depthOffsets = new Float32Array(n)
    this.restMagnitudes = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const vi = vertexIndices[i]
      this.depthOffsets[i] = hash01(vi * 7 + 13) * 0.12
      const rx = restPositions[vi * 3]
      const ry = restPositions[vi * 3 + 1]
      const rz = restPositions[vi * 3 + 2]
      this.restMagnitudes[i] = Math.hypot(rx, ry, rz)
    }
  }

  private buildFillLayout(
    n: number,
    unitDirs: Float32Array,
    restPositions: Float32Array
  ) {
    this.fillVertexIdx = new Uint32Array(n * 3)
    this.fillVertexWeight = new Float32Array(n * 3)
    this.fillDirs = new Float32Array(n * 3)
    this.fillRestMag = new Float32Array(n)

    const phi = Math.PI * (Math.sqrt(5) - 1)
    const totalVerts = unitDirs.length / 3

    for (let i = 0; i < n; i++) {
      const t = n > 1 ? i / (n - 1) : 0
      const y = 1 - t * 2
      const r = Math.sqrt(Math.max(0, 1 - y * y))
      const theta = phi * i
      const x = Math.cos(theta) * r
      const z = Math.sin(theta) * r

      const i3 = i * 3
      this.fillDirs[i3] = x
      this.fillDirs[i3 + 1] = y
      this.fillDirs[i3 + 2] = z

      // Find the 3 vertices whose rest direction best matches this fib
      // direction. O(V) per bead — done once at config change, not per frame.
      let d0 = -Infinity
      let d1 = -Infinity
      let d2 = -Infinity
      let i0 = 0
      let i1 = 0
      let i2 = 0
      for (let j = 0; j < totalVerts; j++) {
        const dot =
          unitDirs[j * 3] * x +
          unitDirs[j * 3 + 1] * y +
          unitDirs[j * 3 + 2] * z
        if (dot > d0) {
          d2 = d1
          i2 = i1
          d1 = d0
          i1 = i0
          d0 = dot
          i0 = j
        } else if (dot > d1) {
          d2 = d1
          i2 = i1
          d1 = dot
          i1 = j
        } else if (dot > d2) {
          d2 = dot
          i2 = j
        }
      }

      // Sharpened weights: exponentiate the (positive) dot products so the
      // closest vertex dominates but the other two still smooth over the
      // discontinuity as the nearest-vertex assignment changes across the
      // sphere.
      const w0 = Math.pow(Math.max(0, d0), 6)
      const w1 = Math.pow(Math.max(0, d1), 6)
      const w2 = Math.pow(Math.max(0, d2), 6)
      const total = w0 + w1 + w2 || 1
      const nw0 = w0 / total
      const nw1 = w1 / total
      const nw2 = w2 / total

      this.fillVertexIdx[i3] = i0
      this.fillVertexIdx[i3 + 1] = i1
      this.fillVertexIdx[i3 + 2] = i2
      this.fillVertexWeight[i3] = nw0
      this.fillVertexWeight[i3 + 1] = nw1
      this.fillVertexWeight[i3 + 2] = nw2

      const m0 = Math.hypot(
        restPositions[i0 * 3],
        restPositions[i0 * 3 + 1],
        restPositions[i0 * 3 + 2]
      )
      const m1 = Math.hypot(
        restPositions[i1 * 3],
        restPositions[i1 * 3 + 1],
        restPositions[i1 * 3 + 2]
      )
      const m2 = Math.hypot(
        restPositions[i2 * 3],
        restPositions[i2 * 3 + 1],
        restPositions[i2 * 3 + 2]
      )
      this.fillRestMag[i] = nw0 * m0 + nw1 * m1 + nw2 * m2
    }
  }

  reseat(
    unitDirs: Float32Array,
    restPositions: Float32Array,
    slimeShape: ShapeId = 'sphere'
  ) {
    if (this.slots.length === 0) return
    if (!this.config.fill && this.config.count === 0) return
    this.setConfig(this.config, unitDirs, restPositions, slimeShape)
  }

  update(
    currentPositions: Float32Array,
    pressure: number = 0,
    /** Camera position expressed in the SLIME's local frame. When
     *  provided, squished coated chunk beads rotate so their flat
     *  face points at the camera — otherwise a bead sitting on the
     *  side of the slime shows its compression axis edge-on and
     *  reads as smaller rather than flatter. Omit to keep the
     *  original outward-aligned rotation. */
    slimeLocalCameraPos: { x: number; y: number; z: number } | null = null
  ) {
    if (this.slots.length === 0) return
    const size = this.config.size
    // Total bead count = sum of per-slot counts. All bead layouts (fillDirs,
    // vertexIndices) are still indexed 0..n-1 globally; the modulo dispatch
    // routes each global index to the right slot at its LOCAL sub-index.
    let n = 0
    for (const s of this.slots) n += s.count
    if (n === 0) return
    const slotCount = this.slots.length
    const perSlotCursor = new Array(slotCount).fill(0)
    // How much bigger the wrap shell renders around each bead. Small enough
    // that the bead's silhouette stays visible through the transparent
    // slime jacket, big enough that highlights on the wrap read as a
    // distinct coating rather than z-fighting the bead surface.
    const wrapScaleMul = 1.09

    if (this.gridMode) {
      // Cube-face grid — beads render axis-aligned (identity quaternion)
      // so the whole grid reads as a rigid packed cube of cubes. A cube
      // bead sitting at a corner of the layout naturally shows 3 faces
      // toward its outward diagonal WITHOUT any rotation, so
      // setFromUnitVectors would only add visual chaos here. Position
      // includes the local slime deformation delta so kneading still
      // shoves beads around.
      this._quat.identity()
      this._scale.set(size, size, size)
      this._wrapScale.set(
        size * wrapScaleMul,
        size * wrapScaleMul,
        size * wrapScaleMul
      )
      for (let i = 0; i < n; i++) {
        const i3 = i * 3
        const vi = this.gridAnchorIdx[i]
        const dx = currentPositions[vi * 3] - this.gridRestAnchor[i3]
        const dy = currentPositions[vi * 3 + 1] - this.gridRestAnchor[i3 + 1]
        const dz = currentPositions[vi * 3 + 2] - this.gridRestAnchor[i3 + 2]
        this._pos.set(
          this.gridPositions[i3] + dx,
          this.gridPositions[i3 + 1] + dy,
          this.gridPositions[i3 + 2] + dz
        )

        const slotIdx = i % slotCount
        const localIdx = perSlotCursor[slotIdx]++
        const slot = this.slots[slotIdx]
        this._matrix.compose(this._pos, this._quat, this._scale)
        slot.instanced.setMatrixAt(localIdx, this._matrix)
        this._wrapMatrix.compose(this._pos, this._quat, this._wrapScale)
        slot.wrapInstanced.setMatrixAt(localIdx, this._wrapMatrix)
      }
      for (const slot of this.slots) {
        slot.instanced.instanceMatrix.needsUpdate = true
        slot.wrapInstanced.instanceMatrix.needsUpdate = true
      }
      return
    }

    if (this.fillMode) {
      // Three-phase mirror of the vertex-anchored path so bead-bead
      // collision resolves for fill too: compute positions into scratch,
      // push overlapping beads apart, then bake matrices. Collision
      // checks Fibonacci-index neighbours only (offsets ±{1,2,3,5,8,
      // 13,21,34}) because full O(n²) at fill's 10k beads would be
      // prohibitive — those specific offsets cover the 6-8 immediate
      // spatial neighbours of a Fibonacci-sphere point, which is where
      // real overlap happens.
      if (this.colPos.length !== n * 3) {
        this.colPos = new Float32Array(n * 3)
        this.colOut = new Float32Array(n * 3)
        this.colScale = new Float32Array(n * 3)
        this.colMaxLen = new Float32Array(n)
      }

      // Phase 1 — per-bead placement from Fibonacci anchor.
      for (let i = 0; i < n; i++) {
        const i3 = i * 3
        const v0 = this.fillVertexIdx[i3] * 3
        const v1 = this.fillVertexIdx[i3 + 1] * 3
        const v2 = this.fillVertexIdx[i3 + 2] * 3
        const w0 = this.fillVertexWeight[i3]
        const w1 = this.fillVertexWeight[i3 + 1]
        const w2 = this.fillVertexWeight[i3 + 2]

        const dirX = this.fillDirs[i3]
        const dirY = this.fillDirs[i3 + 1]
        const dirZ = this.fillDirs[i3 + 2]

        const m0 = Math.hypot(
          currentPositions[v0],
          currentPositions[v0 + 1],
          currentPositions[v0 + 2]
        )
        const m1 = Math.hypot(
          currentPositions[v1],
          currentPositions[v1 + 1],
          currentPositions[v1 + 2]
        )
        const m2 = Math.hypot(
          currentPositions[v2],
          currentPositions[v2 + 1],
          currentPositions[v2 + 2]
        )
        const surfaceLen = w0 * m0 + w1 * m1 + w2 * m2

        const compression = Math.max(0, this.fillRestMag[i] - surfaceLen)
        const sinkRatio = Math.min(0.35, compression * 0.55)
        const beadLen = surfaceLen * (1 - sinkRatio)

        this.colPos[i3] = dirX * beadLen
        this.colPos[i3 + 1] = dirY * beadLen
        this.colPos[i3 + 2] = dirZ * beadLen
        this.colOut[i3] = dirX
        this.colOut[i3 + 1] = dirY
        this.colOut[i3 + 2] = dirZ
        // Fill beads can drift as far outward as the current slime
        // surface — no extra sink margin here (they sit half-out by
        // design), collision push shouldn't stretch beyond that.
        this.colMaxLen[i] = surfaceLen

        this.colScale[i3] = size
        this.colScale[i3 + 1] = size
        // Fill (꽉비즈) 납작함 — Z axis is aligned with slime outward
        // in phase 3, so shrinking Z flattens the bead into a coin
        // against the slime surface. Formula mirrors 추가비즈 flatness
        // (size * (1 - 0.85 * flatness)); UI caps flatness at 0.55.
        const compactFlatness = Math.max(
          0,
          Math.min(0.55, this.config.flatness ?? 0)
        )
        this.colScale[i3 + 2] = size * (1 - 0.85 * compactFlatness)
      }

      // Phase 2 — Fibonacci-neighbor collision resolution. Skipped for
      // the compact combo entirely — packed compact beads (any shape)
      // ride the slime surface without shoving each other so press
      // dents deform bead positions the same way as the slime beneath.
      // The iterative collision pass on non-sphere shapes was creating
      // a visible "beads pushing each other" jitter under press; users
      // prefer the smooth sphere-like glide over collision-perfect
      // spacing (mild overlap is acceptable on the flat shapes since
      // they're packed at a distance where interpenetration is minimal).
      // Chunk combo still runs collision so big beads separate cleanly.
      const runCollision = this.config.combo !== 'compact'
      const fibOffsets = [1, 2, 3, 5, 8, 13, 21, 34]
      // Per-slot in-plane collision radii — flat shapes (torus / star)
      // need a wider bubble than the base sphere, so a torus bead's
      // 1.4·size outer silhouette can push a neighbour torus far enough
      // that neither one interpenetrates the other on the surface.
      const collisionRadii = this.slots.map(
        (s) => shapeCollisionRadius(s.shape) * size
      )
      for (let iter = 0; iter < 3 && runCollision; iter++) {
        for (let i = 0; i < n; i++) {
          const i3 = i * 3
          const rI = collisionRadii[i % slotCount]
          for (let o = 0; o < fibOffsets.length; o++) {
            const j = i + fibOffsets[o]
            if (j >= n) continue
            const j3 = j * 3
            const dx = this.colPos[j3] - this.colPos[i3]
            const dy = this.colPos[j3 + 1] - this.colPos[i3 + 1]
            const dz = this.colPos[j3 + 2] - this.colPos[i3 + 2]
            const d2 = dx * dx + dy * dy + dz * dz
            const minDist = rI + collisionRadii[j % slotCount]
            const minDist2 = minDist * minDist
            if (d2 >= minDist2 || d2 < 1e-8) continue
            const d = Math.sqrt(d2)
            const push = (minDist - d) * 0.5
            const nx = dx / d
            const ny = dy / d
            const nz = dz / d
            this.colPos[i3] -= nx * push
            this.colPos[i3 + 1] -= ny * push
            this.colPos[i3 + 2] -= nz * push
            this.colPos[j3] += nx * push
            this.colPos[j3 + 1] += ny * push
            this.colPos[j3 + 2] += nz * push
          }
        }
        // Re-clamp to inside slime after each pass so beads don't get
        // shoved past the slime surface by the push.
        for (let i = 0; i < n; i++) {
          const i3 = i * 3
          const px = this.colPos[i3]
          const py = this.colPos[i3 + 1]
          const pz = this.colPos[i3 + 2]
          const l = Math.hypot(px, py, pz)
          const maxL = this.colMaxLen[i]
          if (l > maxL && l > 1e-6) {
            const k = maxL / l
            this.colPos[i3] = px * k
            this.colPos[i3 + 1] = py * k
            this.colPos[i3 + 2] = pz * k
          }
        }
      }

      // Phase 3 — bake resolved positions into matrices.
      for (let i = 0; i < n; i++) {
        const i3 = i * 3
        this._pos.set(this.colPos[i3], this.colPos[i3 + 1], this.colPos[i3 + 2])
        this._outward.set(
          this.colOut[i3],
          this.colOut[i3 + 1],
          this.colOut[i3 + 2]
        )
        this._quat.setFromUnitVectors(this._forward, this._outward)
        this._scale.set(
          this.colScale[i3],
          this.colScale[i3 + 1],
          this.colScale[i3 + 2]
        )

        const slotIdx = i % slotCount
        const localIdx = perSlotCursor[slotIdx]++
        const slot = this.slots[slotIdx]
        this._matrix.compose(this._pos, this._quat, this._scale)
        slot.instanced.setMatrixAt(localIdx, this._matrix)
        this._wrapScale.set(
          this._scale.x * wrapScaleMul,
          this._scale.y * wrapScaleMul,
          this._scale.z * wrapScaleMul
        )
        this._wrapMatrix.compose(this._pos, this._quat, this._wrapScale)
        slot.wrapInstanced.setMatrixAt(localIdx, this._wrapMatrix)
      }
      for (const slot of this.slots) {
        slot.instanced.instanceMatrix.needsUpdate = true
        slot.wrapInstanced.instanceMatrix.needsUpdate = true
      }
      return
    }

    // Vertex-anchored mode (manual count — NOT fill). Beads are pulled
    // fully INSIDE the slime by a base sink of the bead's full radius
    // (plus the wrap-shell's extra 9%), so no bead pokes through the
    // surface. The random depthOffsets and dynamic compression sink
    // ride on top for variety and squish response.
    //
    // Runs in three phases so bead-bead collisions can resolve BEFORE
    // matrices are baked into the InstancedMesh:
    //   1. Compute each bead's target position / normal / scale from the
    //      slime anchor and write into scratch arrays.
    //   2. Relaxation pass — push overlapping beads apart along their
    //      separation direction so kneading actually squeezes them
    //      instead of letting them stack invisibly at the same spot.
    //   3. Compose matrices from resolved positions.
    if (this.colPos.length !== n * 3) {
      this.colPos = new Float32Array(n * 3)
      this.colOut = new Float32Array(n * 3)
      this.colScale = new Float32Array(n * 3)
      this.colMaxLen = new Float32Array(n)
    }
    // Chunk combo lets beads slip tangentially out of compressed
    // regions. Allocate the offset + seed buffers on first use / count
    // change; the seed is one-shot random per bead so each has its own
    // slip direction.
    const isChunk = this.config.combo === 'chunk'
    if (isChunk && this.beadSlipOffset.length !== n * 3) {
      this.beadSlipOffset = new Float32Array(n * 3)
      this.beadSlipSeed = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        this.beadSlipSeed[i] = hash01(i * 41 + 3) * Math.PI * 2
      }
    } else if (!isChunk) {
      this.beadSlipOffset = new Float32Array(0)
      this.beadSlipSeed = new Float32Array(0)
    }

    // Phase 1 — per-bead placement from vertex anchor.
    for (let i = 0; i < n; i++) {
      const vi = this.vertexIndices[i]
      let x = currentPositions[vi * 3]
      let y = currentPositions[vi * 3 + 1]
      let z = currentPositions[vi * 3 + 2]

      const len = Math.hypot(x, y, z) || 1
      const compression = Math.max(0, this.restMagnitudes[i] - len)
      const dynSinkRatio = Math.min(0.35, compression * 0.55)
      const baseSink = size * 1.09
      const rawSink = baseSink + this.depthOffsets[i] + len * dynSinkRatio
      const maxLen = Math.max(0, len - size * 0.2)
      const totalSink = Math.min(rawSink, maxLen)
      if (totalSink > 0) {
        const s = Math.max(0, 1 - totalSink / len)
        x *= s
        y *= s
        z *= s
      }

      const i3 = i * 3
      // Chunk beads slip TANGENTIALLY out of a pressed region: local
      // compression at the anchor vertex kicks a persistent tangent
      // offset in a per-bead random direction, which decays back to
      // zero when the press ends. Compact and other combos skip this
      // and just snap to the anchor.
      let posX = x
      let posY = y
      let posZ = z
      if (isChunk) {
        // Outward at the (post-sink) anchor for tangent basis.
        const oLen = Math.hypot(x, y, z) || 1
        const outX = x / oLen
        const outY = y / oLen
        const outZ = z / oLen
        // Cross with world-Y for tangent-1; fall back to world-X near
        // the poles so the basis stays orthonormal everywhere.
        let uX: number
        let uY: number
        let uZ: number
        if (Math.abs(outY) < 0.9) {
          uX = outZ
          uY = 0
          uZ = -outX
        } else {
          uX = 1
          uY = 0
          uZ = 0
        }
        const uLen = Math.hypot(uX, uY, uZ) || 1
        uX /= uLen
        uY /= uLen
        uZ /= uLen
        const vX = outY * uZ - outZ * uY
        const vY = outZ * uX - outX * uZ
        const vZ = outX * uY - outY * uX
        // Slip direction — combines this bead's seed with a slow global
        // rotation so the slip path curves instead of running straight.
        const timeOffset =
          (typeof performance !== 'undefined'
            ? performance.now()
            : Date.now()) * 0.0005
        const seed = this.beadSlipSeed[i] + timeOffset
        const t1 = Math.cos(seed)
        const t2 = Math.sin(seed)
        const kickX = t1 * uX + t2 * vX
        const kickY = t1 * uY + t2 * vY
        const kickZ = t1 * uZ + t2 * vZ
        // Kick fires ONLY when the user is actively pressing this
        // frame (pressure > 0) AND this bead's vertex is compressed.
        // The pressure gate stops idle physics oscillation from
        // triggering slip when nothing's being pressed. Decay always
        // runs so previous impulses bleed off after press ends.
        const decay = 0.92
        this.beadSlipOffset[i3] *= decay
        this.beadSlipOffset[i3 + 1] *= decay
        this.beadSlipOffset[i3 + 2] *= decay
        if (pressure > 0.5 && compression > 0.01) {
          const strength = compression * 0.35
          this.beadSlipOffset[i3] += kickX * strength
          this.beadSlipOffset[i3 + 1] += kickY * strength
          this.beadSlipOffset[i3 + 2] += kickZ * strength
        }
        // Cap total slip so a bead can't drift beyond ~one radius from
        // its anchor — otherwise sustained press would launch it
        // across the slime.
        const maxSlip = size * 1.5
        const sm2 =
          this.beadSlipOffset[i3] * this.beadSlipOffset[i3] +
          this.beadSlipOffset[i3 + 1] * this.beadSlipOffset[i3 + 1] +
          this.beadSlipOffset[i3 + 2] * this.beadSlipOffset[i3 + 2]
        if (sm2 > maxSlip * maxSlip) {
          const scale = maxSlip / Math.sqrt(sm2)
          this.beadSlipOffset[i3] *= scale
          this.beadSlipOffset[i3 + 1] *= scale
          this.beadSlipOffset[i3 + 2] *= scale
        }
        posX += this.beadSlipOffset[i3]
        posY += this.beadSlipOffset[i3 + 1]
        posZ += this.beadSlipOffset[i3 + 2]
      }
      // Special case — 속비즈 preset (chunk combo with exactly 1 bead)
      // anchors the single bead at the slime's ORIGIN so it sits fully
      // embedded in the middle of the volume. Skipped for layers with
      // `alwaysSurface: true` (inner slime), where the ball sits on
      // the surface and the outer slime taffy-wraps around it.
      if (n === 1 && isChunk && !this.alwaysSurface) {
        posX = 0
        posY = 0
        posZ = 0
      }
      this.colPos[i3] = posX
      this.colPos[i3 + 1] = posY
      this.colPos[i3 + 2] = posZ
      const posLen = Math.hypot(posX, posY, posZ) || 1
      this.colOut[i3] = posX / posLen
      this.colOut[i3 + 1] = posY / posLen
      this.colOut[i3 + 2] = posZ / posLen
      this.colMaxLen[i] = maxLen

      // Coated chunk beads: local Z (aligned outward after
      // setFromUnitVectors below) compresses under press. The bead
      // KEEPS its original XY diameter (no lateral bulge that would
      // read as an elongated ellipse) — it just gets thinner along
      // the press axis. Squish PERSISTS: once pressed flat it stays
      // flat until the layer is reset, matching the permanent damage
      // model of the crack pass.
      // 속비즈 (single centred bead) skips the squish scaling — the
      // bead is fully embedded inside the slime, so pressing the
      // slime shouldn't flatten the bead itself (it would look
      // like the bead is deforming inside the slime volume, not
      // being pressed). Only the coating tears; the bead stays
      // uniformly round.
      const isSingleCenteredBead =
        n === 1 &&
        this.colPos[0] === 0 &&
        this.colPos[1] === 0 &&
        this.colPos[2] === 0
      // Inner-slime cases where the wrap is suppressed (multi-colour
      // OR any crystal): inflate the body up by the wrap scale
      // multiplier so the ball's apparent size matches the wrap-
      // visible cases, preserving size consistency across colour /
      // material toggles.
      const wrapSuppressedHere =
        this.useSlimeMaterials &&
        isChunk &&
        this.config.combo === 'chunk' &&
        this.config.coating === 'none' &&
        (this.config.colors.length >= 2 ||
          this.config.material === 'crystal')
      const inflateForNoWrap = wrapSuppressedHere ? 1.09 : 1
      if (
        isChunk &&
        !isSingleCenteredBead &&
        this.currentCoatingId !== 'none' &&
        i < this.beadSquish.length
      ) {
        // Floor at 0.55 — even at max squish the bead keeps at
        // least 55% of its original height, so it still reads as a
        // recognisable bead rather than a thin disc.
        const flat = Math.max(0.55, 1 - this.beadSquish[i])
        this.colScale[i3] = size * inflateForNoWrap
        this.colScale[i3 + 1] = size * inflateForNoWrap
        this.colScale[i3 + 2] = size * inflateForNoWrap * flat
      } else {
        this.colScale[i3] = size * inflateForNoWrap
        this.colScale[i3 + 1] = size * inflateForNoWrap
        this.colScale[i3 + 2] = size * inflateForNoWrap
      }
    }
    // Phase 2 — bead-bead collision relaxation. O(n²) per iteration,
    // trivial for the vertex-anchored max of ~200 beads. Push apart by
    // half the overlap on each side; three iterations converge well
    // enough that stacked beads visibly spread out under compression.
    // Per-slot in-plane radii let flat shapes (torus / star) claim the
    // wider bubble they need to avoid interpenetrating each other.
    const collisionRadii = this.slots.map(
      (s) => shapeCollisionRadius(s.shape) * size
    )
    for (let iter = 0; iter < 3; iter++) {
      for (let i = 0; i < n; i++) {
        const i3 = i * 3
        const rI = collisionRadii[i % slotCount]
        for (let j = i + 1; j < n; j++) {
          const j3 = j * 3
          const dx = this.colPos[j3] - this.colPos[i3]
          const dy = this.colPos[j3 + 1] - this.colPos[i3 + 1]
          const dz = this.colPos[j3 + 2] - this.colPos[i3 + 2]
          const d2 = dx * dx + dy * dy + dz * dz
          const minDist = rI + collisionRadii[j % slotCount]
          const minDist2 = minDist * minDist
          if (d2 >= minDist2 || d2 < 1e-8) continue
          const d = Math.sqrt(d2)
          const push = (minDist - d) * 0.5
          const nx = dx / d
          const ny = dy / d
          const nz = dz / d
          this.colPos[i3] -= nx * push
          this.colPos[i3 + 1] -= ny * push
          this.colPos[i3 + 2] -= nz * push
          this.colPos[j3] += nx * push
          this.colPos[j3 + 1] += ny * push
          this.colPos[j3 + 2] += nz * push
        }
      }
      // Re-clamp to inside slime after each pass — collision push might
      // move a bead radially outward past the surface; pull it back.
      for (let i = 0; i < n; i++) {
        const i3 = i * 3
        const px = this.colPos[i3]
        const py = this.colPos[i3 + 1]
        const pz = this.colPos[i3 + 2]
        const l = Math.hypot(px, py, pz)
        const maxL = this.colMaxLen[i]
        if (l > maxL && l > 1e-6) {
          const k = maxL / l
          this.colPos[i3] = px * k
          this.colPos[i3 + 1] = py * k
          this.colPos[i3 + 2] = pz * k
        }
      }
    }
    // Phase 3 — bake resolved positions into InstancedMesh matrices.
    const coatedSquish =
      isChunk &&
      this.currentCoatingId !== 'none' &&
      slimeLocalCameraPos !== null
    for (let i = 0; i < n; i++) {
      const i3 = i * 3
      this._pos.set(this.colPos[i3], this.colPos[i3 + 1], this.colPos[i3 + 2])
      // For coated chunk beads, align the bead's local +Z axis with
      // the direction from the bead centre TO THE CAMERA instead of
      // the outward-from-origin axis. The Z compression then
      // flattens the bead along the view direction, keeping the
      // flat face visible from the camera regardless of which side
      // of the slime the bead sits on. Uncoated beads (no
      // slimeLocalCameraPos passed in) keep the original outward
      // alignment so wrap-shell physics stay consistent.
      if (coatedSquish && slimeLocalCameraPos) {
        const dx = slimeLocalCameraPos.x - this.colPos[i3]
        const dy = slimeLocalCameraPos.y - this.colPos[i3 + 1]
        const dz = slimeLocalCameraPos.z - this.colPos[i3 + 2]
        const dlen = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1
        this._outward.set(dx / dlen, dy / dlen, dz / dlen)
      } else {
        this._outward.set(
          this.colOut[i3],
          this.colOut[i3 + 1],
          this.colOut[i3 + 2]
        )
      }
      this._quat.setFromUnitVectors(this._forward, this._outward)
      this._scale.set(
        this.colScale[i3],
        this.colScale[i3 + 1],
        this.colScale[i3 + 2]
      )

      const slotIdx = i % slotCount
      const localIdx = perSlotCursor[slotIdx]++
      const slot = this.slots[slotIdx]
      this._matrix.compose(this._pos, this._quat, this._scale)
      slot.instanced.setMatrixAt(localIdx, this._matrix)
      this._wrapScale.set(
        this._scale.x * wrapScaleMul,
        this._scale.y * wrapScaleMul,
        this._scale.z * wrapScaleMul
      )
      this._wrapMatrix.compose(this._pos, this._quat, this._wrapScale)
      slot.wrapInstanced.setMatrixAt(localIdx, this._wrapMatrix)
    }
    for (const slot of this.slots) {
      slot.instanced.instanceMatrix.needsUpdate = true
      slot.wrapInstanced.instanceMatrix.needsUpdate = true
    }
  }

  dispose() {
    for (const slot of this.slots) {
      this.group.remove(slot.instanced)
      this.group.remove(slot.wrapInstanced)
      // Bead + wrap InstancedMeshes share the same geometry per slot —
      // only dispose once. Materials are shared across all slots and
      // released just below.
      slot.instanced.geometry.dispose()
    }
    this.slots = []
    if (this.wrapMaterial) {
      this.wrapMaterial.dispose()
      this.wrapMaterial = null
    }
    if (this.beadMaterial) {
      this.beadMaterial.dispose()
      this.beadMaterial = null
    }
    if (this.gradientTexture) {
      this.gradientTexture.dispose()
      this.gradientTexture = null
    }
    if (this.beadPhotoAtlas) {
      this.beadPhotoAtlas.dispose()
      this.beadPhotoAtlas = null
      this.beadPhotoAtlasUniform.value = null
    }
    this.vertexIndices = []
    this.depthOffsets = new Float32Array(0)
    this.restMagnitudes = new Float32Array(0)
    this.fillVertexIdx = new Uint32Array(0)
    this.fillVertexWeight = new Float32Array(0)
    this.fillDirs = new Float32Array(0)
    this.fillRestMag = new Float32Array(0)
    this.gridPositions = new Float32Array(0)
    this.gridAnchorIdx = new Uint32Array(0)
    this.gridRestAnchor = new Float32Array(0)
    this.gridMode = false
  }
}

/* ─── helpers ─────────────────────────────────────────── */

function colorsToHex(
  colors: BeadColorId[],
  adjustments: ColorAdjustments
): number[] {
  const out = colors.map((id) => resolveColorHex(id, adjustments))
  return out.length > 0 ? out : [0xfff8f4]
}

function hash01(i: number): number {
  const x = ((i + 1) * 2654435761) >>> 0
  return x / 0xffffffff
}

/** Per-shape IN-PLANE outer radius as a multiple of `size` — the metric
 *  the collision resolver uses to keep beads from overlapping. Flat
 *  shapes lying tangent to the slime surface push against their
 *  neighbours by their outer silhouette, not by the geometry's sphere
 *  radius, so torus (outer 1.4) needs a wider berth than sphere (1.0). */
function shapeCollisionRadius(shape: BeadShapeId): number {
  switch (shape) {
    case 'sphere':
      return 1.0
    case 'cube':
      // BoxGeometry(1.5) → half-diagonal in the face plane is √2 · 0.75.
      return 1.06
    case 'torus':
      // TorusGeometry(1, 0.4) → outer radius = 1 + 0.4 = 1.4.
      return 1.4
    case 'star':
      // Star Shape uses outer radius 1.1.
      return 1.1
    case 'heart':
      // Heart bezier envelope roughly ±1 in either direction.
      return 1.0
    case 'disc':
      // Flat cylinder — disc radius 1.0 (matches sphere) so the two
      // pack the same density under compact-fill mode.
      return 1.0
  }
}

/** Pick N vertex indices whose directions best cover the sphere evenly.
 *  Generates N Fibonacci-sphere directions and matches each to the closest
 *  mesh vertex — the pure stride-based picker used index order, which put
 *  beads close together whenever the mesh indexing had local clustering.
 *  Fibonacci sampling guarantees roughly equal angular spacing regardless
 *  of vertex count so beads don't stick to each other at low counts. */
/** Face-grid position + normal generator for cube slime + cube bead
 *  layouts. Places an N × N grid on each of the 6 cube faces and returns
 *  the exact 3D positions AND the corresponding face normals — beads
 *  render at those positions and orient their local +Z along the face
 *  normal, matching how a cube of cubes stacks physically. Bead size
 *  drives N so bigger cubes get fewer beads per face without any manual
 *  count wrangling. */
/** How far below the cube-face surface each grid bead centre sits, as a
 *  fraction of the bead's own half-side. Higher values sink beads
 *  deeper into the slime so less of their cap pokes out — at large
 *  bead sizes the exposed cap otherwise showed a visibly uneven
 *  "bumpy" surface because every millimetre of poke amplified the
 *  slight per-bead physics jitter. 0.8 keeps only ~20% of the cap
 *  above the face plane, smoothing the read of a packed cube of
 *  cubes at every size. */
const CUBE_GRID_EMBED_FRAC = 0.8
/** Maximum fraction of the slime radius the grid spans on each face.
 *  The actual per-frame extent is clipped smaller when the bead half-
 *  side is large enough that placing centres out at 0.88 would push
 *  their outer face past the cube edge (or into the neighbouring
 *  face's grid), which caused a visible "corner bead is taller than
 *  interior bead" bump at bead sizes ≥ 0.24. */
const CUBE_GRID_EXTENT_MAX = 0.88

function buildCubeGridLayout(
  beadSize: number,
  radius: number
): { positions: Float32Array; normals: Float32Array } {
  // Per-face independent grid — each of the 6 faces gets its OWN N × N
  // grid, offset from cube edges by an extent that shrinks with bead
  // size so edge beads never protrude past the cube face into the
  // neighbouring face's grid. That overlap was the "corner bead sits
  // taller" bump the user saw at sizes ≥ 0.24. Each bead sinks
  // perpendicular to ITS OWN face by CUBE_GRID_EMBED_FRAC so shared
  // vertices never shift sideways off the grid.
  //
  // Grid density solved for tight packing: rounded-box beads render at
  // 1.5 × beadSize wide (RoundedBoxGeometry outer dimension is 1.5),
  // so the grid step should equal one bead-side to have edges kiss.
  //   N ≈ (2 · extent) / (1.5 · beadSize) + 1
  const beadSide = beadSize * 1.5
  const beadHalfSide = beadSide * 0.5
  // Cap extent so the outermost bead's outer face (centre + halfSide)
  // sits inside the cube face rather than crossing the corner into
  // the adjacent face's grid. The extra 0.05 buffer prevents beads
  // from two orthogonal faces meeting exactly at the shared edge.
  const extent = Math.min(
    CUBE_GRID_EXTENT_MAX,
    Math.max(0.2, 1 - beadHalfSide - 0.05)
  ) * radius
  const N = Math.max(2, Math.round((2 * extent) / beadSide) + 1)
  const step = N > 1 ? (2 * extent) / (N - 1) : 0
  const start = -extent
  const sinkAmount = 0.75 * beadSize * CUBE_GRID_EMBED_FRAC

  const faces: readonly {
    n: readonly [number, number, number]
    u: readonly [number, number, number]
    v: readonly [number, number, number]
  }[] = [
    { n: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
    { n: [-1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
    { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1] },
    { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
    { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    { n: [0, 0, -1], u: [1, 0, 0], v: [0, 1, 0] }
  ]

  const total = faces.length * N * N
  const positions = new Float32Array(total * 3)
  const normals = new Float32Array(total * 3)
  let w = 0
  for (const { n, u, v } of faces) {
    // Face-plane centre, sunk INWARD along the pure face normal.
    const cx = n[0] * radius - n[0] * sinkAmount
    const cy = n[1] * radius - n[1] * sinkAmount
    const cz = n[2] * radius - n[2] * sinkAmount
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const su = start + i * step
        const sv = start + j * step
        // Grid positions purely along the two tangent axes — sink only
        // shifted the face centre, never the in-face coordinates, so
        // every bead on this face stays at its exact grid cell.
        positions[w * 3] = cx + u[0] * su + v[0] * sv
        positions[w * 3 + 1] = cy + u[1] * su + v[1] * sv
        positions[w * 3 + 2] = cz + u[2] * su + v[2] * sv
        normals[w * 3] = n[0]
        normals[w * 3 + 1] = n[1]
        normals[w * 3 + 2] = n[2]
        w++
      }
    }
  }
  return { positions, normals }
}

function pickIndices(unitDirs: Float32Array, count: number): number[] {
  if (count <= 0) return []
  const total = unitDirs.length / 3
  const n = Math.min(count, total)
  const phi = Math.PI * (Math.sqrt(5) - 1)
  const out: number[] = []
  const used = new Uint8Array(total)
  for (let i = 0; i < n; i++) {
    let dx: number
    let dy: number
    let dz: number
    if (n === 1) {
      // Single bead → anchor at the camera-facing centre (+z) so the
      // 속비즈 preset shows one big centred bead instead of an
      // arbitrary Fibonacci direction picked from the equator.
      dx = 0
      dy = 0
      dz = 1
    } else {
      // Half-offset variant of the Fibonacci-sphere sampling — endpoints
      // are AVOIDED so low counts (esp. n=2) don't pin beads to the
      // poles. With the old `i/(n-1)` form, n=2 produced y=+1 and y=-1
      // (exact opposite poles), leaving the two beads stuck to the
      // slime's top/bottom edges with a huge gap between them.
      // `(i+0.5)/n` puts n=2 at y=±0.5 instead — same even angular
      // spacing, no pole clumping.
      const tPar = (i + 0.5) / n
      dy = 1 - tPar * 2
      const r = Math.sqrt(Math.max(0, 1 - dy * dy))
      const theta = phi * i
      dx = Math.cos(theta) * r
      dz = Math.sin(theta) * r
    }
    // Nearest vertex to this Fibonacci direction. Skip already-used
    // vertices so two beads never claim the same anchor.
    let best = -1
    let bestDot = -Infinity
    for (let j = 0; j < total; j++) {
      if (used[j]) continue
      const d =
        unitDirs[j * 3] * dx +
        unitDirs[j * 3 + 1] * dy +
        unitDirs[j * 3 + 2] * dz
      if (d > bestDot) {
        bestDot = d
        best = j
      }
    }
    if (best < 0) break
    used[best] = 1
    out.push(best)
  }
  return out
}

/** Unit-scaled bead geometry per shape. Instance transform handles size. */
function buildBeadGeometry(shape: BeadShapeId): THREE.BufferGeometry {
  switch (shape) {
    case 'sphere':
      return new THREE.SphereGeometry(1, 14, 10)
    case 'cube':
      // RoundedBoxGeometry keeps the same 1.5 outer dimension the
      // plain BoxGeometry had but softens the corners with a 0.25
      // radius so bead cubes read as chunky pillowed dice rather
      // than sharp-edged blocks. 4 segments smooths the rounding
      // without adding too many verts per bead instance.
      return new RoundedBoxGeometry(1.5, 1.5, 1.5, 4, 0.25)
    case 'torus':
      return new THREE.TorusGeometry(1, 0.4, 10, 20)
    case 'star': {
      const s = new THREE.Shape()
      const outer = 1.1
      const inner = 0.5
      const points = 5
      for (let i = 0; i < points * 2; i++) {
        const r = i % 2 === 0 ? outer : inner
        const a = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2
        const x = Math.cos(a) * r
        const y = Math.sin(a) * r
        if (i === 0) s.moveTo(x, y)
        else s.lineTo(x, y)
      }
      s.closePath()
      const geo = new THREE.ExtrudeGeometry(s, {
        depth: 0.6,
        bevelEnabled: true,
        bevelThickness: 0.12,
        bevelSize: 0.08,
        bevelSegments: 2,
        curveSegments: 3
      })
      geo.translate(0, 0, -0.3)
      geo.computeVertexNormals()
      return geo
    }
    case 'heart': {
      const s = new THREE.Shape()
      s.moveTo(0, -1)
      s.bezierCurveTo(1.4, 0.1, 0.9, 1.2, 0, 0.5)
      s.bezierCurveTo(-0.9, 1.2, -1.4, 0.1, 0, -1)
      const geo = new THREE.ExtrudeGeometry(s, {
        depth: 0.6,
        bevelEnabled: true,
        bevelThickness: 0.14,
        bevelSize: 0.1,
        bevelSegments: 2,
        curveSegments: 6
      })
      geo.translate(0, 0.1, -0.3)
      geo.computeVertexNormals()
      return geo
    }
    case 'disc': {
      // 납작 원기둥. CylinderGeometry has its height axis along Y by
      // default; rotate to align the flat cap with local +Z so the
      // outward-facing face is a photo-ready disc after the instance
      // rotation (which maps local +Z → radial outward). Radius 1
      // matches sphere/torus footprint; height 0.8 keeps the coin
      // shape thin (2.5:1 wide-to-tall) while still poking the top
      // cap into z ≈ 0.4 so the photo's zMask fully lights it.
      const geo = new THREE.CylinderGeometry(1.0, 1.0, 0.8, 24, 1)
      geo.rotateX(Math.PI / 2)
      geo.computeVertexNormals()
      return geo
    }
  }
}
