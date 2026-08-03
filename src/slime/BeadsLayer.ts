import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import {
  BEAD_COLORS,
  BEAD_MATERIAL_PARAMS,
  COATINGS,
  type BeadColorId,
  type BeadMaterialId,
  type BeadShapeId,
  type BeadsConfig,
  type CoatingId,
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
  private gridNormals: Float32Array = new Float32Array(0)
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

  private currentMaterialId: BeadMaterialId = 'plastic'
  private currentCoatingId: CoatingId = 'none'

  // Per-bead damage / crackLevel / press-edge tracking, indexed by
  // GLOBAL bead index (0..n-1). Update() distributes each bead's values
  // to its slot's per-instance attribute via the same
  // (i % slotCount, perSlotCursor) mapping used for matrices.
  private beadDamage: Float32Array = new Float32Array(0)
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
  /** 1 when the layer is in the 속비즈 preset (chunk combo, single bead
   *  at slime origin). Tells the foil/tube branch of the crack shader
   *  to drop the press-point cone gate so tears spread across the whole
   *  bead surface like the slime's own foil coating — a small
   *  fully-embedded bead would otherwise only rip in a narrow patch
   *  facing the last press, reading as wax-style angular cracks. */
  private readonly beadFoilFullSurfaceUniform = { value: 0.0 }

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

  constructor() {
    this.group = new THREE.Group()
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
        pressPointAttr
      })
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
             float foam = clamp(fbm * 0.75 + fine * 0.35, 0.0, 1.0);
             float bright = smoothstep(0.4, 0.9, foam);
             float shade  = smoothstep(0.6, 0.1, foam);
             diffuseColor.rgb = mix(
               diffuseColor.rgb,
               diffuseColor.rgb * 0.3,
               bright * 0.95
             );
             diffuseColor.rgb = mix(
               diffuseColor.rgb,
               diffuseColor.rgb * 0.2,
               shade
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
    const foilFullU = this.beadFoilFullSurfaceUniform
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
      shader.uniforms.uBeadFoilFullSurface = foilFullU

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
         varying float vBeadDamage;
         varying float vBeadCrackLevel;
         varying vec3 vBeadLocal;
         varying vec3 vBeadPressDir;
         varying vec3 vBeadVertexDir;
        ` +
        shader.vertexShader.replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           vBeadDamage = aDamage;
           vBeadCrackLevel = aCrackLevel;
           vBeadPressDir = aPressPoint;
           // Sample voronoi in the bead's OWN local frame (before any
           // instance transform) so the crack pattern is anchored to
           // the bead — repositioning the bead doesn't slide cracks
           // across its surface, and every bead gets its own pattern
           // seeded by its rest coordinates.
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
         uniform float uBeadFoilFullSurface;
         varying float vBeadGradT;
         varying float vBeadDamage;
         varying float vBeadCrackLevel;
         varying vec3 vBeadLocal;
         varying vec3 vBeadPressDir;
         varying vec3 vBeadVertexDir;

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
             }`
          )
          .replace(
            '#include <color_fragment>',
            `#include <color_fragment>
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
             // ── WAX — CHUNKY WISPY-EDGE TEAR ───────────────────
             // Adopts the LARGER wispy voronoi that used to belong to
             // foil (freq 2.4 → few big cells with soft feathered
             // edges). The previous wax model used two fine voronoi
             // layers whose fragments were too small; a chunky
             // wax-piece look calls for one big-cell layer, so both
             // the visual and the mental model line up with real
             // candle wax breaking off in slabs.
             else if (uBeadCoatingIsWax > 0.5 && vBeadDamage > 0.01) {
               vec2 v = beadCrackVoronoi(vBeadLocal * 2.4);
               float visibility = smoothstep(0.01, 0.15, vBeadDamage);
               float baseWidth = smoothstep(0.02, 0.7, vBeadDamage) * 0.85;
               float perCell = 0.3 + v.y * 2.0;
               float crackWidth = min(baseWidth * perCell, 0.95);
               // Soft edge band — the wispy tear rim was the foil's
               // signature and reads as chunky ripped wax pieces
               // rather than sharp angular fragments.
               float edgeBand = min(0.18, crackWidth * 0.45);
               crackReveal = (1.0 - smoothstep(
                 crackWidth - edgeBand,
                 crackWidth,
                 v.x
               )) * visibility;
               revealTone = 0.65;
             }
             // ── FOIL / TUBE — SLIME-FOIL WISPY TEAR ────────────
             // Mirrors the slime's own foil coating: voronoi cells
             // at freq 2.3 with damage-driven width and hairline
             // edges. Uniform per-bead damage (no per-vertex stretch
             // on beads) means the voronoi pattern provides spatial
             // variation — cells with high per-cell width open first,
             // then more open as damage climbs. Non-centred beads
             // still gate the tear to a press-point cone so a finger
             // rips the coating specifically where it lands; the
             // 속비즈 preset drops that gate so the tear develops
             // across the whole bead surface.
             else if (uBeadCoatingIsFoil > 0.5 && vBeadDamage > 0.005) {
               // Verbatim port of the slime foil coating shader path
               // for BOTH multi-bead and single centred beads.
               // Beads have no per-vertex stretch channel (vStretch
               // is slime-only from volume preservation), so we use
               // vBeadDamage as a stretch proxy — that keeps the
               // stretchWidth * 1.7 contribution alive so the width
               // ramp matches the slime version's wide wispy tears.
               vec2 v = beadCrackVoronoi(vBeadLocal * 2.3);
               float stretchProxy = clamp(vBeadDamage, 0.0, 0.4);
               // Visibility saturates at the FIRST tap so the crack
               // is drawn at full opacity right away — only the
               // width scales with tap count, so a first tap shows a
               // small crack, subsequent taps widen it. Without this
               // early saturation, first tap on 속비즈 (damage ≈ 0.03
               // after the edge-bump scale) stayed invisible.
               float visibility = smoothstep(0.005, 0.03, vBeadDamage);
               float damageWidth = smoothstep(0.02, 0.6, vBeadDamage) * 0.5;
               float stretchWidth = stretchProxy * 1.7;
               float perCell = 0.3 + v.y * 1.8;
               float crackWidth = min((damageWidth + stretchWidth) * perCell, 0.88);
               float edgeBand = min(0.004, crackWidth * 0.15);
               float rawTear = (1.0 - smoothstep(
                 crackWidth - edgeBand,
                 crackWidth,
                 v.x
               )) * visibility;

               // Bead damage is UNIFORM across every vertex of the
               // instance (no per-vertex localisation), so without a
               // press-point cone the whole bead would tear at once.
               // Cone gate keeps the tear local to where the user
               // is pressing, matching how slime foil's vDamage is
               // naturally high only at pressed vertices.
               float pressLen = length(vBeadPressDir);
               float localMask = 0.0;
               if (pressLen > 0.01) {
                 vec3 pressDir = vBeadPressDir / pressLen;
                 float cosAngle = dot(pressDir, vBeadVertexDir);
                 float coneEdge = mix(
                   0.94,
                   -0.87,
                   smoothstep(0.02, 1.0, vBeadDamage)
                 );
                 localMask = smoothstep(coneEdge - 0.2, coneEdge + 0.05, cosAngle);
               }
               crackReveal = rawTear * localMask;
               // Stronger reveal tone for foil/tube so the exposed
               // slime pops against the intact coating instead of
               // reading as a slightly-lighter patch of the same
               // colour. Combined with the shadowed edge below,
               // gives a clear "torn open" boundary.
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
           vec3 _crackReveal;
           if (uBeadFoilFullSurface > 0.5 && uBeadCoatingIsFoil > 0.5) {
             _crackReveal = vec3(1.0);
           } else {
             float _minCh = min(
               min(diffuseColor.r, diffuseColor.g),
               diffuseColor.b
             );
             if (_minCh > 0.85) {
               _crackReveal = diffuseColor.rgb * (1.0 - revealTone * 0.75);
             } else {
               _crackReveal = mix(diffuseColor.rgb, vec3(1.0), revealTone);
             }
           }
           // Darken the crack RIM (where crackReveal ramps from 0 to
           // 1) so the boundary between intact coating and exposed
           // slime reads as a visible shadow line — foil is a
           // physical sheet, torn edges have thickness that catches
           // less light. Only the transition band gets shadowed;
           // the fully-torn interior keeps the bright reveal.
           float edgeShadow = 4.0 * crackReveal * (1.0 - crackReveal);
           _crackReveal *= (1.0 - edgeShadow * 0.55);
           diffuseColor.rgb =
             mix(diffuseColor.rgb, _crackReveal, clamp(crackReveal, 0.0, 1.0));`
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
           // 속비즈 foil crack reveal — bump roughness up so the
           // exposed white area reads as a diffuse "wet interior"
           // rather than a mirror-metallic sheet. Without this,
           // the crack area kept the shell's low roughness and
           // looked like a see-through reflective patch even though
           // diffuseColor is white.
           if (uBeadFoilFullSurface > 0.5 &&
               uBeadCoatingIsFoil > 0.5 &&
               crackReveal > 0.0) {
             roughnessFactor = mix(roughnessFactor, 0.55, crackReveal);
           }`
        )
        .replace(
          '#include <metalnessmap_fragment>',
          `#include <metalnessmap_fragment>
           // 속비즈 foil crack reveal — zero metalness in the torn
           // area so the diffuse white shows through instead of
           // being swallowed by the metallic BRDF (which would
           // reflect the environment and look transparent).
           if (uBeadFoilFullSurface > 0.5 &&
               uBeadCoatingIsFoil > 0.5 &&
               crackReveal > 0.0) {
             metalnessFactor = mix(metalnessFactor, 0.0, crackReveal);
           }`
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
    id: BeadMaterialId
  ) {
    const p = BEAD_MATERIAL_PARAMS[id]
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
    if (config.coating !== 'none' && this.slimeSurfaceCache) {
      const p = this.slimeSurfaceCache
      mat.roughness = p.roughness
      mat.metalness = p.metalness
      mat.clearcoat = p.clearcoat
      mat.clearcoatRoughness = p.clearcoatRoughness
      mat.transmission = p.transmission
      mat.thickness = p.thickness
      mat.ior = p.ior
      mat.sheen = p.sheen
      mat.sheenRoughness = p.sheenRoughness
      mat.sheenColor.copy(p.sheenColor)
      mat.iridescence = p.iridescence
      mat.iridescenceIOR = p.iridescenceIOR
      // Slime doesn't cache envMapIntensity — use 1.0 (three.js default,
      // matches what the slime's own material uses).
      mat.envMapIntensity = 1.0
      mat.needsUpdate = true
    } else {
      this.applyMaterialParams(mat, config.material)
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
    mat.clearcoat = c.clearcoat
    mat.clearcoatRoughness = c.clearcoatRoughness
    if (c.extraMetalness !== undefined) {
      mat.metalness = Math.min(1, mat.metalness + c.extraMetalness)
    }
    if (c.extraRoughness !== undefined) {
      mat.roughness = Math.min(1, mat.roughness + c.extraRoughness)
    }
    if (c.extraIridescence !== undefined) {
      mat.iridescence = Math.min(1, mat.iridescence + c.extraIridescence)
    }
    if (c.extraSheen !== undefined) {
      mat.sheen = c.extraSheen
      mat.sheenRoughness = c.extraSheenRoughness ?? mat.sheenRoughness
    }
    if (c.forceMatteBase) {
      mat.roughness = Math.max(mat.roughness, 0.85)
      mat.metalness = 0
      mat.sheen = 0
      mat.iridescence = 0
    }
    // On the slime, forceCrystalBase makes the whole shell a
    // transparent stained-glass crystal so the coating tints refracted
    // light. On a bead that would make the entire chunk vanish (95%
    // transmission with no wrap-shell behind it → invisible), so we
    // skip the transmission override and only borrow crystal's smooth
    // low-roughness look. Cracks + coating tint still land on top of
    // an opaque candy body underneath, which is what a real caramel-
    // coated bead reads like.
    if (c.forceCrystalBase) {
      mat.roughness = 0.05
      mat.sheen = 0
      mat.iridescence = 0
    }
    // Coated beads are always opaque — the coating shell reads as the
    // outer surface and the bead colour underneath is what fills the
    // cracks. Any transmission inherited from a crystal slime base
    // would either invisibly-pass-through the bead (foil, tube) or
    // wash out the coating tint entirely (wax, caramel).
    mat.transmission = 0
    mat.thickness = 0
    mat.needsUpdate = true
  }

  /** Sync the bead crack shader's coating-branch flags to a coating id.
   *  Foil and tube share a tear model (same as on the slime), so both
   *  flip uCoatingIsFoil. Any non-cracking coating ('none') also turns
   *  the master damage-enabled flag off so the fragment shader early-
   *  exits the crack pass entirely. */
  private updateBeadCrackUniforms(id: CoatingId) {
    const cracks =
      id === 'wax' || id === 'ice' || id === 'foil' || id === 'tube'
    this.beadDamageEnabledUniform.value = cracks ? 1.0 : 0.0
    this.beadIsWaxUniform.value = id === 'wax' ? 1.0 : 0.0
    this.beadIsIceUniform.value = id === 'ice' ? 1.0 : 0.0
    this.beadIsFoilUniform.value =
      id === 'foil' || id === 'tube' ? 1.0 : 0.0
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

  /** Accumulate press damage on each chunk bead based on distance from
   *  press tips this frame. Rising-edge of press also bumps
   *  crackLevel for wax / ice coatings, mirroring the slime's crack
   *  propagation gating (minus propagation itself — each bead is a
   *  single point, no neighbours to spread to). Requires that
   *  update() has already been called this frame so this.colPos
   *  holds each bead's resolved position — SlimeApp calls damage AFTER
   *  update() in the animation loop for that reason. */
  applyPressDamage(tips: readonly WeightedTip[], dt: number) {
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
    // from origin" is undefined, so the angular routing below can never
    // match it. Skip the alignment test entirely — every tip counts as
    // a press on the sole bead so coating cracks accumulate normally.
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
      // With touch weights now up to ~11 per tip, damage saturates
      // in a couple of frames and the coating rips wide open on a
      // single tap. Scale accumulation down heavily for this case so
      // one touch only nicks the coating, matching slime foil's
      // "small tear at press site" behaviour where damage is per-
      // vertex and each tap only accumulates on a few verts.
      // 속비즈 dampens damage growth so the coating doesn't rip wide
      // open in one tap, but the rising-edge bump is kept large
      // enough that a FIRST tap immediately crosses the shader's
      // visibility threshold (crack appears right away). Continuous
      // growth stays modest so long-press just widens the tear
      // rather than blowing it out.
      const damageScale = singleCenteredBead ? 0.35 : 1.0
      const edgeBumpScale = singleCenteredBead ? 0.6 : 1.0
      if (localForce > 0) {
        const d = this.beadDamage[i] + localForce * dt * damageRate * damageScale
        this.beadDamage[i] = d < 1 ? d : 1
        // Squish factor climbs with press force. Rate tuned so a
        // steady press reaches SQUISH_MAX (0.45 → 45% compression,
        // so bead never drops below ~55% of its original height)
        // in about a third of a second. Softer cap than before —
        // full 70% compression made pressed beads read as too small
        // relative to unpressed neighbours.
        const squishRate = 4.0
        const squishMax = 0.45
        const s = this.beadSquish[i] + localForce * dt * squishRate
        this.beadSquish[i] = s < squishMax ? s : squishMax
      }
      // Rising-edge press step — each distinct press bumps damage by
      // ~0.12 (so 6-7 quick presses saturate at 1.0), giving every
      // tap a clearly-visible crack widening even before the slow
      // continuous rate has time to add up. Combined together this
      // yields the "small crack → widens with each press → eventually
      // spans the whole surface" progression instead of an on/off
      // full-crack response after a single successful press.
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
    // outermost surface. Uncoated beads keep their wrap for the
    // "embedded in slime" look.
    for (const slot of this.slots) {
      slot.wrapInstanced.visible = config.coating === 'none'
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
      this.gridNormals = grid.normals.slice(0, effectiveCount * 3)
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
    const paletteHex = colorsToHex(
      config.colors.length > 0 ? config.colors : ['pearl']
    )
    const paletteColors = paletteHex.map((h) => new THREE.Color(h))
    const perBeadShader =
      paletteColors.length >= 2 && config.combo === 'chunk'
    const sphereGradient =
      paletteColors.length >= 2 && !perBeadShader
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
        // Discrete N-band split (2 colours → half + half, 3 → thirds,
        // etc.) — each bead picks the ONE palette colour whose Y-band
        // it falls into. Not a smooth lerp — user wanted crisp region
        // divisions instead of a gradient across the compact layer.
        const yDir = this.gridMode
          ? this.gridNormals[i * 3 + 1]
          : this.fillMode
            ? this.fillDirs[i * 3 + 1]
            : unitDirs[this.vertexIndices[i] * 3 + 1]
        const t = Math.max(0, Math.min(1, (yDir + 1) * 0.5))
        const bandIdx = Math.min(
          paletteColors.length - 1,
          Math.floor(t * paletteColors.length)
        )
        this._color.copy(paletteColors[bandIdx])
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
        this.colScale[i3 + 2] = size
      }

      // Phase 2 — Fibonacci-neighbor collision resolution. Skipped for
      // the compact combo: user wants those small packed beads to just
      // ride the slime surface without shoving each other, so pressure
      // dents deform bead positions the same way the slime around them
      // deforms (no bead-bead repulsion). Chunk combo keeps the pass
      // so big beads still separate on contact.
      // Compact combo normally skips collision so its packed sphere beads
      // ride the slime without shoving each other. But flat shapes
      // (torus, star, heart) OVERLAP visibly at Fibonacci-packed density
      // — their in-plane silhouette is 1.1–1.4× the sphere baseline. So
      // we DO run collision for compact whenever a non-sphere shape is
      // in the mix; sphere-only compact keeps its original no-push feel.
      const hasFlatShape = this.slots.some((s) => s.shape !== 'sphere')
      const runCollision = this.config.combo !== 'compact' || hasFlatShape
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
      // embedded in the middle of the volume instead of on the surface.
      // The default surface-sink path would leave the bead's outer edge
      // near the slime silhouette, and the taffy-wrap shader would then
      // bulge the whole slime around it (see setBeads gate in
      // SlimeApp for the matching taffy disable).
      if (n === 1 && isChunk) {
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
        this.colScale[i3] = size
        this.colScale[i3 + 1] = size
        this.colScale[i3 + 2] = size * flat
      } else {
        this.colScale[i3] = size
        this.colScale[i3 + 1] = size
        this.colScale[i3 + 2] = size
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
    this.vertexIndices = []
    this.depthOffsets = new Float32Array(0)
    this.restMagnitudes = new Float32Array(0)
    this.fillVertexIdx = new Uint32Array(0)
    this.fillVertexWeight = new Float32Array(0)
    this.fillDirs = new Float32Array(0)
    this.fillRestMag = new Float32Array(0)
    this.gridPositions = new Float32Array(0)
    this.gridNormals = new Float32Array(0)
    this.gridAnchorIdx = new Uint32Array(0)
    this.gridRestAnchor = new Float32Array(0)
    this.gridMode = false
  }
}

/* ─── helpers ─────────────────────────────────────────── */

function colorsToHex(colors: BeadColorId[]): number[] {
  const out: number[] = []
  for (const id of colors) {
    const preset = BEAD_COLORS.find((c) => c.id === id)
    if (preset) out.push(preset.hex)
  }
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
 *  fraction of the bead's own half-side. 0.6 puts the centre 0.6 ×
 *  half-side INSIDE the surface → ~80% embedded and only the top ~20%
 *  cap pokes out, matching the "beads deeply pressed into the slime"
 *  look of the reference. Because each face has its OWN independent
 *  grid (no dedup), this sink is safe: it only moves each bead along
 *  its own face normal, never sideways off the grid. */
const CUBE_GRID_EMBED_FRAC = 0.6
/** Fraction of the slime radius the grid spans on each face. 0.88 keeps
 *  the grid centred within the face with a small margin from the cube
 *  edge, so per-face grids don't collide at the cube seams and the
 *  bead field reads as "clustered toward the middle of each face". */
const CUBE_GRID_EXTENT = 0.88

function buildCubeGridLayout(
  beadSize: number,
  radius: number
): { positions: Float32Array; normals: Float32Array } {
  // Per-face independent grid — each of the 6 faces gets its OWN N × N
  // grid, offset from cube edges by CUBE_GRID_EXTENT so beads cluster
  // toward the face centre and per-face grids don't collide at cube
  // seams. Each bead sinks perpendicular to ITS OWN face by
  // CUBE_GRID_EMBED_FRAC, so shared/edge beads never shift sideways
  // off their grid position (which was the cross-clumping bug the
  // previous dedup path had). Grid density tracks bead size.
  const N = Math.max(2, Math.floor(radius / (beadSize * 1.05)) + 1)
  const extent = CUBE_GRID_EXTENT
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
        positions[w * 3] = cx + (u[0] * su + v[0] * sv) * radius
        positions[w * 3 + 1] = cy + (u[1] * su + v[1] * sv) * radius
        positions[w * 3 + 2] = cz + (u[2] * su + v[2] * sv) * radius
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
  }
}
