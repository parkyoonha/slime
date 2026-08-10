import * as THREE from 'three'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import {
  COATINGS,
  MATERIALS,
  resolveColorHex,
  type ColorAdjustments,
  type CoatingId,
  type ColorId,
  type MaterialId,
  type ShapeId,
  shapeTransform
} from './presets'

export interface SlimeParams {
  radius: number
  detail: number
  damping: number
  influenceRadius: number
  pushStrength: number
  /** How strongly velocity is averaged with neighbors each frame (0..1). */
  velSmoothing: number
  /** How strongly rest-relative displacement is averaged with neighbors. */
  dispSmoothing: number
  /** Max distance a vertex can wander from its rest position. Prevents
   * runaway motion / poke-through when strong forces build momentum. */
  maxDisplacement: number
  /** How aggressively the mesh inflates outward each frame to keep its
   *  volume close to rest — this is what makes a palm press flatten and
   *  spread wider instead of shrinking the whole slime. 0 disables. */
  volumePreservation: number
}

export interface WeightedTip {
  /** Contact point in the mesh's local space. */
  pos: THREE.Vector3
  /** Unit push direction in local space (typically toward the sphere center). */
  dir: THREE.Vector3
  /** How strongly the finger is pressing, 0..1. */
  weight: number
  /** Optional per-contact influence radius. Falls back to the SlimeParams
   *  default when omitted. Lets a fingertip push a narrow spot and a palm
   *  centre push a wide area from the same physics step. */
  radius?: number
}

const DEFAULTS: SlimeParams = {
  radius: 1,
  detail: 4,
  damping: 0.82,
  influenceRadius: 0.9,
  pushStrength: 14,
  // Velocity diffusion — turned way down from 0.15 so a spike at
  // pressed vertices doesn't cascade out into the surrounding mesh
  // frame by frame, which read as far-away regions shaking during
  // a targeted press.
  velSmoothing: 0.04,
  // dispSmoothing pulls each vertex toward the AVERAGE of its
  // neighbours' displacements. A light amount (0.12) rounds out
  // isolated sharp spikes — the kind that pop up when volume
  // preservation and bead taffy-stretch push a single vertex
  // outward much harder than its neighbours — without deadening
  // the overall knead response. Higher values start reading as a
  // spring-back so we keep it modest.
  dispSmoothing: 0.12,
  maxDisplacement: 0.65,
  // Volume preservation — dropped from 0.12 to 0.04. Under the
  // press-machine physics (symmetric antipode), the two-sided
  // compression makes vStretch swing wildly frame to frame; a
  // strong volume-preservation gain amplified that into a visible
  // whole-body wobble at spots the user isn't even touching.
  volumePreservation: 0.04
}

export class SlimeSphere {
  readonly mesh: THREE.Mesh
  readonly params: SlimeParams
  private readonly geometry: THREE.BufferGeometry
  private readonly restPositions: Float32Array
  private readonly velocities: Float32Array
  /** Unit direction from origin for every vertex — used to reshape. */
  private readonly unitDirs: Float32Array
  /** Compact adjacency: neighbors[offsets[i]..offsets[i+1]] are neighbors of vertex i. */
  private readonly adjOffsets: Uint32Array
  private readonly adjNeighbors: Uint32Array
  private currentShape: ShapeId = 'sphere'
  // Track material + coating IDs together so a change to one can reapply
  // BOTH — sheen is shared between them and would otherwise get stale.
  // Defaults match SlimeApp's entry state (crystal + none) so the first
  // rendered frame matches the React state and doesn't flash a mismatched
  // look before the initial useEffects fire.
  private currentMaterialId: MaterialId = 'crystal'
  private currentCoatingId: CoatingId = 'none'
  // Colour used for coating accent sheen (wax / foil / ice). Kept
  // independent of the slime's base colour so users can pick e.g. white
  // slime with gold foil coating. Neutral default so the first frame under
  // a coating (before setCoatingColor runs) still reads sensibly.
  private currentCoatingColorHex = 0xffe89a
  /** Sum of |restPos|² across all vertices — a cheap proxy for volume that
   *  we use to scale the mesh back up when the user compresses it. */
  private restVolumeMetric = 0
  /** Per-vertex accumulated damage 0..1. Grows with kneading force and never
   *  fully recovers on its own — reset()/setShape() zero it. Currently only
   *  used as a soft entry gate; crack visibility is driven by pressCount. */
  private readonly damage: Float32Array
  private readonly damageAttr: THREE.BufferAttribute
  /** Per-vertex continuous "crack level" 0..3. Each discrete press event
   *  (rising edge of force on a vertex) bumps this by +1 at that vertex.
   *  Each frame the level PROPAGATES to mesh neighbours with per-hop decay
   *  (~0.9x), so cracks spread outward from the press region gradually
   *  across the shell rather than snapping onto the whole ball at once.
   *  The ice shader reads this as a vertex attribute so the gap width
   *  fades toward zero at the spread frontier — the SAME connected
   *  voronoi network becomes visible everywhere the level > 0, with
   *  crack thickness proportional to level. */
  private readonly crackLevel: Float32Array
  private readonly crackLevelAttr: THREE.BufferAttribute
  /** Scratch buffer used to snapshot crackLevel before running each
   *  frame's propagation pass, so neighbour reads see the previous
   *  frame's values (no order-dependent smearing). */
  private readonly prevCrackLevel: Float32Array
  /** Per-vertex boolean (0/1) tracking whether force was applied last frame,
   *  used to detect the rising edge that fires a new press event. */
  private readonly wasBeingPressed: Uint8Array
  private restAttr!: THREE.BufferAttribute
  /** Shader uniform: 1 when a crack-capable coating (ice / foil) is active,
   *  0 otherwise. Multiplied into the crack effect so other coatings look
   *  untouched even after damage has been accrued. */
  private readonly damageEnabledUniform = { value: 0.0 }
  /** Shader uniform: 1 when the active crack-capable coating is foil, 0
   *  otherwise. Foil tears reveal the slime's raw base colour with metalness
   *  dropped so the exposed patch reads as gooey slime. */
  private readonly damageIsFoilUniform = { value: 0.0 }
  /** Shader uniform: 1 when the active crack-capable coating is ice, 0
   *  otherwise. Ice cracks reveal a bright wet version of the slime base
   *  colour to look like wet slime bulging through a frozen shell. */
  private readonly damageIsIceUniform = { value: 0.0 }
  /** Shader uniform: 1 when the (new, crack-less) wax coating is active,
   *  0 otherwise. Only used to gate the shader's diffuse override (wax
   *  paints the whole surface in the coating colour) — wax has no
   *  shatter behaviour, so this flag never touches the crack pass. */
  private readonly damageIsWaxUniform = { value: 0.0 }
  /** Shader uniform: 1 when the base material is matte, 0 otherwise. Toggles
   *  a procedural foam pattern in the fragment shader so matte slime reads
   *  as an aerated / bubbly cream (like whipped bath foam) instead of a
   *  flat matte surface — matches the reference capture. Ignored under
   *  crack-drawing coatings (foil/wax/ice paint the whole shell). */
  private readonly materialIsMatteUniform = { value: 0.0 }
  /** Shader uniform: the coating colour used as the full-surface tint when
   *  a diffuse-overriding coating (wax / foil) is active. Feeds diffuseColor
   *  across the whole ball so the entire sphere reads as e.g. gold foil or
   *  red wax — not just an edge sheen. Ignored when the coating isn't wax
   *  or foil. */
  private readonly coatingTintUniform = { value: new THREE.Color(0xb5bbc4) }
  // Multi-colour gradient uniforms. When two or more slime colours are
  // selected, we build a 1D CanvasTexture of the palette interpolated top-
  // to-bottom and let the fragment shader replace the base diffuse colour
  // with a sample from it. Single-colour slimes disable the uniform and use
  // the standard MeshPhysicalMaterial `color` path — one less texture bind.
  private readonly gradientUseUniform = { value: 0.0 }
  private readonly gradientTexUniform: { value: THREE.Texture | null } = {
    value: null
  }
  private readonly gradientRadiusUniform = { value: 1.0 }
  /** Latest colour ids + per-colour HSL deltas, cached so
   *  setColorAdjustments can re-resolve hex without SlimeApp having
   *  to re-emit the id list. */
  private currentColorIds: readonly ColorId[] = []
  private currentColorAdjustments: ColorAdjustments = {}
  private gradientTexture: THREE.DataTexture | null = null
  // Coating gradient — mirrors the slime gradient infra but paints the
  // wax / foil surface tint instead of the base slime colour. When only
  // one coating colour is picked the uniform stays off and the shader
  // falls through to the flat uCoatingTint colour.
  private readonly coatingGradientUseUniform = { value: 0.0 }
  private readonly coatingGradientTexUniform: {
    value: THREE.Texture | null
  } = { value: null }
  private coatingGradientTexture: THREE.DataTexture | null = null
  // Marble ink uniforms — driven by SlimeApp when sprinklesConfig.type is
  // 'ink'. Amount 0 = no marble effect; amount > 0 mixes swirls of the ink
  // colour into the base slime colour via a turbulence-based mask in the
  // fragment shader.
  private readonly inkColorUniform = { value: new THREE.Color(0xffffff) }
  private readonly inkAmountUniform = { value: 0.0 }
  // Bead taffy-pull uniforms — when active, the slime vertex shader
  // stretches each vertex OUTWARD along its nearest bead's direction so
  // the slime surface literally follows every bead's shape upward,
  // creating the "slime pulled up over each bead" look from a taffy
  // stretch. Radius = bead radius in world units; amount is a 0/1 gate.
  private readonly beadRadiusUniform = { value: 0 }
  private readonly beadWrapAmountUniform = { value: 0 }
  // 촬영 → 스티커 uniforms. When on, the fragment shader replaces the
  // slime's base colour with a photo texture on the front hemisphere.
  // Sampled in REST frame so the sticker sticks to the slime body and
  // stretches / dents with kneading like a printed decal. The radial
  // fade at the sticker edge keeps it circular rather than a square
  // cut, and the front-hemisphere gate hides it from the back face
  // (which would otherwise show a mirror of the photo through the
  // translucent slime).
  private readonly photoUseUniform = { value: 0.0 }
  private readonly photoMapUniform: { value: THREE.Texture | null } = {
    value: null
  }
  private readonly photoRadiusUniform = { value: 0.9 }
  private photoTexture: THREE.Texture | null = null
  /** Per-vertex nearest-bead unit direction stored as an attribute. */
  private beadDirAttr!: THREE.BufferAttribute
  private accumulatedForce = 0

  /** True while at least one fingertip is actively pressing. Used to detect
   *  the release edge (true → false) so we can snapshot the "retained shape"
   *  target — after release the mesh springs partway back to rest rather
   *  than either fully restoring or fully freezing. */
  private wasPressing = false
  /** Per-vertex target the mesh eases toward when nothing is pressing.
   *  Snapshotted on the release edge as rest + disp * (1 - RELEASE_RESTORE),
   *  so ~RELEASE_RESTORE of the dent depth retracts and the rest persists.
   *  Cleared once the mesh is close enough to stop the spring. */
  private restoreTargetPos: Float32Array | null = null

  constructor(params: Partial<SlimeParams> = {}) {
    this.params = { ...DEFAULTS, ...params }

    // Drop UV + normal attributes BEFORE mergeVertices so it can fully weld
    // seam vertices — with UVs kept, positions on the antimeridian have
    // distinct UV values (0 vs 1) and mergeVertices leaves them unmerged,
    // which produces a visible "zigzag" normal seam once we recompute vertex
    // normals. We don't sample any UV maps on the slime material so UVs are
    // safe to drop; normals are recomputed later from the merged geometry.
    const raw = new THREE.IcosahedronGeometry(
      this.params.radius,
      this.params.detail
    )
    raw.deleteAttribute('uv')
    raw.deleteAttribute('normal')
    this.geometry = mergeVertices(raw)
    if (!this.geometry.index) {
      throw new Error('Merged geometry unexpectedly has no index buffer')
    }

    const posAttr = this.geometry.attributes.position as THREE.BufferAttribute
    this.restPositions = new Float32Array(posAttr.array as Float32Array)
    this.velocities = new Float32Array(posAttr.array.length)

    // Cache unit directions once — later shape changes multiply against these
    // rather than the previous rest positions (which would compound).
    this.unitDirs = new Float32Array(this.restPositions.length)
    for (let i = 0; i < this.restPositions.length; i += 3) {
      const x = this.restPositions[i]
      const y = this.restPositions[i + 1]
      const z = this.restPositions[i + 2]
      const d = Math.hypot(x, y, z) || 1
      this.unitDirs[i] = x / d
      this.unitDirs[i + 1] = y / d
      this.unitDirs[i + 2] = z / d
    }

    // Build compact adjacency from the index buffer.
    const [offsets, neighbors] = buildAdjacency(
      this.geometry.index.array as Uint16Array | Uint32Array,
      this.vertexCount
    )
    this.adjOffsets = offsets
    this.adjNeighbors = neighbors

    this.recomputeRestVolumeMetric()

    this.damage = new Float32Array(this.vertexCount)
    this.damageAttr = new THREE.BufferAttribute(this.damage, 1)
    this.damageAttr.setUsage(THREE.DynamicDrawUsage)
    this.geometry.setAttribute('damage', this.damageAttr)

    this.crackLevel = new Float32Array(this.vertexCount)
    this.crackLevelAttr = new THREE.BufferAttribute(this.crackLevel, 1)
    this.crackLevelAttr.setUsage(THREE.DynamicDrawUsage)
    this.geometry.setAttribute('crackLevel', this.crackLevelAttr)
    this.prevCrackLevel = new Float32Array(this.vertexCount)
    this.wasBeingPressed = new Uint8Array(this.vertexCount)

    // Rest position as a vertex attribute so the ice shader can (a) sample
    // the voronoi plate pattern in the un-deformed frame (plates stay fixed
    // size instead of stretching with the mesh), and (b) compute per-vertex
    // displacement and widen cracks proportionally.
    this.restAttr = new THREE.BufferAttribute(this.restPositions, 3)
    this.restAttr.setUsage(THREE.DynamicDrawUsage)
    this.geometry.setAttribute('aRestPos', this.restAttr)

    // Per-vertex nearest-bead direction (populated by BeadsLayer when
    // beads change). Zero until bead influence is set.
    this.beadDirAttr = new THREE.BufferAttribute(
      new Float32Array(this.vertexCount * 3),
      3
    )
    this.beadDirAttr.setUsage(THREE.DynamicDrawUsage)
    this.geometry.setAttribute('aBeadDir', this.beadDirAttr)

    // Initial params match the entry defaults (white + crystal + no coating)
    // so the first rendered frame renders as clear glassy slime instead of a
    // pink flash before React's first useEffect batch pushes state through.
    const material = new THREE.MeshPhysicalMaterial({
      color: 0xfbf7f2,
      roughness: 0.05,
      metalness: 0,
      transmission: 0.95,
      thickness: 0.4,
      ior: 1.5,
      clearcoat: 0,
      clearcoatRoughness: 0,
      sheen: 0,
      sheenColor: new THREE.Color(0xffffff),
      iridescence: 0,
      side: THREE.DoubleSide
    })
    this.gradientRadiusUniform.value = this.params.radius
    installDamageShader(
      material,
      this.damageEnabledUniform,
      this.damageIsFoilUniform,
      this.damageIsIceUniform,
      this.damageIsWaxUniform,
      this.materialIsMatteUniform,
      this.coatingTintUniform,
      this.inkColorUniform,
      this.inkAmountUniform,
      this.beadRadiusUniform,
      this.beadWrapAmountUniform,
      this.gradientUseUniform,
      this.gradientTexUniform,
      this.gradientRadiusUniform,
      this.coatingGradientUseUniform,
      this.coatingGradientTexUniform,
      this.photoUseUniform,
      this.photoMapUniform,
      this.photoRadiusUniform
    )

    this.mesh = new THREE.Mesh(this.geometry, material)
    this.mesh.castShadow = false
    this.mesh.receiveShadow = false
  }

  /** Reshape rest positions in place. Physics resumes from these. */
  setShape(shape: ShapeId) {
    if (shape === this.currentShape) return
    this.currentShape = shape
    const r = this.params.radius
    const rest = this.restPositions
    const posAttr = this.geometry.attributes.position as THREE.BufferAttribute
    const arr = posAttr.array as Float32Array

    for (let i = 0; i < this.unitDirs.length; i += 3) {
      const nx = this.unitDirs[i]
      const ny = this.unitDirs[i + 1]
      const nz = this.unitDirs[i + 2]
      const [tx, ty, tz] = shapeTransform(shape, nx, ny, nz)
      rest[i] = tx * r
      rest[i + 1] = ty * r
      rest[i + 2] = tz * r
    }
    arr.set(rest)
    for (let i = 0; i < this.velocities.length; i++) this.velocities[i] *= 0.3
    this.damage.fill(0)
    this.damageAttr.needsUpdate = true
    this.crackLevel.fill(0)
    this.prevCrackLevel.fill(0)
    this.crackLevelAttr.needsUpdate = true
    this.wasBeingPressed.fill(0)
    this.restAttr.needsUpdate = true
    this.recomputeRestVolumeMetric()
    posAttr.needsUpdate = true

    // Preset mesh orientation per shape. Cube gets a 3/4 hero view
    // (yaw so the right face peeks in + pitch so the top face peeks
    // down) so the user immediately sees it as a cube rather than as
    // a flat square silhouette. Sphere resets to identity.
    if (shape === 'cube') {
      this.mesh.quaternion.setFromEuler(
        new THREE.Euler(-0.26, 0.44, 0, 'YXZ')
      )
    } else {
      this.mesh.quaternion.identity()
    }
    this.geometry.computeVertexNormals()
  }

  private recomputeRestVolumeMetric() {
    let total = 0
    const rest = this.restPositions
    for (let i = 0; i < rest.length; i++) total += rest[i] * rest[i]
    this.restVolumeMetric = total
  }

  /** Assign the slime's base colour. Passing a single ID sets the material
   *  colour and turns the gradient path off; passing two or more builds a
   *  1D LUT of the palette (top vertex = colours[0], bottom vertex = last)
   *  and turns the gradient sampler on in the shader. The material's own
   *  `color` is set to the first entry as a fallback for surface-param
   *  consumers (bead wrap sync) that can't render a gradient themselves. */
  setColors(
    ids: readonly ColorId[],
    adjustments?: ColorAdjustments
  ) {
    // Cache both so a later setColorAdjustments call can re-emit
    // without SlimeApp having to re-push the ids.
    this.currentColorIds = ids
    if (adjustments !== undefined) this.currentColorAdjustments = adjustments
    const hexes: number[] = ids.map((id) =>
      resolveColorHex(id, this.currentColorAdjustments)
    )
    const mat = this.mesh.material as THREE.MeshPhysicalMaterial
    if (hexes.length === 0) {
      mat.color.setHex(0xfbf7f2)
      this.gradientUseUniform.value = 0
      return
    }
    mat.color.setHex(hexes[0])
    if (hexes.length === 1) {
      this.gradientUseUniform.value = 0
      return
    }
    this.rebuildGradientTexture(hexes)
    this.gradientUseUniform.value = 1
  }

  /** Update the per-colour HSL deltas without changing which ids are
   *  active. Re-runs setColors with the cached id list so the material
   *  colour + gradient texture pick up the new hex values. */
  setColorAdjustments(adjustments: ColorAdjustments) {
    this.currentColorAdjustments = adjustments
    this.setColors(this.currentColorIds)
  }

  private rebuildGradientTexture(hexes: readonly number[]) {
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

  /** Base slime look (roughness/metalness/transmission/sheen/iridescence).
   *  Always re-applies via _applyLook so a subsequent wax coating's accent
   *  sheen doesn't get stranded on the wrong base state. */
  setMaterial(id: MaterialId) {
    this.currentMaterialId = id
    this.materialIsMatteUniform.value = id === 'matte' ? 1.0 : 0.0
    this._applyLook()
  }

  /** Outer surface treatment. Non-`none` coatings add clearcoat + accent
   *  sheen tinted by the user's coating colour; ice/foil turn on the crack
   *  shader so kneading draws cracks (ice) or wrinkles / tears (foil). */
  setCoating(id: CoatingId) {
    this.currentCoatingId = id
    this._applyLook()
    const hasCracks =
      COATINGS.find((c) => c.id === id)?.params.hasCracks ?? false
    this.setDamageRenderingEnabled(hasCracks)
    // 'tube' piggybacks on the foil shader path — same wispy tear
    // behaviour, and the paper's metalness is 0 so the foil-only
    // "kill metalness in crack" step is a no-op.
    this.damageIsFoilUniform.value =
      id === 'foil' || id === 'tube' ? 1.0 : 0.0
    this.damageIsIceUniform.value = id === 'ice' ? 1.0 : 0.0
    this.damageIsWaxUniform.value = id === 'wax' ? 1.0 : 0.0
    if (!hasCracks) this.clearDamage()
  }

  /** Colour used for the coating's accent sheen AND (for wax / foil / ice)
   *  the whole surface tint. All three real coatings paint the entire
   *  surface with this colour via the shader — a red wax ball reads as red
   *  everywhere, a gold foil ball reads as gold everywhere, a pale ice
   *  ball reads as that pale colour everywhere — and cracks in the
   *  crack-capable ones (ice, foil) expose the slime base colour
   *  underneath. */
  setCoatingColor(hex: number) {
    this.currentCoatingColorHex = hex
    this.coatingTintUniform.value.setHex(hex)
    this.coatingGradientUseUniform.value = 0
    this._applyLook()
  }

  /** Multi-colour coating tint. One colour → falls back to the single-
   *  tint path (uCoatingTint uniform flat over the whole shell). Two or
   *  more → builds a top-to-bottom LUT sampled by the coating shader,
   *  giving the wax / foil surface a gradient across the sphere. */
  setCoatingColors(hexes: readonly number[]) {
    if (hexes.length <= 1) {
      this.setCoatingColor(hexes[0] ?? this.currentCoatingColorHex)
      return
    }
    this.currentCoatingColorHex = hexes[0]
    this.coatingTintUniform.value.setHex(hexes[0])
    this.rebuildCoatingGradientTexture(hexes)
    this.coatingGradientUseUniform.value = 1
    this._applyLook()
  }

  private rebuildCoatingGradientTexture(hexes: readonly number[]) {
    if (this.coatingGradientTexture) this.coatingGradientTexture.dispose()
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
    this.coatingGradientTexture = tex
    this.coatingGradientTexUniform.value = tex
  }

  /** Snapshot of the slime's current live material params — colour +
   *  everything the composed material/coating pass writes. Beads copy this
   *  onto their wrap-shell material every time slime changes so the wrap
   *  looks identical to the underlying slime (matte slime → matte wrap,
   *  crystal slime → transparent wrap, wax / ice → clearcoat + accent
   *  sheen). */
  getSurfaceParams(): {
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
  } {
    const mat = this.mesh.material as THREE.MeshPhysicalMaterial
    return {
      color: mat.color.clone(),
      roughness: mat.roughness,
      metalness: mat.metalness,
      transmission: mat.transmission,
      thickness: mat.thickness,
      ior: mat.ior,
      sheen: mat.sheen,
      sheenRoughness: mat.sheenRoughness,
      sheenColor: mat.sheenColor.clone(),
      iridescence: mat.iridescence,
      iridescenceIOR: mat.iridescenceIOR,
      clearcoat: mat.clearcoat,
      clearcoatRoughness: mat.clearcoatRoughness
    }
  }

  /** Ink marble effect painted inside the slime body via a fragment shader
   *  turbulence mask. `amount` in [0, 1] controls how much of the base slime
   *  colour is replaced by ink swirls; 0 disables the effect entirely so
   *  the shader mixin becomes a cheap no-op for non-ink sprinkle types. */
  setInk(colorHex: number, amount: number) {
    this.inkColorUniform.value.setHex(colorHex)
    this.inkAmountUniform.value = Math.max(0, Math.min(1, amount))
  }

  /** Apply (or clear) a photo decal on the front hemisphere. Pass a
   *  loaded Texture to enable the sticker; pass null to disable and
   *  dispose the previous texture. `radius` is the sticker's radial
   *  extent in slime-radius units (0.9 fills most of the visible
   *  face, 1.0 reaches the silhouette). */
  setPhotoDecal(texture: THREE.Texture | null, radius: number = 0.9) {
    if (this.photoTexture && this.photoTexture !== texture) {
      this.photoTexture.dispose()
    }
    this.photoTexture = texture
    this.photoMapUniform.value = texture
    this.photoUseUniform.value = texture ? 1.0 : 0.0
    this.photoRadiusUniform.value = Math.max(0.05, Math.min(1.0, radius))
  }

  /** Set per-vertex nearest-bead directions and bead radius so the slime
   *  vertex shader can taffy-stretch outward toward every bead. Pass
   *  active=false (or null dirs) to disable. `nearestDirs` is a flat
   *  Float32Array of vertexCount x 3 unit vectors. */
  setBeadInfluence(
    nearestDirs: Float32Array | null,
    beadRadius: number,
    active: boolean
  ) {
    if (!active || nearestDirs === null) {
      this.beadWrapAmountUniform.value = 0
      this.beadRadiusUniform.value = 0
      return
    }
    const arr = this.beadDirAttr.array as Float32Array
    arr.set(nearestDirs)
    this.beadDirAttr.needsUpdate = true
    this.beadRadiusUniform.value = beadRadius
    this.beadWrapAmountUniform.value = 1
  }

  /** Live uniform refs for the ink effect. Shared with BeadsLayer so the
   *  bead wrap-shell can paint the SAME marble swirls on top of the beads
   *  (paper sprinkles sit above beads naturally; ink is a shader effect on
   *  the slime, so without this the beads would occlude every stroke). One
   *  setInk call updates both layers because they hold the same references. */
  getInkUniforms(): {
    colorUniform: { value: THREE.Color }
    amountUniform: { value: number }
  } {
    return {
      colorUniform: this.inkColorUniform,
      amountUniform: this.inkAmountUniform
    }
  }

  /** Live uniform refs for the slime's multi-colour gradient — shared
   *  with BeadsLayer so the bead wrap-shell can sample the SAME gradient
   *  and paint compact beads with the top-to-bottom colour band. Without
   *  this the wrap defaults to the slime's mat.color (only colours[0]),
   *  so compact-fill layers with a multi-colour slime look monotone. */
  getGradientUniforms(): {
    useUniform: { value: number }
    texUniform: { value: THREE.Texture | null }
    radiusUniform: { value: number }
  } {
    return {
      useUniform: this.gradientUseUniform,
      texUniform: this.gradientTexUniform,
      radiusUniform: this.gradientRadiusUniform
    }
  }

  /** Share the matte-material flag uniform with the bead wrap-shell so
   *  the same foam pattern that mottles the slime body also appears on
   *  wrap-covered beads. Without this, a compact-fill bead layer over
   *  a matte slime shows opaque flat wrap shells (foam invisible).
   *  Returns the live reference — BeadsLayer holds it directly. */
  getMatteFoamUniform(): { value: number } {
    return this.materialIsMatteUniform
  }

  /** Combine current material + coating into the MeshPhysicalMaterial. The
   *  material sets every base property; the coating layers clearcoat +
   *  optional metalness/roughness/sheen adjustments on top, pulling its
   *  sheen tint from `currentCoatingColorHex` when it opts into user colour. */
  private _applyLook() {
    const m = MATERIALS.find((x) => x.id === this.currentMaterialId)?.params
    const c = COATINGS.find((x) => x.id === this.currentCoatingId)?.params
    if (!m || !c) return
    const mat = this.mesh.material as THREE.MeshPhysicalMaterial
    mat.roughness = m.roughness
    mat.metalness = m.metalness
    mat.transmission = m.transmission
    mat.thickness = m.thickness
    mat.ior = m.ior
    mat.sheen = m.sheen
    mat.sheenRoughness = m.sheenRoughness
    mat.sheenColor.setHex(m.sheenColorHex)
    mat.iridescence = m.iridescence
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
      if (c.usesUserColor) {
        mat.sheenColor.setHex(this.currentCoatingColorHex)
      }
    }
    // Coating-driven material transforms — restore each coating's
    // signature finish regardless of what base material the user
    // picked. These change reflectance/roughness/transmission only;
    // the diffuse colour is separately owned by the slime colour
    // picker (setCoatingColors), so the picked hue stays the same,
    // only the surface FINISH switches. Layout:
    //   wax  → opaque matte candle body (forceMatteBase)
    //   tube → matte paper + high clearcoat (forceMatteBase +
    //          coating params bring clearcoat)
    //   foil → glossy metal (base extras handle metalness/clearcoat)
    //   ice  → glassy crystal shell (forceCrystalBase)
    if (c.forceMatteBase) {
      mat.roughness = Math.max(mat.roughness, 0.85)
      mat.transmission = 0
      mat.thickness = 0
      mat.metalness = 0
      mat.sheen = 0
      mat.iridescence = 0
    }
    if (c.forceCrystalBase) {
      mat.roughness = 0.05
      mat.metalness = 0
      mat.transmission = 0.95
      mat.thickness = 0.4
      mat.ior = 1.5
      mat.sheen = 0
      mat.iridescence = 0
    }
    if (c.forceOpaqueBase) {
      // Zero transmission only — keeps metalness / roughness / sheen
      // set by the coating's extras intact. Used by foil so its
      // metallic outside stays intact but crack reveals can't see
      // through a transparent-base slime.
      mat.transmission = 0
      mat.thickness = 0
    }
    mat.needsUpdate = true
  }

  get restPositionArray(): Float32Array {
    return this.restPositions
  }

  get positionArray(): Float32Array {
    return this.geometry.attributes.position.array as Float32Array
  }

  get normalArray(): Float32Array {
    return this.geometry.attributes.normal.array as Float32Array
  }

  get unitDirsArray(): Float32Array {
    return this.unitDirs
  }

  get indexArray(): Uint16Array | Uint32Array {
    return this.geometry.index!.array as Uint16Array | Uint32Array
  }

  get shape(): ShapeId {
    return this.currentShape
  }

  get vertexCount(): number {
    return this.restPositions.length / 3
  }

  /**
   * Advance the soft-body physics one step. Model:
   *   - Fingertips push nearby vertices AWAY (indent, not spike).
   *   - Velocity is diffused across neighbors so a push propagates outward
   *     naturally — creates a smooth dent instead of a single-vertex spike.
   *   - Displacements from rest are also gently averaged with neighbors so
   *     sharp bumps get rounded out, matching real slime plasticity.
   *   - No spring restore — deformations are permanent (kneading persists).
   */
  update(fingerTips: WeightedTip[], dt: number) {
    const {
      damping,
      influenceRadius,
      pushStrength,
      velSmoothing,
      dispSmoothing,
      maxDisplacement,
      volumePreservation
    } = this.params

    const posAttr = this.geometry.attributes.position as THREE.BufferAttribute
    const arr = posAttr.array as Float32Array
    const rest = this.restPositions
    const vel = this.velocities
    const offsets = this.adjOffsets
    const nbrs = this.adjNeighbors
    // Foil tears aggressively under sustained force — damage builds fast
    // so a modest press already gapes tears open dramatically. Wax tears
    // moderately (thick candle material — visible tearing but slower
    // than thin foil). Ice's damage is only retained as soft physics
    // state; its crack visibility uses the per-vertex crackLevel
    // propagation pass instead. Other coatings fall back to the default.
    const damageRate =
      this.currentCoatingId === 'foil'
        ? 0.14
        : this.currentCoatingId === 'wax'
          ? 0.24
          : this.currentCoatingId === 'ice'
            ? 0.18
            : 0.12
    // Flag set when any vertex's crackLevel changes (from a press event or
    // from propagation), so we only re-upload the attribute when there's
    // actually new data.
    let crackLevelChanged = false


    // Collect active tips (position + push direction + weight).
    const tipsPX: number[] = []
    const tipsPY: number[] = []
    const tipsPZ: number[] = []
    const tipsDX: number[] = []
    const tipsDY: number[] = []
    const tipsDZ: number[] = []
    const tipsW: number[] = []
    const tipsInvR: number[] = []
    const tipsR2: number[] = []
    for (const t of fingerTips) {
      if (t.weight <= 0.001) continue
      tipsPX.push(t.pos.x)
      tipsPY.push(t.pos.y)
      tipsPZ.push(t.pos.z)
      tipsDX.push(t.dir.x)
      tipsDY.push(t.dir.y)
      tipsDZ.push(t.dir.z)
      tipsW.push(t.weight)
      const r = t.radius ?? influenceRadius
      tipsInvR.push(1 / r)
      tipsR2.push(r * r)
    }
    const tipCount = tipsPX.length

    // 1) Apply directional push forces to velocity + damping.
    //    The push direction is fixed per tip (typically inward toward the
    //    mesh center) rather than radial from the tip, so a fingertip on the
    //    silhouette compresses the silhouette instead of squirting vertices
    //    away tangentially.
    for (let i = 0; i < arr.length; i += 3) {
      const px = arr[i]
      const py = arr[i + 1]
      const pz = arr[i + 2]

      let fx = 0
      let fy = 0
      let fz = 0

      let localForceMag = 0
      for (let k = 0; k < tipCount; k++) {
        const dx = px - tipsPX[k]
        const dy = py - tipsPY[k]
        const dz = pz - tipsPZ[k]
        const dsq = dx * dx + dy * dy + dz * dz
        if (dsq < tipsR2[k]) {
          // Linear falloff by distance to tip. Radius comes from the tip
          // itself so a slim fingertip pushes a narrow spot while a broader
          // palm-centre contact affects a wide area, in one physics pass.
          const falloff = 1 - Math.sqrt(dsq) * tipsInvR[k]
          const s = pushStrength * tipsW[k] * falloff
          fx += tipsDX[k] * s
          fy += tipsDY[k] * s
          fz += tipsDZ[k] * s
          localForceMag += s
        }
      }

      vel[i] = (vel[i] + fx * dt) * damping
      vel[i + 1] = (vel[i + 1] + fy * dt) * damping
      vel[i + 2] = (vel[i + 2] + fz * dt) * damping

      // Accumulate per-vertex damage (bounded 0..1). Retained as a soft
      // physics quantity; the crack shader no longer uses it for
      // visibility.
      const vi = i / 3
      if (localForceMag > 0) {
        const d = this.damage[vi] + localForceMag * dt * damageRate
        this.damage[vi] = d < 1 ? d : 1
      }

      // ICE + WAX + FOIL/TUBE: crack on the RISING EDGE of press
      // force so the per-vertex crackLevel gets a discrete level bump
      // the frame a finger first touches. Foil / tube joined the
      // list so their tear visibility also gates on crackLevel — a
      // single tap now nudges the vertex to level 1 (below the
      // visibility threshold of 1.5 in the shader) and only the
      // SECOND tap crosses into visible cracks. Long-press growth
      // (below) is what lets a sustained hold also cross the
      // threshold without releasing.
      // Ice caps at 3 (3-stage shatter model); wax and foil cap at
      // 5 so multiple presses can keep widening / subdividing.
      const wasPressed = this.wasBeingPressed[vi] === 1
      if (!wasPressed && localForceMag > 0.05) {
        if (this.currentCoatingId === 'ice' && this.crackLevel[vi] < 3) {
          this.crackLevel[vi] = Math.min(3, this.crackLevel[vi] + 1)
          crackLevelChanged = true
        } else if (
          this.currentCoatingId === 'wax' &&
          this.crackLevel[vi] < 5
        ) {
          this.crackLevel[vi] = Math.min(5, this.crackLevel[vi] + 1)
          crackLevelChanged = true
        } else if (
          (this.currentCoatingId === 'foil' ||
            this.currentCoatingId === 'tube') &&
          this.crackLevel[vi] < 5
        ) {
          // Foil/tube: smaller per-tap bump so the first tap only
          // barely nudges the vertex under the visibility threshold —
          // the sheet has to be repeatedly pressed (or held) to
          // meaningfully tear, giving the reveal a slower ramp-up.
          this.crackLevel[vi] = Math.min(5, this.crackLevel[vi] + 0.45)
          crackLevelChanged = true
        }
        this.wasBeingPressed[vi] = 1
      } else if (wasPressed && localForceMag < 0.01) {
        this.wasBeingPressed[vi] = 0
      }
      // LONG-PRESS crackLevel growth — while a vertex is continuously
      // being pressed, its crackLevel ticks up gradually so a held
      // press eventually crosses the visibility threshold and
      // propagates across the mesh, matching the "long press spreads
      // cracks widely" behaviour. Growth rate is tuned so ~1.5 s of
      // continuous hard press moves level from 1 to 2 (visibility
      // unlocks). Only runs for crack-drawing coatings.
      if (
        wasPressed &&
        localForceMag > 0.1 &&
        (this.currentCoatingId === 'ice' ||
          this.currentCoatingId === 'wax' ||
          this.currentCoatingId === 'foil' ||
          this.currentCoatingId === 'tube')
      ) {
        const cap =
          this.currentCoatingId === 'ice' ? 3 : 5
        // Foil/tube tear more slowly under continuous press than
        // ice/wax — sustained hold still spreads the tear, but a
        // brief mash no longer gapes the sheet all at once.
        const growRate =
          this.currentCoatingId === 'foil' ||
          this.currentCoatingId === 'tube'
            ? 0.32
            : 0.7
        const next = Math.min(cap, this.crackLevel[vi] + growRate * dt)
        if (next > this.crackLevel[vi]) {
          this.crackLevel[vi] = next
          crackLevelChanged = true
        }
      }
    }

    // Track this frame's total force so callers can drive sound / haptics.
    let tipWeightSum = 0
    for (let i = 0; i < tipCount; i++) tipWeightSum += tipsW[i]
    this.accumulatedForce = tipWeightSum * pushStrength

    // 2) Diffuse velocity to neighbors — makes a push drag its surroundings.
    if (velSmoothing > 0 && tipCount > 0) {
      const verts = this.vertexCount
      const tmp = new Float32Array(vel.length)
      const a = velSmoothing
      const oneMinusA = 1 - a
      for (let i = 0; i < verts; i++) {
        const s0 = offsets[i]
        const s1 = offsets[i + 1]
        const cnt = s1 - s0 || 1
        let ax = 0
        let ay = 0
        let az = 0
        for (let n = s0; n < s1; n++) {
          const j = nbrs[n] * 3
          ax += vel[j]
          ay += vel[j + 1]
          az += vel[j + 2]
        }
        ax /= cnt
        ay /= cnt
        az /= cnt
        const i3 = i * 3
        tmp[i3] = vel[i3] * oneMinusA + ax * a
        tmp[i3 + 1] = vel[i3 + 1] * oneMinusA + ay * a
        tmp[i3 + 2] = vel[i3 + 2] * oneMinusA + az * a
      }
      vel.set(tmp)
    }

    // 3) Integrate position from smoothed velocity.
    for (let i = 0; i < arr.length; i++) arr[i] += vel[i] * dt

    // 3.5) Clamp displacement from rest so no vertex can wander further than
    //      maxDisplacement (prevents poke-through when momentum builds up).
    if (maxDisplacement > 0) {
      const maxD2 = maxDisplacement * maxDisplacement
      for (let i = 0; i < arr.length; i += 3) {
        const dxr = arr[i] - rest[i]
        const dyr = arr[i + 1] - rest[i + 1]
        const dzr = arr[i + 2] - rest[i + 2]
        const d2 = dxr * dxr + dyr * dyr + dzr * dzr
        if (d2 > maxD2) {
          const scale = maxDisplacement / Math.sqrt(d2)
          arr[i] = rest[i] + dxr * scale
          arr[i + 1] = rest[i + 1] + dyr * scale
          arr[i + 2] = rest[i + 2] + dzr * scale
          // Bleed most of the velocity so it doesn't just pile against the clamp.
          vel[i] *= 0.15
          vel[i + 1] *= 0.15
          vel[i + 2] *= 0.15
        }
      }
    }

    // 4) Smooth the (position - rest) displacement across neighbors.
    //    Only the deviation gets averaged, so the base shape (blob/pumpkin/…)
    //    is preserved but sharp local kinks are rounded out.
    //    Gated on tipCount so the shape freezes the moment the user lets
    //    go — running this pass every idle frame slowly diffuses dents
    //    outward and (with volume preservation) drifts the ball back to
    //    a sphere, which contradicts "kneading persists".
    if (dispSmoothing > 0 && tipCount > 0) {
      const verts = this.vertexCount
      const a = dispSmoothing
      const dispTmp = new Float32Array(vel.length)
      for (let i = 0; i < verts; i++) {
        const s0 = offsets[i]
        const s1 = offsets[i + 1]
        const cnt = s1 - s0 || 1
        let ax = 0
        let ay = 0
        let az = 0
        for (let n = s0; n < s1; n++) {
          const j = nbrs[n] * 3
          ax += arr[j] - rest[j]
          ay += arr[j + 1] - rest[j + 1]
          az += arr[j + 2] - rest[j + 2]
        }
        ax /= cnt
        ay /= cnt
        az /= cnt
        const i3 = i * 3
        const dx = arr[i3] - rest[i3]
        const dy = arr[i3 + 1] - rest[i3 + 1]
        const dz = arr[i3 + 2] - rest[i3 + 2]
        dispTmp[i3] = rest[i3] + dx * (1 - a) + ax * a
        dispTmp[i3 + 1] = rest[i3 + 1] + dy * (1 - a) + ay * a
        dispTmp[i3 + 2] = rest[i3 + 2] + dz * (1 - a) + az * a
      }
      arr.set(dispTmp)
    }

    // 5) Volume preservation — under the symmetric-press physics
    //    (both sides squished simultaneously), scaling every vertex
    //    outward is exactly the "equator bulges when poles are
    //    pressed" behaviour we want. Reinstated so a two-plate
    //    squish reads as a proper flattened pancake.
    if (volumePreservation > 0 && this.restVolumeMetric > 0 && tipCount > 0) {
      let curVol = 0
      for (let i = 0; i < arr.length; i++) curVol += arr[i] * arr[i]
      if (curVol > 1e-6) {
        const ratio = this.restVolumeMetric / curVol
        // Only correct sizable deviations; clamp to sane range.
        if (ratio > 1.005 && ratio < 4) {
          const targetScale = Math.sqrt(ratio)
          const step = 1 + (targetScale - 1) * volumePreservation
          for (let i = 0; i < arr.length; i++) arr[i] *= step
        }
      }
    }

    this.damageAttr.needsUpdate = true

    // Crack propagation pass — ice fractures OUTWARD from press points
    // gradually via crackLevel spreading across the mesh; wax's tear
    // TERRITORY spreads the same way but with STEEPER per-hop decay so
    // a single press event only reaches a few hops out. Foil / tube
    // intentionally SKIP propagation so a first tap only tears at the
    // exact pressed vertex — the user asked for local tears there,
    // not the network spread wax and ice do.
    if (
      this.currentCoatingId === 'ice' ||
      this.currentCoatingId === 'wax'
    ) {
    const decayPerHop =
      this.currentCoatingId === 'ice' ? 0.9 : 0.85
    const spreadPerFrame = 15 * dt
    this.prevCrackLevel.set(this.crackLevel)
    for (let vi = 0; vi < this.vertexCount; vi++) {
      let maxN = 0
      const s = this.adjOffsets[vi]
      const e = this.adjOffsets[vi + 1]
      for (let k = s; k < e; k++) {
        const lvl = this.prevCrackLevel[this.adjNeighbors[k]]
        if (lvl > maxN) maxN = lvl
      }
      const target = maxN * decayPerHop
      if (target > this.crackLevel[vi]) {
        const nextLevel = this.crackLevel[vi] + spreadPerFrame
        const newLevel = nextLevel < target ? nextLevel : target
        if (newLevel > this.crackLevel[vi]) {
          this.crackLevel[vi] = newLevel
          crackLevelChanged = true
        }
      }
    }
    }
    if (crackLevelChanged) this.crackLevelAttr.needsUpdate = true

    // 6) Partial restore on release. Deformations don't fully rebound
    //    (that would erase kneading) but they don't fully freeze either
    //    — on the frame the last fingertip leaves, snapshot a target at
    //    10% of the way back to rest, then ease the mesh toward it. The
    //    remaining 90% of the dent stays baked in until the user presses
    //    again (which clears the target so a fresh press can build up).
    const RELEASE_RESTORE = 0.1
    const SPRING_STEP = 0.12
    if (tipCount > 0) {
      this.wasPressing = true
      this.restoreTargetPos = null
    } else {
      if (this.wasPressing) {
        this.wasPressing = false
        if (
          this.restoreTargetPos === null ||
          this.restoreTargetPos.length !== arr.length
        ) {
          this.restoreTargetPos = new Float32Array(arr.length)
        }
        const target = this.restoreTargetPos
        const keep = 1 - RELEASE_RESTORE
        for (let i = 0; i < arr.length; i++) {
          target[i] = rest[i] + (arr[i] - rest[i]) * keep
        }
      }
      if (this.restoreTargetPos !== null) {
        const target = this.restoreTargetPos
        let maxDelta2 = 0
        for (let i = 0; i < arr.length; i += 3) {
          const dx = target[i] - arr[i]
          const dy = target[i + 1] - arr[i + 1]
          const dz = target[i + 2] - arr[i + 2]
          arr[i] += dx * SPRING_STEP
          arr[i + 1] += dy * SPRING_STEP
          arr[i + 2] += dz * SPRING_STEP
          const d2 = dx * dx + dy * dy + dz * dz
          if (d2 > maxDelta2) maxDelta2 = d2
        }
        if (maxDelta2 < 1e-8) this.restoreTargetPos = null
      }
    }

    posAttr.needsUpdate = true
    this.geometry.computeVertexNormals()
  }

  reset() {
    const posAttr = this.geometry.attributes.position as THREE.BufferAttribute
    const arr = posAttr.array as Float32Array
    arr.set(this.restPositions)
    this.velocities.fill(0)
    this.wasPressing = false
    this.restoreTargetPos = null
    this.damage.fill(0)
    this.damageAttr.needsUpdate = true
    this.crackLevel.fill(0)
    this.prevCrackLevel.fill(0)
    this.crackLevelAttr.needsUpdate = true
    this.wasBeingPressed.fill(0)
    posAttr.needsUpdate = true
    this.geometry.computeVertexNormals()
  }

  /** Snapshot everything the physics + damage passes mutate so a
   *  thumbnail-capture path can call reset() → render → restore()
   *  without disturbing the live squish/crack state. */
  snapshotMutableState(): {
    positions: Float32Array
    velocities: Float32Array
    damage: Float32Array
    crackLevel: Float32Array
    prevCrackLevel: Float32Array
    wasBeingPressed: Uint8Array
    wasPressing: boolean
    restoreTargetPos: Float32Array | null
  } {
    const posAttr = this.geometry.attributes.position as THREE.BufferAttribute
    return {
      positions: new Float32Array(posAttr.array as Float32Array),
      velocities: new Float32Array(this.velocities),
      damage: new Float32Array(this.damage),
      crackLevel: new Float32Array(this.crackLevel),
      prevCrackLevel: new Float32Array(this.prevCrackLevel),
      wasBeingPressed: new Uint8Array(this.wasBeingPressed),
      wasPressing: this.wasPressing,
      restoreTargetPos: this.restoreTargetPos
        ? new Float32Array(this.restoreTargetPos)
        : null
    }
  }

  restoreMutableState(snap: ReturnType<SlimeSphere['snapshotMutableState']>) {
    const posAttr = this.geometry.attributes.position as THREE.BufferAttribute
    const arr = posAttr.array as Float32Array
    arr.set(snap.positions)
    this.velocities.set(snap.velocities)
    this.damage.set(snap.damage)
    this.crackLevel.set(snap.crackLevel)
    this.prevCrackLevel.set(snap.prevCrackLevel)
    this.wasBeingPressed.set(snap.wasBeingPressed)
    this.wasPressing = snap.wasPressing
    this.restoreTargetPos = snap.restoreTargetPos
    posAttr.needsUpdate = true
    this.damageAttr.needsUpdate = true
    this.crackLevelAttr.needsUpdate = true
    this.geometry.computeVertexNormals()
  }

  /** Zero the crack pattern without touching the geometry. */
  clearDamage() {
    this.damage.fill(0)
    this.damageAttr.needsUpdate = true
    this.crackLevel.fill(0)
    this.prevCrackLevel.fill(0)
    this.crackLevelAttr.needsUpdate = true
    this.wasBeingPressed.fill(0)
  }

  /** Approximation of "how hard the user is squishing right now". */
  get pressureThisFrame(): number {
    return this.accumulatedForce
  }

  /** Freeze the mesh's current velocities without touching positions,
   *  damage, or crack state. Meant for input transitions (e.g. a
   *  second finger arrives → pinch gesture starts) where the existing
   *  dent should stay but any in-flight motion from the just-cancelled
   *  press should stop. */
  stopMotion() {
    this.velocities.fill(0)
    this.accumulatedForce = 0
  }

  /** Enable/disable the crack rendering effect (wired to coating selection). */
  setDamageRenderingEnabled(on: boolean) {
    this.damageEnabledUniform.value = on ? 1.0 : 0.0
  }

  get damageRenderingEnabled(): boolean {
    return this.damageEnabledUniform.value > 0.5
  }

  /** Fade the slime BODY toward invisible. Used by SlimeApp to hide
   *  the "soft" slime interior when chunk beads pack the sphere so
   *  densely that a background body would just add visual clutter
   *  between the beads. `o` = 1 → normal, `o` = 0 → mesh hidden
   *  outright. Intermediate values enable material transparency and
   *  set the alpha; below ~0.02 the mesh is dropped from rendering
   *  entirely to skip the transmission pass. */
  setBodyOpacity(o: number) {
    const clamped = o < 0 ? 0 : o > 1 ? 1 : o
    this.mesh.visible = clamped > 0.02
    const mat = this.mesh.material as THREE.MeshPhysicalMaterial
    const wantTransparent = clamped < 0.99
    if (mat.transparent !== wantTransparent) {
      mat.transparent = wantTransparent
      mat.needsUpdate = true
    }
    mat.opacity = clamped
  }

  dispose() {
    if (this.gradientTexture) {
      this.gradientTexture.dispose()
      this.gradientTexture = null
    }
    if (this.coatingGradientTexture) {
      this.coatingGradientTexture.dispose()
      this.coatingGradientTexture = null
    }
    if (this.photoTexture) {
      this.photoTexture.dispose()
      this.photoTexture = null
    }
    this.geometry.dispose()
    ;(this.mesh.material as THREE.Material).dispose()
  }
}

/**
 * Build a compact CSR-style adjacency graph from a triangle-index buffer.
 * Returns [offsets, neighbors] where neighbors[offsets[i] .. offsets[i+1]-1]
 * lists the vertex indices adjacent to vertex i.
 */
function buildAdjacency(
  idx: Uint16Array | Uint32Array,
  vertexCount: number
): [Uint32Array, Uint32Array] {
  const sets: Set<number>[] = Array.from(
    { length: vertexCount },
    () => new Set<number>()
  )
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t]
    const b = idx[t + 1]
    const c = idx[t + 2]
    sets[a].add(b)
    sets[a].add(c)
    sets[b].add(a)
    sets[b].add(c)
    sets[c].add(a)
    sets[c].add(b)
  }
  const offsets = new Uint32Array(vertexCount + 1)
  let total = 0
  for (let i = 0; i < vertexCount; i++) {
    total += sets[i].size
    offsets[i + 1] = total
  }
  const neighbors = new Uint32Array(total)
  let p = 0
  for (let i = 0; i < vertexCount; i++) {
    for (const n of sets[i]) neighbors[p++] = n
  }
  return [offsets, neighbors]
}

/**
 * Extend MeshPhysicalMaterial via onBeforeCompile: forward per-vertex damage
 * to the fragment shader, paint procedural voronoi-cell cracks when the
 * damage uniform is enabled, mix in marble-ink swirls when the ink uniforms
 * are non-zero, and stretch slime vertices outward around each bead so the
 * translucent slime literally pulls up over every bead like taffy — the
 * bead pokes through, and slime tightens around its contours instead of
 * being punched flat by the bead sphere.
 */
function installDamageShader(
  material: THREE.MeshPhysicalMaterial,
  enabledUniform: { value: number },
  isFoilUniform: { value: number },
  isIceUniform: { value: number },
  isWaxUniform: { value: number },
  isMatteUniform: { value: number },
  coatingTintUniform: { value: THREE.Color },
  inkColorUniform: { value: THREE.Color },
  inkAmountUniform: { value: number },
  beadRadiusUniform: { value: number },
  beadWrapAmountUniform: { value: number },
  gradientUseUniform: { value: number },
  gradientTexUniform: { value: THREE.Texture | null },
  gradientRadiusUniform: { value: number },
  coatingGradientUseUniform: { value: number },
  coatingGradientTexUniform: { value: THREE.Texture | null },
  photoUseUniform: { value: number },
  photoMapUniform: { value: THREE.Texture | null },
  photoRadiusUniform: { value: number }
) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uDamageEnabled = enabledUniform
    shader.uniforms.uCoatingIsFoil = isFoilUniform
    shader.uniforms.uCoatingIsIce = isIceUniform
    shader.uniforms.uCoatingIsWax = isWaxUniform
    shader.uniforms.uMaterialIsMatte = isMatteUniform
    shader.uniforms.uCoatingTint = coatingTintUniform
    shader.uniforms.uInkColor = inkColorUniform
    shader.uniforms.uInkAmount = inkAmountUniform
    shader.uniforms.uBeadRadius = beadRadiusUniform
    shader.uniforms.uBeadWrapAmount = beadWrapAmountUniform
    shader.uniforms.uUseGradient = gradientUseUniform
    shader.uniforms.uGradient = gradientTexUniform
    shader.uniforms.uGradientRadius = gradientRadiusUniform
    shader.uniforms.uUseCoatingGradient = coatingGradientUseUniform
    shader.uniforms.uCoatingGradient = coatingGradientTexUniform
    shader.uniforms.uPhotoUse = photoUseUniform
    shader.uniforms.uPhotoMap = photoMapUniform
    shader.uniforms.uPhotoRadius = photoRadiusUniform

    shader.vertexShader =
      `attribute float damage;
       attribute float crackLevel;
       attribute vec3 aRestPos;
       attribute vec3 aBeadDir;
       uniform float uBeadRadius;
       uniform float uBeadWrapAmount;
       varying float vDamage;
       varying float vCrackLevel;
       varying vec3 vRest;
       varying float vStretch;
      ` +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vDamage = damage;
         vCrackLevel = crackLevel;
         // Rest position anchors the voronoi cells so plate SIZES stay
         // constant — deformation moves plates but doesn't stretch them.
         vRest = aRestPos;
         // Only outward radial displacement counts as "stretch" — pressing a
         // vertex INWARD compresses the ice (should not crack open the
         // plates there), while a vertex bulging OUTWARD from volume
         // preservation genuinely pulls the shell apart.
         vec3 restDir = length(aRestPos) > 1e-4
           ? aRestPos / length(aRestPos)
           : vec3(0.0, 0.0, 1.0);
         vStretch = max(0.0, dot(position - aRestPos, restDir));

         // Bead taffy stretch. Each vertex has a nearest-bead direction
         // baked in (aBeadDir). Compute the bead centre at the same rest
         // radius as this vertex, take the world-distance to that centre,
         // and pull the vertex outward by a smoothstep of that distance.
         //
         // Amplitude peaks at 1.05 x bead radius — slightly OVER the
         // bead top so the slime literally engulfs the tip and beads read
         // as embedded in a stretched slime bulge (not sitting on a flat
         // surface). Fade radius 1.9 x bead radius gives wide overlap
         // between adjacent beads so bulges merge into a smooth taffy
         // sheet instead of appearing as isolated bumps.
         if (uBeadWrapAmount > 0.5 && uBeadRadius > 1e-4) {
           float restLen = length(aRestPos);
           vec3 beadRest = aBeadDir * restLen;
           float d = length(aRestPos - beadRest);
           float bulge =
             smoothstep(uBeadRadius * 1.9, uBeadRadius * 0.1, d)
             * uBeadRadius * 1.05;
           transformed += restDir * bulge;
         }`
      )

    shader.fragmentShader =
      `uniform float uDamageEnabled;
       uniform float uCoatingIsFoil;
       uniform float uCoatingIsIce;
       uniform float uCoatingIsWax;
       uniform float uMaterialIsMatte;
       uniform vec3 uCoatingTint;
       uniform vec3 uInkColor;
       uniform float uInkAmount;
       uniform float uUseGradient;
       uniform sampler2D uGradient;
       uniform float uGradientRadius;
       uniform float uUseCoatingGradient;
       uniform sampler2D uCoatingGradient;
       uniform float uPhotoUse;
       uniform sampler2D uPhotoMap;
       uniform float uPhotoRadius;
       varying float vDamage;
       varying float vCrackLevel;
       varying vec3 vRest;
       varying float vStretch;

       // 3D turbulence built from nested sines — cheap enough to run per
       // fragment and produces the long twisty flows that read as marble
       // swirls when their sign flips through zero. Sampled in the REST
       // frame so the pattern stays anchored to the slime body and doesn't
       // wobble around while the mesh deforms.
       float inkTurb(vec3 p) {
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

       float damageHash(vec2 p) {
         p = fract(p * vec2(233.34, 851.73));
         p += dot(p, p + 23.45);
         return fract(p.x * p.y);
       }

       // 3D hash → single float in [0, 1). Used by the foam pattern to
       // seed per-cell brightness so bubbles have irregular values instead
       // of a uniform speckle. Sampled in REST space so the foam stays
       // anchored to the slime body during deformation.
       float foamHash3(vec3 p) {
         p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
         p *= 17.0;
         return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
       }
       // Cheap 3D value noise via trilinear-interpolated hashes.
       float foamNoise(vec3 p) {
         vec3 i = floor(p);
         vec3 f = fract(p);
         vec3 u = f * f * (3.0 - 2.0 * f);
         float n000 = foamHash3(i);
         float n100 = foamHash3(i + vec3(1.0, 0.0, 0.0));
         float n010 = foamHash3(i + vec3(0.0, 1.0, 0.0));
         float n110 = foamHash3(i + vec3(1.0, 1.0, 0.0));
         float n001 = foamHash3(i + vec3(0.0, 0.0, 1.0));
         float n101 = foamHash3(i + vec3(1.0, 0.0, 1.0));
         float n011 = foamHash3(i + vec3(0.0, 1.0, 1.0));
         float n111 = foamHash3(i + vec3(1.0, 1.0, 1.0));
         float nx00 = mix(n000, n100, u.x);
         float nx10 = mix(n010, n110, u.x);
         float nx01 = mix(n001, n101, u.x);
         float nx11 = mix(n011, n111, u.x);
         float nxy0 = mix(nx00, nx10, u.y);
         float nxy1 = mix(nx01, nx11, u.y);
         return mix(nxy0, nxy1, u.z);
       }
       // fBm — sum of octaves. Produces the mottled bubble field with fine
       // pockets on top of larger cell structures, matching the reference
       // image's aerated bath-foam look.
       float foamFbm(vec3 p) {
         float total = 0.0;
         float amp = 0.5;
         for (int i = 0; i < 4; i++) {
           total += foamNoise(p) * amp;
           p *= 2.15;
           amp *= 0.55;
         }
         return total;
       }

       // Worley/voronoi with F2-F1 boundary distance + a stable per-cell
       // random id. Returns:
       //   x = distance-to-boundary (0 on cell edges, larger inside cells)
       //   y = cell-unique random in [0,1] (used as per-plate "toughness")
       vec2 damageVoronoi(vec3 p) {
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
               damageHash(gi + o),
               damageHash(gi + o + 17.3)
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
         return vec2(d2 - d1, damageHash(nearest * 3.1415));
       }
      ` + shader.fragmentShader
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
           // Multi-colour gradient: when active, replace the base diffuse
           // with a sample from the 1D palette LUT keyed off the vertex's
           // REST y-coordinate. Sampling in rest space keeps the gradient
           // anchored to the slime body — kneading deforms plates and
           // dents but the top-to-bottom colour arrangement stays put.
           if (uUseGradient > 0.5) {
             float gt = clamp(
               (vRest.y / uGradientRadius + 1.0) * 0.5,
               0.0,
               1.0
             );
             diffuseColor.rgb = texture2D(uGradient, vec2(gt, 0.5)).rgb;
           }
           // 촬영 스티커: front-hemisphere photo decal. Sample the photo
           // in REST frame so kneading stretches the picture with the
           // mesh instead of sliding it around. Circular alpha fade
           // keeps the sticker round (no square cut), and the vRest.z
           // gate hides it from the back face so a translucent slime
           // doesn't show a mirrored ghost of the photo through itself.
           if (uPhotoUse > 0.5) {
             vec2 pUV = vec2(
               (vRest.x / uGradientRadius) * 0.5 + 0.5,
               1.0 - ((vRest.y / uGradientRadius) * 0.5 + 0.5)
             );
             float rXY = length(vec2(
               vRest.x / uGradientRadius,
               vRest.y / uGradientRadius
             ));
             // 4% wide soft edge so the sticker rim doesn't read as a
             // hard cutout — matches the mosaic path's front-hemisphere
             // aesthetic (round patch, softened silhouette).
             float radialMask =
               1.0 - smoothstep(uPhotoRadius - 0.04, uPhotoRadius, rXY);
             // Front-hemisphere ramp: fully opaque near +Z, fades to 0
             // at the equator so the sticker doesn't wrap onto the
             // rim / back where it would look weirdly stretched.
             float zMask = smoothstep(0.0, 0.35, vRest.z / uGradientRadius);
             float photoAlpha = radialMask * zMask;
             if (photoAlpha > 0.001) {
               vec3 photoRGB = texture2D(uPhotoMap, pUV).rgb;
               diffuseColor.rgb = mix(diffuseColor.rgb, photoRGB, photoAlpha);
             }
           }
           // Slime body colour that shows THROUGH crack / tear reveals
           // is forced to pure WHITE whenever a crack-drawing coating
           // is active. Reads as a "wet cream" interior no matter what
           // colour the user picked for the outer coating — matches
           // the request to keep the slime under coatings uniformly
           // white. Uncoated slime still uses its own diffuse colour
           // for the (unused) snapshot path.
           vec3 slimeBaseColor = uDamageEnabled > 0.5
             ? vec3(1.0)
             : diffuseColor.rgb;

           // Wax, foil, and ice paint the ENTIRE ball in the coating
           // colour so the sphere reads as "red wax" / "gold foil" /
           // "clear ice" rather than as "slime with a coating-coloured
           // rim". Same tint uniform for all three (they differ in
           // material response: wax is soft candle sheen, foil is
           // metallic + iridescent, ice is fully matte + crackable) and
           // the flags are mutually exclusive so whichever is 1 wins.
           if (uCoatingIsFoil > 0.5 || uCoatingIsIce > 0.5 || uCoatingIsWax > 0.5) {
             if (uUseCoatingGradient > 0.5) {
               // Sample coating LUT keyed off the vertex's rest Y — same
               // top-to-bottom direction the slime gradient uses — so a
               // multi-colour coating reads as a smooth band across the
               // whole shell.
               float ct = clamp(
                 (vRest.y / uGradientRadius + 1.0) * 0.5,
                 0.0,
                 1.0
               );
               diffuseColor.rgb =
                 texture2D(uCoatingGradient, vec2(ct, 0.5)).rgb;
             } else {
               diffuseColor.rgb = uCoatingTint;
             }
           }

           float crackReveal = 0.0;
           if (uDamageEnabled > 0.5) {
             // ── ICE: rigid frozen shell SHATTER model ─────────────
             // Ice pieces are conserved in aggregate — the coating
             // doesn't dissolve away with repeated pressing. Three
             // levers drive the visible behaviour:
             //   (1) crackLevel (per-vertex, propagates outward
             //       across the mesh from press points) drives WHERE
             //       the shell is cracked. Growing past a vertex
             //       joins it into the cracked network.
             //   (2) vStretch (per-vertex, from volume-preservation
             //       bulges under the finger) PHYSICALLY spreads the
             //       existing pieces apart, exposing more slime
             //       between them without changing piece count.
             //   (3) A SECOND voronoi layer fades in once crackLevel
             //       climbs past ~1.2 — each additional press
             //       SUBDIVIDES the existing plates into smaller
             //       pieces (rather than widening the gaps).
             //       Layer 1 is always drawn so the base network
             //       remains fully connected; Layer 2 only ADDS
             //       lines on top.
             if (uCoatingIsIce > 0.5 && vCrackLevel > 0.5) {
               // Piece gap width — starts THIN on the very first press
               // (crackLevel ~1) so cracks read as hairline fractures,
               // then widens as repeated presses push crackLevel higher
               // and the shell truly breaks apart. Mesh stretch still
               // spreads the pieces further apart on top of this.
               float baseWidth = mix(
                 0.025,
                 0.06,
                 smoothstep(1.0, 2.0, vCrackLevel)
               );
               float stretchBoost = clamp(vStretch, 0.0, 0.4) * 0.35;
               float gapWidth = baseWidth + stretchBoost;
               // Hard 12% AA sliver → crisp piece boundaries.
               float gapEdge = gapWidth * 0.88;

               // Layer 1: primary plate network — always visible
               // where crackLevel > 0 so its connectivity holds up.
               vec2 v1 = damageVoronoi(vRest * 3.0);
               float layer1 = 1.0 - smoothstep(gapEdge, gapWidth, v1.x);

               // Layer 2: finer subdivision — fades in on the
               // second press event, splitting each layer-1 piece
               // in two rather than widening the gaps.
               vec2 v2 = damageVoronoi(vRest * 6.0 + vec3(37.1, 11.3, 88.7));
               float layer2 = (1.0 - smoothstep(gapEdge, gapWidth, v2.x))
                 * smoothstep(1.2, 2.2, vCrackLevel);

               // Global visibility fade — unreached regions stay
               // fully uncracked; the spread frontier shows only
               // faint hairlines.
               float visibility = smoothstep(0.0, 1.0, vCrackLevel);

               crackReveal = max(layer1, layer2) * visibility;
             }
             // ── WAX: candle-wax TEAR model ────────────────────────
             // Wax tears open along local damage accumulation like
             // foil, but slower and narrower. crackLevel (propagated
             // across the mesh from press points) additionally
             // controls the tear TERRITORY: areas that haven't been
             // pressed directly become tearable once the propagated
             // level reaches them. So the FIRST press tears open a
             // local patch, and by the SECOND press event the tear
             // network has crept out to the ball's edges. Cracks
             // share foil's soft feathered edges.
             else if (
               uCoatingIsWax > 0.5 &&
               vCrackLevel > 0.5
             ) {
               // Layer 1: primary tear network — always the same
               // voronoi pattern, so the wax PIECES stay the same
               // size regardless of press count. Widens with local
               // damage/stretch and shows across the propagated
               // crackLevel territory.
               vec2 v1 = damageVoronoi(vRest * 2.6);

               // Spread visibility starts JUST BELOW level 1 so a
               // first press (which caps at level 1 at pressed vertices
               // and drops to 0.85 at 1 hop under decay 0.85) only
               // shows cracks at the pressed vertices themselves — no
               // propagation reach on press #1. Press #2 bumps sources
               // to level 2 and now propagation stays above threshold
               // for ~6 hops, extending the tear territory outward.
               // Stretch is intentionally EXCLUDED from visibility —
               // volume preservation makes vStretch positive across
               // large parts of the ball whenever any spot is pressed
               // (opposite-side bulges, silhouette vertices), and if
               // it triggered cracks the coating would tear everywhere
               // on the first press instead of just under the finger.
               // Visibility saturates at the first tap (crackLevel 1)
               // so cracks are drawn at FULL opacity from tap 1 —
               // only the crack WIDTH scales with tap count for the
               // "small at first, wider with more taps" progression.
               float damageVis = smoothstep(0.05, 0.2, vDamage);
               float spreadVis = smoothstep(0.5, 1.0, vCrackLevel);
               float visibility = max(damageVis, spreadVis);

               float damageWidth =
                 smoothstep(0.25, 0.7, vDamage) * 0.10;
               float stretchWidth = clamp(vStretch, 0.0, 0.4) * 0.35;
               // Spread width grows progressively through presses 1-3
               // (crackLevel 1 to 3), so each additional press within
               // the first three visibly widens the gaps between
               // pieces without introducing any subdivisions. Piece
               // SIZE stays constant — only the crack gap widens.
               float spreadWidth =
                 smoothstep(0.85, 3.0, vCrackLevel) * 0.09;
               float perCell1 = 0.3 + v1.y * 1.8;
               float rawWidth1 =
                 (damageWidth + stretchWidth + spreadWidth) * perCell1;
               // Enforce a minimum width whenever the crack is
               // visible at all — otherwise the transitions produce
               // hairline strokes that read as thin solid lines
               // scattered across the ball. With this floor, cracks
               // are either invisible or drawn as proper gaps with
               // meaningful thickness.
               float minVisibleWidth1 = visibility * 0.045;
               float width1 = min(max(rawWidth1, minVisibleWidth1), 0.35);
               // Hard step edge — no anti-aliased rim, so cracks read
               // as angular voronoi-cell boundaries with sharp
               // right-angle transitions instead of soft radial fades.
               float layer1 = (1.0 - step(width1, v1.x)) * visibility;

               // Layer 2: SUBDIVISIONS inside layer-1 pieces. Only
               // starts on the FOURTH press event — presses 1-3 stay
               // pure Layer 1 (bigger and bigger gaps between the
               // same fixed-size pieces), press 4 introduces
               // subdivisions. Layer 2's own gap width grows with
               // damage, stretch, and further presses just like
               // Layer 1 does — so subdivisions also spread apart
               // progressively once they've appeared, exposing more
               // slime as press count climbs from 4 to 5.
               vec2 v2 =
                 damageVoronoi(vRest * 5.0 + vec3(37.1, 11.3, 88.7));
               float visLayer2 = smoothstep(3.4, 4.0, vCrackLevel);
               float perCell2 = 0.3 + v2.y * 1.4;
               float damageWidth2 =
                 smoothstep(0.3, 0.85, vDamage) * 0.08;
               float stretchWidth2 = clamp(vStretch, 0.0, 0.4) * 0.28;
               float spreadWidth2 =
                 smoothstep(3.4, 5.0, vCrackLevel) * 0.08;
               float rawWidth2 =
                 (damageWidth2 + stretchWidth2 + spreadWidth2) * perCell2;
               // Layer 2 appears with a chunky starting gap the moment
               // it activates (press 4) so subdivisions don't look
               // like faint hairlines — they read as proper cracks
               // from their very first frame of visibility.
               float minVisibleWidth2 = visLayer2 * 0.08;
               float width2 = min(max(rawWidth2, minVisibleWidth2), 0.22);
               float layer2 = (1.0 - step(width2, v2.x)) * visLayer2;

               // Layer 3: even FINER subdivisions — kicks in on the
               // FIFTH press event (crackLevel 4.5+), splitting
               // layer-2 pieces one more time.
               vec2 v3 =
                 damageVoronoi(vRest * 9.0 + vec3(70.7, 44.4, 91.2));
               float visLayer3 = smoothstep(4.5, 4.9, vCrackLevel);
               float perCell3 = 0.3 + v3.y * 1.2;
               float rawWidth3 = width1 * 0.55;
               float minVisibleWidth3 = visLayer3 * 0.025;
               float width3 = min(max(rawWidth3, minVisibleWidth3), 0.18);
               float layer3 = (1.0 - step(width3, v3.x)) * visLayer3;

               // Combine — max so every visible layer contributes.
               // Piece SIZE stays constant; press count only adds more
               // interior crack lines that subdivide existing pieces.
               crackReveal = max(max(layer1, layer2), layer3);
             }

             // ── FOIL: thin metallic sheet TEAR model ──────────────
             // Foil tears aggressively under sustained pressure —
             // crack widths GROW continuously with damage AND stretch,
             // so any real press quickly gapes tears wide open,
             // exposing large patches of slime through the torn sheet.
             // Cracks have SOFT wispy edges rather than wax's hard
             // fragment boundaries.
             else if (uCoatingIsFoil > 0.5 && vCrackLevel > 0.4) {
               vec2 v = damageVoronoi(vRest * 2.3);

               // Visibility is LOCAL to the press site only — damage
               // and crackLevel are both per-vertex signals that spike
               // at pressed verts. vStretch was removed from this
               // channel because press-machine physics bulges the
               // equator whenever any spot is pressed, and if stretch
               // triggered visibility the whole ball would flash tears
               // on a single tap. Now a tap only rips the coating
               // right where the finger landed.
               // Visibility ramps in more gradually — a light tap only
               // hints at hairline tears, and repeated / sustained
               // pressure opens the reveal further.
               float visibility = max(
                 smoothstep(0.12, 0.35, vDamage),
                 smoothstep(0.6, 1.4, vCrackLevel)
               );

               // Tear width — damage + crackLevel drive it. Stretch
               // is DROPPED here too so bulged non-pressed regions
               // don't get widened tears just from volume preservation.
               // Widths grow more slowly than before so the inner
               // slime is unveiled gradually rather than all at once.
               float damageWidth = smoothstep(0.28, 0.85, vDamage) * 0.32;
               float spreadWidth =
                 smoothstep(1.0, 4.5, vCrackLevel) * 0.22;
               float perCell = 0.3 + v.y * 1.8;
               float crackWidth =
                 min((damageWidth + spreadWidth) * perCell, 0.62);

               // Soft 15% edge band — torn foil has wispy, feathered
               // edges, not the hard-edged perimeter ice fragments
               // show. This is the visual difference between "torn"
               // and "shattered".
               float edgeBand = min(0.004, crackWidth * 0.15);
               crackReveal = (1.0 - smoothstep(
                 crackWidth - edgeBand,
                 crackWidth,
                 v.x
               )) * visibility;
             }
           }

           // No tap-count intensity multiplier — visibility stays
           // at full opacity from the FIRST tap. Range/area growth
           // is handled by the per-branch width formulas above,
           // which start small at crackLevel 1 and widen with each
           // additional tap (and with continuous long-press growth).
           // Cracks reveal the slime's own base colour (snapshotted
           // before the coating overrode diffuseColor). Ice and wax
           // cracks brighten a little toward a wet-cream tone so
           // slime showing through the shell reads as glistening
           // wet; foil shows the raw slime colour unaltered.
           vec3 wetReveal = mix(slimeBaseColor, vec3(1.0), 0.35);
           float wetMix = max(uCoatingIsIce, uCoatingIsWax);
           vec3 crackTarget = mix(slimeBaseColor, wetReveal, wetMix);
           diffuseColor.rgb =
             mix(diffuseColor.rgb, crackTarget, crackReveal);

           if (uInkAmount > 0.005) {
             float t = inkTurb(vRest * 1.6);
             // Amount controls the RIBBON WIDTH — small amount = thin swirl
             // (only near zero-crossings), large amount = fat marble field.
             // Mask stays fully saturated inside the ribbon so a thin
             // stroke reads as saturated ink, not faint ink.
             float threshold = 0.05 + 0.65 * uInkAmount;
             float band = 1.0 - smoothstep(0.0, threshold, abs(t));
             diffuseColor.rgb =
               mix(diffuseColor.rgb, uInkColor, clamp(band, 0.0, 1.0));
           }

           // Matte foam pattern — mottles the base slime colour with fine
           // brightness variation so the surface reads as aerated bath
           // foam (see reference capture). Only mixes when NO crack-
           // drawing coating is active (wax/foil/ice/tube all paint
           // the whole shell with their own tint, so foam speckle
           // would leak onto those surfaces).
           float vFoam = 0.0;
           if (uMaterialIsMatte > 0.5 && uDamageEnabled < 0.5) {
             // Two-scale foam: fbm gives soft cellular pockets, a second
             // higher-frequency layer adds tiny bubble highlights.
             float fbm = foamFbm(vRest * 22.0);
             float fine = foamNoise(vRest * 55.0);
             vFoam = clamp(fbm * 0.75 + fine * 0.35, 0.0, 1.0);
             // Both bubble masks push toward DARKER shades of the slime's
             // OWN colour — no added white/grey. Mid-frequency pockets
             // get a mild darken (subtle mottling) and the deep pockets
             // get a stronger darken (bubble crevice), so foam always
             // reads as a darker tone of whatever colour the slime is
             // (mint slime → darker mint pockets, pink slime → darker
             // pink pockets), matching the reference capture.
             // Widen the smoothstep bands so more of the surface takes
             // a darkening pass — reduces the amount of pure slime-tone
             // area between pockets, pushing the overall look darker.
             float bright = smoothstep(0.4, 0.9, vFoam);
             float shade  = smoothstep(0.6, 0.1, vFoam);
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
           }

           `
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
           if (crackReveal > 0.0) {
             // Ice cracks expose wet inner cream — nearly mirror glossy.
             // Foil tears expose raw slime body — soft slime gloss, not
             // mirror, so the exposed patch reads as squishy rather than
             // as another shiny surface layer.
             float crackRoughness = mix(0.12, 0.35, uCoatingIsFoil);
             roughnessFactor =
               mix(roughnessFactor, crackRoughness, crackReveal * 0.9);
           }
           // Matte foam roughness modulation. Bright bubble spots
           // (highlights) drop roughness a touch so a tiny glint reads
           // as the top of an aerated bubble, while shaded pockets push
           // roughness up so the cavity looks dry / dusty. The overall
           // material stays matte — this is just enough variation to
           // fake surface bumps without a normal map.
           if (uMaterialIsMatte > 0.5 && uDamageEnabled < 0.5) {
             float bright = smoothstep(0.55, 0.95, vFoam);
             float shade  = smoothstep(0.45, 0.05, vFoam);
             roughnessFactor =
               clamp(roughnessFactor + shade * 0.15 - bright * 0.35, 0.05, 1.0);
           }`
        )
        .replace(
          '#include <metalnessmap_fragment>',
          `#include <metalnessmap_fragment>
           if (crackReveal > 0.0 && uCoatingIsFoil > 0.5) {
             // Torn foil exposes non-metallic slime — kill metalness in
             // the crack area so the base colour is rendered as diffuse
             // slime instead of being swallowed by the specular BRDF.
             metalnessFactor = mix(metalnessFactor, 0.0, crackReveal);
           }`
        )
        .replace(
          // Boost the diffuse contribution inside the crack strips so the
          // bright slime clearly punches through the ice's cool sheen tint.
          'vec3 totalDiffuse = reflectedLight.directDiffuse',
          `if (crackReveal > 0.01) {
             reflectedLight.directDiffuse *= mix(1.0, 1.95, crackReveal);
             reflectedLight.indirectDiffuse *= mix(1.0, 1.7, crackReveal);
           }
           vec3 totalDiffuse = reflectedLight.directDiffuse`
        )
  }
  material.needsUpdate = true
}
