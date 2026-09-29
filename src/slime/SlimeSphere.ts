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
  /** Which UI theme drives the crystal rim brightness (see setEdgeTheme
   *  for the visual rationale). Default 'dark' matches the app's boot
   *  theme; SlimeApp pushes the actual value on mount + on toggle. */
  private currentEdgeTheme: 'dark' | 'light' = 'dark'
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
  /** 1 when the coating is 젤 (tube). Tube shares foil's damage/crack
   *  shader path (both flip uCoatingIsFoil for the tear pattern) but
   *  its SHELL is glossy PAPER — no metallic reflection — so this
   *  extra flag lets the shell roughness / metalness branches override
   *  the metal shell that foil forces. */
  private readonly damageIsTubeUniform = { value: 0.0 }
  /** Shader uniform: 1 when the (new, crack-less) wax coating is active,
   *  0 otherwise. Only used to gate the shader's diffuse override (wax
   *  paints the whole surface in the coating colour) — wax has no
   *  shatter behaviour, so this flag never touches the crack pass. */
  private readonly damageIsWaxUniform = { value: 0.0 }
  /** Wax coating "coat" opacity 0..1 — how much of the wax tint
   *  overrides the underlying slime colour. 1.0 = full opaque wax
   *  shell (default 4콧), 0.1 = a thin single-coat wax where most
   *  of the inner slime shows through. Only sampled inside the
   *  wax branch of the shader; other coatings render at full alpha. */
  private readonly waxThicknessAlphaUniform = { value: 1.0 }
  /** 1 when a wax/thinwax coating is active on the OUTER slime — used
   *  by the BODY shader to suppress text drawing (both pre-coating and
   *  above-coating branches). The wax SHELL mesh renders the text
   *  itself; without this suppression, cracks in the shell would
   *  reveal a SECOND text baked into the body underneath, which reads
   *  as "text painted on the inner slime" instead of "text on the
   *  wax". Only the body material passes this uniform; the shell's
   *  own copy stays at 0 so shell text keeps drawing. */
  private readonly bodyHasWaxShellUniform = { value: 0.0 }
  /** Shader uniform: 1 when the base material is matte, 0 otherwise. Toggles
   *  a procedural foam pattern in the fragment shader so matte slime reads
   *  as an aerated / bubbly cream (like whipped bath foam) instead of a
   *  flat matte surface — matches the reference capture. Ignored under
   *  crack-drawing coatings (foil/wax/ice paint the whole shell). */
  private readonly materialIsMatteUniform = { value: 0.0 }
  /** Shader uniform: 1 when the 아이스 material is active. Gates a
   *  fragment-shader normal-perturbation mixin that samples a noise
   *  gradient in rest space and offsets the surface normal so the
   *  transparent glass body reads with a fine "자글자글" wrinkled /
   *  crinkled texture instead of a perfectly smooth mirror. */
  private readonly materialIsIceUniform = { value: 0.0 }
  /** Shader uniform: 1 when 크런치 is on. Enables a vertex-shader mixin
   *  that samples a Fibonacci-like hash at each vertex's rest position
   *  and adds a small outward bump displacement proportional to the
   *  vertex's INWARD compression amount. Result: pressing an opaque
   *  slime makes tiny "grain" bumps appear on the surface where the
   *  finger is squeezing (like biting into a candy with beads inside). */
  private readonly crunchOnUniform = { value: 0.0 }
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
  /** Multi-colour ink palette. When >1 colour is picked the shader
   *  samples this LUT with a secondary turbulence noise so different
   *  regions of the marble ribbon read as different hues; single-
   *  colour ink keeps the plain `uInkColor` path. */
  private readonly inkGradientUseUniform = { value: 0.0 }
  private readonly inkGradientTexUniform: {
    value: THREE.Texture | null
  } = { value: null }
  private inkGradientTexture: THREE.DataTexture | null = null
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
  // 텍스트 데칼 uniforms — SINGLE decal per slime. Canvas ships a
  // pure-white alpha mask; the shader tints those alpha pixels by
  // uTextColor at draw time. `aboveCoating` toggles whether the
  // composition happens BEFORE (buried under coating) or AFTER
  // (crisp over coating) the slime's coating tint block.
  private static readonly TEXT_FALLBACK_TEX: THREE.DataTexture = (() => {
    const t = new THREE.DataTexture(
      new Uint8Array([0, 0, 0, 0]),
      1,
      1,
      THREE.RGBAFormat
    )
    t.needsUpdate = true
    return t
  })()
  private readonly textUseUniform = { value: 0.0 }
  private readonly textMapUniform: { value: THREE.Texture } = {
    value: SlimeSphere.TEXT_FALLBACK_TEX
  }
  private readonly textAxisUniform = { value: new THREE.Vector3(0, 0, 1) }
  private readonly textColorUniform = { value: new THREE.Color(0, 0, 0) }
  private readonly textRadiusUniform = { value: 0.42 }
  private readonly textAboveCoatingUniform = { value: 0.0 }
  private textTexture: THREE.Texture | null = null
  /** Per-vertex nearest-bead unit direction stored as an attribute. */
  private beadDirAttr!: THREE.BufferAttribute
  private accumulatedForce = 0

  /** wax shell — single OUTER wax surface wrapping the slime at
   *  SHELL_OUTER × slime radius. Cracks discard fragments so the
   *  slime shows through the gap; a rim-darkening shader trick at
   *  the discard threshold fakes wall thickness at crack edges.
   *  Positions / damage / crackLevel are copied from the slime each
   *  frame so the shell deforms with the slime body it wraps. */
  private shellMesh!: THREE.Mesh
  private shellMaterial!: THREE.MeshPhysicalMaterial
  private readonly shellModeUniform = { value: 0.0 }
  private shellPositions!: Float32Array
  private shellDamage!: Float32Array
  private shellCrackLevel!: Float32Array
  private shellPositionAttr!: THREE.BufferAttribute
  private shellDamageAttr!: THREE.BufferAttribute
  private shellCrackLevelAttr!: THREE.BufferAttribute
  /** Independent uniform bank for the shell so it can render wax while
   *  the slime body renders 'none'. Isolated from the body's damage /
   *  coating flags. */
  private readonly shellDamageEnabledUniform = { value: 1.0 }
  private readonly shellDamageIsFoilUniform = { value: 0.0 }
  private readonly shellDamageIsIceUniform = { value: 0.0 }
  private readonly shellDamageIsWaxUniform = { value: 1.0 }
  private readonly shellDamageIsTubeUniform = { value: 0.0 }
  private readonly shellWaxThicknessAlphaUniform = { value: 1.0 }
  /** Default outer wax shell radius as a multiplier of the slime
   *  radius. Runtime `this.shellRadius` overrides this per coating. */
  private static readonly SHELL_OUTER = 1.02
  /** Per-coating shell radii. thinwax hugs closest, wax slightly
   *  further out. */
  private static readonly SHELL_RADII = {
    thinwax: 1.005,
    wax: 1.02
  } as const
  /** Live shell radius used by _updateShellGeometry each frame. */
  private shellRadius = SlimeSphere.SHELL_OUTER

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
      clearcoat: 0.001, // >0 so USE_CLEARCOAT define fires at compile
      clearcoatRoughness: 0,
      // sheen must be initialised > 0 so USE_SHEEN is defined at
      // program compile time — _applyLook later dials it up to 1.0
      // for coated slime to brighten the grazing-angle rim, and that
      // increase is a no-op unless the shader was built with sheen
      // enabled from the start.
      sheen: 0.01,
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
      this.damageIsTubeUniform,
      this.materialIsMatteUniform,
      this.materialIsIceUniform,
      this.coatingTintUniform,
      this.inkColorUniform,
      this.inkAmountUniform,
      this.inkGradientUseUniform,
      this.inkGradientTexUniform,
      this.beadRadiusUniform,
      this.beadWrapAmountUniform,
      this.gradientUseUniform,
      this.gradientTexUniform,
      this.gradientRadiusUniform,
      this.coatingGradientUseUniform,
      this.coatingGradientTexUniform,
      this.photoUseUniform,
      this.photoMapUniform,
      this.photoRadiusUniform,
      this.textUseUniform,
      this.textMapUniform,
      this.textAxisUniform,
      this.textColorUniform,
      this.textRadiusUniform,
      this.textAboveCoatingUniform,
      this.waxThicknessAlphaUniform,
      this.crunchOnUniform,
      // shellModeUniform default (body is not a shell)
      { value: 0 },
      // bodyHasWaxShellUniform — flips to 1 when setCoating enters
      // wax/thinwax so the body suppresses its text under the shell.
      this.bodyHasWaxShellUniform
    )

    this.mesh = new THREE.Mesh(this.geometry, material)
    this.mesh.castShadow = false
    this.mesh.receiveShadow = false

    // wax shell mesh — separate material with its OWN uniform bank
    // so it can render as wax even when the slime body coating is
    // 'none'. Shares this.geometry so vertex physics deforms both
    // meshes in sync; scaled outward by SHELL_SCALE to sit as a
    // bigger sphere/cube/rect/twist wrapping the slime body. Wax
    // shell params (matte, opaque, coating tint) match how the wax
    // coating draws on the slime body so the two look identical at
    // rest — the ONLY visible difference on press is that shell
    // cracks discard fragments (slime shows through) instead of
    // painting a "cracked" colour on the shell surface itself.
    // Wax bead material — one material for both outer + inner surfaces
    // of the hollow-bead geometry. Matte wax params with a hint of
    // clearcoat for wet sheen.
    this.shellMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xfbf7f2,
      roughness: 0.5,
      metalness: 0,
      transmission: 0,
      thickness: 0,
      ior: 1.5,
      clearcoat: 0.001,
      clearcoatRoughness: 0,
      sheen: 0.01,
      sheenColor: new THREE.Color(0xffffff),
      iridescence: 0,
      side: THREE.DoubleSide
    })
    // Outer discard threshold. Fragments on the inner surface fall
    // back to a higher threshold (0.85) via the fragment shader's
    // mix(uShellMode, 0.85, vShellSide) so a crack cuts through the
    // outer wall first and only the widest cracks reach the inner.
    this.shellModeUniform.value = 0.2
    installDamageShader(
      this.shellMaterial,
      this.shellDamageEnabledUniform,
      this.shellDamageIsFoilUniform,
      this.shellDamageIsIceUniform,
      this.shellDamageIsWaxUniform,
      this.shellDamageIsTubeUniform,
      this.materialIsMatteUniform,
      this.materialIsIceUniform,
      this.coatingTintUniform,
      this.inkColorUniform,
      this.inkAmountUniform,
      this.inkGradientUseUniform,
      this.inkGradientTexUniform,
      this.beadRadiusUniform,
      this.beadWrapAmountUniform,
      this.gradientUseUniform,
      this.gradientTexUniform,
      this.gradientRadiusUniform,
      this.coatingGradientUseUniform,
      this.coatingGradientTexUniform,
      this.photoUseUniform,
      this.photoMapUniform,
      this.photoRadiusUniform,
      this.textUseUniform,
      this.textMapUniform,
      this.textAxisUniform,
      this.textColorUniform,
      this.textRadiusUniform,
      this.textAboveCoatingUniform,
      this.shellWaxThicknessAlphaUniform,
      this.crunchOnUniform,
      this.shellModeUniform
    )
    const beadGeo = this._buildHollowBeadGeometry()
    this.shellMesh = new THREE.Mesh(beadGeo, this.shellMaterial)
    this.shellMesh.castShadow = false
    this.shellMesh.receiveShadow = false
    this.shellMesh.frustumCulled = false
    this.shellMesh.visible = false
    this.shellMesh.renderOrder = 2
    this.mesh.add(this.shellMesh)


    // Kick _applyLook once at construction so the crystal-material
    // specularIntensity (and any other coating-driven material params)
    // land on the correct values from the very first render. Without
    // this the material stayed at three.js's default specularIntensity
    // = 1.0 until the user did SOMETHING that fired _applyLook (change
    // material / coating / tag reset), which meant the default crystal
    // slime rendered with a hard mirror rim on first paint.
    this._applyLook()
  }

  /** Wax coating rendering params applied to the shell material each
   *  time the coating tint changes. thinwax renders the shell with
   *  reduced opacity so the slime shows through the wax — preserves
   *  the semantic difference from opaque wax which shares
   *  the same fully-opaque shell. */
  private _applyShellLook() {
    const mat = this.shellMaterial
    mat.color.setHex(this.currentCoatingColorHex)
    mat.roughness = 0.5
    mat.metalness = 0
    mat.transmission = 0
    mat.thickness = 0
    mat.clearcoat = 0
    mat.sheen = 1.0
    mat.sheenRoughness = 0.85
    mat.sheenColor.setHex(0xffffff)
    mat.iridescence = 0
    mat.envMapIntensity = 2.2
    const thinwax = this.currentCoatingId === 'thinwax'
    mat.transparent = thinwax
    mat.opacity = thinwax ? 0.55 : 1.0
    mat.depthWrite = !thinwax
    mat.needsUpdate = true
  }

  /** Build the OUTER wax-bead shell geometry ONCE at construction.
   *  Single surface (outer only — inner face removed per user request;
   *  the rim-darkening shader depth-fake gives the wall its perceived
   *  thickness). Positions / damage / crackLevel are refreshed each
   *  frame from slime by _updateShellGeometry(). */
  private _buildHollowBeadGeometry(): THREE.BufferGeometry {
    const N = this.vertexCount
    const idxArr = this.geometry.index!.array as Uint16Array | Uint32Array
    const M = idxArr.length / 3
    const positions = new Float32Array(N * 3)
    const damage = new Float32Array(N)
    const crackLevel = new Float32Array(N)
    const restPos = new Float32Array(N * 3)
    const beadDir = new Float32Array(N * 3)
    for (let i = 0; i < N; i++) {
      const rx = this.restPositions[i * 3]
      const ry = this.restPositions[i * 3 + 1]
      const rz = this.restPositions[i * 3 + 2]
      positions[i * 3] = rx * SlimeSphere.SHELL_OUTER
      positions[i * 3 + 1] = ry * SlimeSphere.SHELL_OUTER
      positions[i * 3 + 2] = rz * SlimeSphere.SHELL_OUTER
      restPos[i * 3] = rx
      restPos[i * 3 + 1] = ry
      restPos[i * 3 + 2] = rz
    }
    const indices = new Uint32Array(M * 3)
    let k = 0
    for (let t = 0; t < M; t++) {
      indices[k++] = idxArr[t * 3]
      indices[k++] = idxArr[t * 3 + 1]
      indices[k++] = idxArr[t * 3 + 2]
    }
    const geo = new THREE.BufferGeometry()
    this.shellPositions = positions
    this.shellDamage = damage
    this.shellCrackLevel = crackLevel
    this.shellPositionAttr = new THREE.BufferAttribute(positions, 3)
    this.shellPositionAttr.setUsage(THREE.DynamicDrawUsage)
    this.shellDamageAttr = new THREE.BufferAttribute(damage, 1)
    this.shellDamageAttr.setUsage(THREE.DynamicDrawUsage)
    this.shellCrackLevelAttr = new THREE.BufferAttribute(crackLevel, 1)
    this.shellCrackLevelAttr.setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('position', this.shellPositionAttr)
    geo.setAttribute('damage', this.shellDamageAttr)
    geo.setAttribute('crackLevel', this.shellCrackLevelAttr)
    geo.setAttribute('aRestPos', new THREE.BufferAttribute(restPos, 3))
    geo.setAttribute('aBeadDir', new THREE.BufferAttribute(beadDir, 3))
    geo.setIndex(new THREE.BufferAttribute(indices, 1))
    geo.computeVertexNormals()
    return geo
  }

  /** Mirror slime's live positions / damage / crackLevel into the
   *  shell geometry each frame while the shell is visible. Single
   *  outer surface — inner face was removed per user request; the
   *  shader's rim-darkening depth-fake gives the visible wall its
   *  thickness cue. Cheap: O(vertex count) per frame. */
  private _updateShellGeometry() {
    if (!this.shellMesh.visible) return
    const N = this.vertexCount
    const src = this.geometry.attributes.position.array as Float32Array
    const outer = this.shellRadius
    const dst = this.shellPositions
    const dmgSrc = this.damage
    const dmgDst = this.shellDamage
    const clSrc = this.crackLevel
    const clDst = this.shellCrackLevel
    for (let i = 0; i < N; i++) {
      dst[i * 3] = src[i * 3] * outer
      dst[i * 3 + 1] = src[i * 3 + 1] * outer
      dst[i * 3 + 2] = src[i * 3 + 2] * outer
      dmgDst[i] = dmgSrc[i]
      clDst[i] = clSrc[i]
    }
    this.shellPositionAttr.needsUpdate = true
    this.shellDamageAttr.needsUpdate = true
    this.shellCrackLevelAttr.needsUpdate = true
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

    // Preset mesh orientation per shape. Cube / rect get a 3/4 hero
    // view (yaw so the right face peeks in + pitch so the top face
    // peeks down) so the user immediately sees the box silhouette
    // rather than a flat square / bar face. Sphere / twist reset to
    // identity so their symmetric silhouettes read straight-on.
    if (shape === 'cube' || shape === 'rect') {
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
    // When 글레이즈 (ice) coating is active, mat.color is owned by the
    // coating tint (crystal-glaze look) rather than by the slime pick —
    // don't stomp on it here or the coating's colour would flicker back
    // to the slime hue whenever the user re-runs setColors.
    const iceCoatingActive = this.currentCoatingId === 'ice'
    // 소프트 material + default / white base needs a slightly-grey tint
    // (instead of near-white) so press dents cast visible shadows. The
    // matte surface's env + hemi contribution otherwise fills the
    // shaded side almost to the same brightness as the lit side —
    // giving the dent nothing to visually stand out against. A gentle
    // tint darkens BOTH sides but the delta between them stays the
    // same in absolute terms, which reads as stronger contrast at the
    // dent boundary. Applied only when no coating is active.
    const softShadowBoost =
      this.currentMaterialId === 'soft' &&
      this.currentCoatingId === 'none'
    if (hexes.length === 0) {
      if (!iceCoatingActive) {
        mat.color.setHex(softShadowBoost ? 0xd6d6d6 : 0xfbf7f2)
      }
      this.gradientUseUniform.value = 0
      return
    }
    if (!iceCoatingActive) {
      let hex = hexes[0]
      if (softShadowBoost && ids[0] === 'white') hex = 0xd6d6d6
      mat.color.setHex(hex)
    }
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
    this.materialIsIceUniform.value = id === 'ice' ? 1.0 : 0.0
    this._applyLook()
    // Re-run colour resolution so the soft-material shadow-tint (see
    // setColors) is applied or removed as the material changes into or
    // out of 소프트.
    this.setColors(this.currentColorIds)
  }

  /** Outer surface treatment. Non-`none` coatings add clearcoat + accent
   *  sheen tinted by the user's coating colour; ice/foil turn on the crack
   *  shader so kneading draws cracks (ice) or wrinkles / tears (foil). */
  /** How opaque the wax coating overlay reads — see waxThicknessAlpha
   *  uniform. 1 = full 4-coat opaque, 0.1 = 1-coat thin translucent
   *  layer that lets the inner slime show through. */
  setWaxThicknessAlpha(a: number) {
    this.waxThicknessAlphaUniform.value = Math.max(0, Math.min(1, a))
  }

  setCrunchOn(on: boolean) {
    this.crunchOnUniform.value = on ? 1.0 : 0.0
  }

  /** UI theme drives the crystal material's grazing-angle rim brightness:
   *  the mirror-smooth crystal picks up the environment map strongly at
   *  edges (Schlick fresnel → nearly full reflectance at grazing) which
   *  reads as a bright white outline. Dial specularIntensity down per
   *  theme so:
   *    light mode → edges settle into a pale grey rim that blends into
   *      the light-mode background rather than punching out as white.
   *    dark mode → the white rim stays present but subdued so the
   *      crystal shape reads without a hard mirror outline.
   *  Non-crystal materials keep specularIntensity = 1 (default). */
  setEdgeTheme(theme: 'dark' | 'light') {
    this.currentEdgeTheme = theme
    this._applyLook()
  }

  setCoating(id: CoatingId) {
    this.currentCoatingId = id
    this._applyLook()
    const hasCracks =
      COATINGS.find((c) => c.id === id)?.params.hasCracks ?? false
    this.setDamageRenderingEnabled(hasCracks)
    // Toggle the wax hollow shell. Body still reads its coating id
    // for material params (wax / thinwax are excluded from the
    // coated-body branches in _applyLook so the body renders as
    // user's material — the two wax coatings render via the
    // separate shell mesh).
    const isShellWax = id === 'wax' || id === 'thinwax'
    this.shellMesh.visible = isShellWax
    // Suppress body text under a wax shell so cracks don't reveal a
    // second baked-in copy of the letters on the inner slime.
    this.bodyHasWaxShellUniform.value = isShellWax ? 1.0 : 0.0
    if (isShellWax) {
      // Per-coating shell radius — thinwax hugs slightly closer.
      this.shellRadius =
        id === 'thinwax'
          ? SlimeSphere.SHELL_RADII.thinwax
          : SlimeSphere.SHELL_RADII.wax
      this._applyShellLook()
    }
    // 'tube' piggybacks on the foil shader path — same wispy tear
    // behaviour, and the paper's metalness is 0 so the foil-only
    // "kill metalness in crack" step is a no-op.
    this.damageIsFoilUniform.value =
      id === 'foil' || id === 'tube' ? 1.0 : 0.0
    this.damageIsIceUniform.value = id === 'ice' ? 1.0 : 0.0
    // Wax family now renders on the SHELL mesh instead of the body,
    // so the body's wax uniform stays off. Damage still accumulates
    // per-vertex (used by the shell's own shader for cracks) — this
    // uniform only gates the BODY shader's wax visual which we're
    // taking off.
    this.damageIsWaxUniform.value = 0.0
    this.damageIsTubeUniform.value = id === 'tube' ? 1.0 : 0.0
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
    // Keep the shell tint in sync — the shell shares coatingTintUniform
    // (uCoatingTint drives its wax diffuse), but its base material.color
    // needs the hex applied directly since it's a separate material.
    if (
      this.currentCoatingId === 'wax' ||
      this.currentCoatingId === 'thinwax'
    ) {
      this._applyShellLook()
    }
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
    if (
      this.currentCoatingId === 'wax' ||
      this.currentCoatingId === 'thinwax'
    ) {
      this._applyShellLook()
    }
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

  /** Ink marble effect. `hexes` = ordered palette (1..N colours).
   *  Single-colour ink flat-tints uInkColor across the entire swirl.
   *  Multi-colour ink builds a 1D LUT the shader samples with a
   *  secondary turbulence noise so every colour appears somewhere in
   *  the ribbon instead of only the first being applied. `amount` in
   *  [0, 1+] controls ribbon width; 0 fully disables. */
  setInk(hexes: readonly number[], amount: number) {
    const primary = hexes[0] ?? 0xffffff
    this.inkColorUniform.value.setHex(primary)
    this.inkAmountUniform.value = Math.max(0, Math.min(1, amount))
    if (hexes.length > 1) {
      this.rebuildInkGradientTexture(hexes)
      this.inkGradientUseUniform.value = 1.0
    } else {
      this.inkGradientUseUniform.value = 0.0
    }
  }

  private rebuildInkGradientTexture(hexes: readonly number[]) {
    if (this.inkGradientTexture) this.inkGradientTexture.dispose()
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
      data[i * 4] = Math.round((cA.r * (1 - frac) + cB.r * frac) * 255)
      data[i * 4 + 1] = Math.round((cA.g * (1 - frac) + cB.g * frac) * 255)
      data[i * 4 + 2] = Math.round((cA.b * (1 - frac) + cB.b * frac) * 255)
      data[i * 4 + 3] = 255
    }
    const tex = new THREE.DataTexture(data, size, 1, THREE.RGBAFormat)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.minFilter = THREE.LinearFilter
    tex.magFilter = THREE.LinearFilter
    tex.wrapS = THREE.ClampToEdgeWrapping
    tex.wrapT = THREE.ClampToEdgeWrapping
    tex.needsUpdate = true
    this.inkGradientTexture = tex
    this.inkGradientTexUniform.value = tex
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

  /** Swap the text decal texture. Passing null rebinds the shared
   *  transparent fallback so the sampler stays bound. Disposes the
   *  previous texture when the incoming reference differs. */
  setTextDecal(texture: THREE.Texture | null) {
    const prev = this.textTexture
    if (prev && prev !== texture) prev.dispose()
    this.textTexture = texture
    this.textMapUniform.value = texture ?? SlimeSphere.TEXT_FALLBACK_TEX
    this.textUseUniform.value = texture ? 1.0 : 0.0
  }

  /** Camera-facing text axis update — cheap per-frame call from the
   *  sphere-shape render loop so the decal always faces the viewer. */
  setTextAxis(axisX: number, axisY: number, axisZ: number) {
    const len = Math.hypot(axisX, axisY, axisZ) || 1
    this.textAxisUniform.value.set(axisX / len, axisY / len, axisZ / len)
  }

  /** Toggle whether text renders ABOVE the coating (crisp on top of
   *  foil / wax / ice) vs BELOW (buried, gets tinted by translucent
   *  coats). */
  setTextAboveCoating(above: boolean) {
    this.textAboveCoatingUniform.value = above ? 1.0 : 0.0
  }

  /** Text tint. Canvas ships white alpha mask; the shader multiplies
   *  this hex against the canvas alpha to colour each fragment. Colour
   *  changes are a single uniform write with no texture upload. */
  setTextColor(hex: number) {
    this.textColorUniform.value.setHex(hex)
  }

  /** True when a text decal is currently uploaded — the render loop
   *  uses this to skip per-frame axis math when there's no text. */
  hasTextDecal(): boolean {
    return this.textUseUniform.value > 0.5
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
    // Coating keeps the user's ROUGHNESS + METALNESS on the base material
    // (shader mixin overrides them to coating-specific values on the shell
    // and reverts to base in crack areas — see roughnessmap_fragment). But
    // transmission / sheen / iridescence are ZEROED at the material level
    // whenever a coating is active so the coating diffuse reads with the
    // SAME tone regardless of which underlying material the user picked.
    // Wax family coatings (wax / thinwax) are excluded — wax now
    // lives on a SEPARATE shell mesh wrapping the slime, so the
    // slime body itself renders as the user's chosen base material
    // (no shader wax overlay on the body).
    if (
      this.currentCoatingId !== 'none' &&
      this.currentCoatingId !== 'wax' &&
      this.currentCoatingId !== 'thinwax'
    ) {
      mat.transmission = 0
      mat.thickness = 0
      // Coated slime gets a FULL-strength white grazing-angle sheen so
      // the rim doesn't collapse into a dim grey band. Env-reflection
      // alone at the coating's dielectric F0 (~4%) leaves the rim much
      // darker than the interior. sheen=1.0 with wide sheenRoughness
      // (0.85) spreads a bright white glow across the whole grazing
      // band; combined with the envMapIntensity boost below, the rim
      // reads as pale white blending into the light-mode background.
      mat.sheen = 1.0
      mat.sheenRoughness = 0.85
      mat.sheenColor.setHex(0xffffff)
      mat.iridescence = 0
    }
    // Foil / tube (젤) / ice (글레이즈) coatings ship with a full mirror
    // clearcoat (1.0) that BLOCKS the base BRDF — including the sheen —
    // at grazing angles (clearcoat fresnel = 1 at the rim). Dial down
    // to 0.35 so a softer lacquer stays on for the wet look while the
    // sheen glow can still bleed through and blend the rim into the
    // interior tone. Wax coatings already have clearcoat=0 so this
    // branch doesn't apply.
    if (
      this.currentCoatingId === 'foil' ||
      this.currentCoatingId === 'tube' ||
      this.currentCoatingId === 'ice'
    ) {
      mat.clearcoat = 0.35
    }
    // 글레이즈 (ice) coating is meant to READ AS CRYSTAL — a clear
    // candy-glass shell. Override transmission back on so the coating
    // shell renders see-through (crystal material params) rather than
    // as an opaque tint. Roughness / thickness / ior match the crystal
    // preset so the visual matches slime's own crystal material. Also
    // OVERRIDE mat.color = coating tint so both the diffuse contribution
    // AND the transmitted volume light carry the picked colour with the
    // same saturation as a crystal-material-with-colour slime would.
    // Tight attenuationDistance (0.12) pushes Beer-Lambert to saturate
    // the transmitted tint quickly so the light passing through reads
    // as deeply coloured, not a faint hint.
    if (this.currentCoatingId === 'ice') {
      mat.transmission = 0.9
      mat.thickness = 0.4
      mat.ior = 1.5
      mat.color.setHex(this.currentCoatingColorHex)
      mat.attenuationColor.setHex(this.currentCoatingColorHex)
      mat.attenuationDistance = 0.12
    } else {
      // Restore default attenuation (white / infinite) so non-ice
      // coatings and uncoated slime don't inherit a stale glaze tint.
      mat.attenuationColor.setHex(0xffffff)
      mat.attenuationDistance = Infinity
      // Restore mat.color to the user-picked slime colour (or default
      // off-white) so the glaze-override doesn't linger after switching
      // to a non-ice coating. Reads currentColorIds via the same helper
      // setColors uses so the two paths stay in lock-step.
      const slimeHexes = this.currentColorIds.map((id) =>
        resolveColorHex(id, this.currentColorAdjustments)
      )
      mat.color.setHex(slimeHexes[0] ?? 0xfbf7f2)
    }
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
      mat.transmission = 0
      mat.thickness = 0
    }
    // Theme-driven crystal rim brightness — mirror-smooth crystal picks
    // up strong fresnel reflection at grazing angles which reads as a
    // hard white outline. Dial specularIntensity down ONLY for UNCOATED
    // crystal so the rim softens into a pale grey. When a coating is
    // active the coating's own shell response (roughness / metalness set
    // by the shader) drives the edge look; dampening dielectric spec on
    // top of that made foil / tube / glaze rims collapse into a too-dark
    // grey band in light mode — full specularIntensity keeps the coating
    // rim reading correctly. currentEdgeTheme is intentionally unused
    // here (both themes settle on the same 0.55 pale rim) but the
    // setEdgeTheme setter still kicks _applyLook so the value re-lands
    // if we ever wire theme-specific values back in.
    void this.currentEdgeTheme
    if (
      this.currentMaterialId === 'crystal' &&
      this.currentCoatingId === 'none'
    ) {
      mat.specularIntensity = 0.55
    } else {
      mat.specularIntensity = 1.0
    }
    // Coated slime (foil / tube / glaze / wax) picks up a brighter env
    // reflection at grazing so the rim reads as PALE grey rather than
    // the deep grey band it settled into at default envMapIntensity=1.
    // Kept at 1.0 for uncoated slime so the base material's own edge
    // brightness (matte foam / metal / glossy / crystal) isn't shifted
    // by this coating-only boost.
    mat.envMapIntensity =
      this.currentCoatingId !== 'none' &&
      this.currentCoatingId !== 'wax' &&
      this.currentCoatingId !== 'thinwax'
        ? 2.2
        : 1.0
    // 소프트 material with a DEFAULT or WHITE base colour reads too
    // uniformly bright — the ambient env fills the shadowed side of
    // a press dent almost to the same level as the lit side, so the
    // dent barely shows. Dropping env intensity for this specific
    // case deepens the shadowed side (grey shading) without touching
    // any coloured / non-soft combinations.
    if (
      this.currentMaterialId === 'soft' &&
      this.currentCoatingId === 'none'
    ) {
      const ids = this.currentColorIds
      const isDefaultOrWhite =
        ids.length === 0 ||
        (ids.length === 1 && ids[0] === 'white')
      if (isDefaultOrWhite) {
        mat.envMapIntensity = 0.55
      }
    }
    mat.needsUpdate = true
  }

  get restPositionArray(): Float32Array {
    return this.restPositions
  }

  /** Per-vertex accumulated press damage (0..1). Read-only view for
   *  layers that want to react to where cracks are forming (e.g. the
   *  WaxCoatingLayer chip mode fades chips in based on local damage). */
  get damageArray(): Float32Array {
    return this.damage
  }

  /** Per-vertex continuous crack level (0..5) — PROPAGATES across the
   *  mesh so the wax bead's cell layer can activate over the full
   *  crack-territory (matches the shader's spreadVis). */
  get crackLevelArray(): Float32Array {
    return this.crackLevel
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
        : this.currentCoatingId === 'wax' ||
            this.currentCoatingId === 'thinwax'
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
          (this.currentCoatingId === 'wax' ||
            this.currentCoatingId === 'thinwax') &&
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
          this.currentCoatingId === 'thinwax' ||
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
      this.currentCoatingId === 'wax' ||
      this.currentCoatingId === 'thinwax'
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
    // Mirror the deformation + damage / crackLevel into the hollow-
    // bead geometry each frame so the shell tracks the slime. No-op
    // when the shell isn't visible (guard inside).
    this._updateShellGeometry()
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

  /** Aggregate crack progress across every vertex, in 0..1 where 1
   *  means every vertex has reached its per-coating cap (ice → 3,
   *  wax/foil → 5). Used to gate coating loop sounds so the crack
   *  hiss cuts off once the shell is fully shattered — pressing an
   *  already-shattered slime is silent for the coating channel. */
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
    let sum = 0
    const cl = this.crackLevel
    for (let i = 0; i < cl.length; i++) sum += cl[i]
    const max = cl.length * cap
    return max > 0 ? sum / max : 0
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
    this.shellMaterial.dispose()
    this.shellMesh.geometry.dispose()
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
  isTubeUniform: { value: number },
  isMatteUniform: { value: number },
  isIceMatUniform: { value: number },
  coatingTintUniform: { value: THREE.Color },
  inkColorUniform: { value: THREE.Color },
  inkAmountUniform: { value: number },
  inkGradientUseUniform: { value: number },
  inkGradientTexUniform: { value: THREE.Texture | null },
  beadRadiusUniform: { value: number },
  beadWrapAmountUniform: { value: number },
  gradientUseUniform: { value: number },
  gradientTexUniform: { value: THREE.Texture | null },
  gradientRadiusUniform: { value: number },
  coatingGradientUseUniform: { value: number },
  coatingGradientTexUniform: { value: THREE.Texture | null },
  photoUseUniform: { value: number },
  photoMapUniform: { value: THREE.Texture | null },
  photoRadiusUniform: { value: number },
  textUseUniform: { value: number },
  textMapUniform: { value: THREE.Texture },
  textAxisUniform: { value: THREE.Vector3 },
  textColorUniform: { value: THREE.Color },
  textRadiusUniform: { value: number },
  textAboveCoatingUniform: { value: number },
  waxThicknessAlphaUniform: { value: number },
  crunchOnUniform: { value: number },
  /** When 1, the material is a WAX-BEAD SHELL mesh (not the slime
   *  body): crack areas discard the fragment so the slime shows
   *  through the gaps. Slime body materials pass 0 to keep the
   *  existing "crack reveals base colour" behaviour. */
  shellModeUniform: { value: number } = { value: 0 },
  /** When 1, a wax/thinwax shell is currently wrapping the outer
   *  slime — body material uses this to suppress its own text draw so
   *  cracks in the shell reveal a plain slime surface, not a second
   *  copy of the text baked into the body. Shell materials leave this
   *  at 0 (shell always draws its own text). */
  bodyHasWaxShellUniform: { value: number } = { value: 0 }
) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uDamageEnabled = enabledUniform
    shader.uniforms.uCoatingIsFoil = isFoilUniform
    shader.uniforms.uCoatingIsIce = isIceUniform
    shader.uniforms.uCoatingIsWax = isWaxUniform
    shader.uniforms.uCoatingIsTube = isTubeUniform
    shader.uniforms.uMaterialIsMatte = isMatteUniform
    shader.uniforms.uMaterialIsIce = isIceMatUniform
    shader.uniforms.uCoatingTint = coatingTintUniform
    shader.uniforms.uInkColor = inkColorUniform
    shader.uniforms.uInkAmount = inkAmountUniform
    shader.uniforms.uInkGradientUse = inkGradientUseUniform
    shader.uniforms.uInkGradient = inkGradientTexUniform
    shader.uniforms.uWaxThicknessAlpha = waxThicknessAlphaUniform
    shader.uniforms.uCrunchOn = crunchOnUniform
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
    shader.uniforms.uTextUse = textUseUniform
    shader.uniforms.uTextMap = textMapUniform
    shader.uniforms.uTextAxis = textAxisUniform
    shader.uniforms.uTextColor = textColorUniform
    shader.uniforms.uTextRadius = textRadiusUniform
    shader.uniforms.uTextAboveCoating = textAboveCoatingUniform
    shader.uniforms.uShellMode = shellModeUniform
    shader.uniforms.uBodyHasWaxShell = bodyHasWaxShellUniform

    shader.vertexShader =
      `attribute float damage;
       attribute float crackLevel;
       attribute vec3 aRestPos;
       attribute vec3 aBeadDir;
       uniform float uBeadRadius;
       uniform float uBeadWrapAmount;
       uniform float uCrunchOn;
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
         // 크런치 — at Fibonacci-hashed rest positions, add tiny outward
         // bumps whose amplitude tracks how compressed this vertex is
         // right now. Rest state → no bumps; a pressed vertex reveals
         // the "grain" underneath as small pimples pushing back against
         // the compression. Sampled in REST space so grains stay anchored
         // to the slime body across deformation.
         if (uCrunchOn > 0.5) {
           float _crunchCompression =
             max(0.0, -dot(position - aRestPos, restDir));
           float _crunchHash = fract(
             sin(dot(aRestPos * 8.0, vec3(12.9898, 78.233, 45.164))) *
             43758.5453
           );
           float _crunchGrain = smoothstep(0.72, 0.92, _crunchHash);
           float _crunchAmp =
             _crunchCompression * _crunchGrain * 0.35;
           transformed += restDir * _crunchAmp;
         }

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
       uniform float uCoatingIsTube;
       uniform float uMaterialIsMatte;
       uniform float uMaterialIsIce;
       uniform float uWaxThicknessAlpha;
       uniform float uShellMode;
       uniform float uBodyHasWaxShell;
       uniform vec3 uCoatingTint;
       uniform vec3 uInkColor;
       uniform float uInkGradientUse;
       uniform sampler2D uInkGradient;
       uniform float uInkAmount;
       uniform float uUseGradient;
       uniform sampler2D uGradient;
       uniform float uGradientRadius;
       uniform float uUseCoatingGradient;
       uniform sampler2D uCoatingGradient;
       uniform float uPhotoUse;
       uniform sampler2D uPhotoMap;
       uniform float uPhotoRadius;
       uniform float uTextUse;
       uniform sampler2D uTextMap;
       uniform vec3 uTextAxis;
       uniform vec3 uTextColor;
       uniform float uTextRadius;
       uniform float uTextAboveCoating;
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
             // three.js CanvasTexture uploads with flipY=true so V=1
             // corresponds to the canvas's visual top. Map slime Y
             // directly (no 1.0 - flip) so the photo renders upright:
             // slime TOP (vRest.y=1) → V=1 = photo top.
             vec2 pUV = vec2(
               (vRest.x / uGradientRadius) * 0.5 + 0.5,
               (vRest.y / uGradientRadius) * 0.5 + 0.5
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
           // 텍스트 데칼 — three independent slots. When aboveCoating
           // is 0 the mix happens HERE (pre-coating) so a translucent
           // coat tints the text; when 1 the mix is DEFERRED until
           // after the coating block below and this branch becomes a
           // no-op. Each slot is unrolled with a CONSTANT sampler
           // index because WebGL 1 GLSL only permits sampler-array
           // indexing by constant-index-expressions, and some drivers
           // still reject dynamic indexing even on WebGL 2 when the
           // loop body contains a continue statement. Inlining is
           // uglier but safe on every GPU.
           // On the wax SHELL mesh (uShellMode > 0) text is ALWAYS drawn
           // above the coating — the shell IS the wax layer, so drawing
           // text below it would bury the letters inside the wax where
           // only cracks could reveal them. Skip the pre-coat branch
           // on the shell no matter what the user's toggle says; the
           // above-coating branch below then forces the mirror draw.
           // Body under a wax shell (uBodyHasWaxShell) skips its OWN
           // text draw so cracks through the wax reveal a plain slime
           // surface — the shell above already carries the text.
           if (uTextAboveCoating < 0.5 && uShellMode < 0.001 && uBodyHasWaxShell < 0.5) {
             if (uTextUse > 0.5) {
               vec3 rnT = vRest / uGradientRadius;
               vec3 tN = uTextAxis;
               vec3 tU = abs(tN.y) > 0.9 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);
               vec3 tT = normalize(cross(tU, tN));
               vec3 tB = normalize(cross(tN, tT));
               float u = dot(rnT, tT) * 0.5 + 0.5;
               float v = dot(rnT, tB) * 0.5 + 0.5;
               float d = dot(rnT, tN);
               float r = length(vec2(u, v) - 0.5);
               float a = (1.0 - smoothstep(uTextRadius - 0.05, uTextRadius, r))
                       * smoothstep(-0.05, 0.30, d);
               if (a > 0.001) {
                 float _txA = texture2D(uTextMap, vec2(u, v)).a;
                 diffuseColor.rgb = mix(diffuseColor.rgb, uTextColor, _txA * a);
               }
             }
           }
           // Matte foam pattern — mottles the base slime colour with fine
           // brightness variation so the surface reads as aerated bath
           // foam. Applied BEFORE the coating overlay and the
           // slimeBaseColor snapshot so cracks reveal the foam-textured
           // inner slime (matches user request: the material chosen in
           // slime options should show through when the coating cracks).
           float vFoam = 0.0;
           if (uMaterialIsMatte > 0.5) {
             float fbm = foamFbm(vRest * 22.0);
             float fine = foamNoise(vRest * 55.0);
             vFoam = clamp(fbm * 0.72 + fine * 0.32, 0.0, 1.0);
             float bright = smoothstep(0.48, 0.82, vFoam);
             float shade  = smoothstep(0.58, 0.18, vFoam);
             // 점박이 색상 — softened contrast so the foam spots read
             // as PALE mottling rather than deep dark patches. Bright
             // spots stay close to the base tone; shaded pockets darken
             // only mildly. Bumping the multipliers toward 1.0 (from
             // 0.3 / 0.2) and reducing the mix strengths halves the
             // effective darkening at peak values.
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
             // Rare deep-dark speckles — a coarser rest-space noise
             // picks a small subset (~top 20%) of positions where the
             // foam pocket darkens hard instead of softly, so the
             // mostly-pale mottling still shows occasional dark specks
             // for visual variety. Gated by BOTH the rarity hash AND
             // the existing shade mask so dark spots only appear at
             // actual foam depressions, not at random on the surface.
             float _rareDark = smoothstep(0.2, 0.7, foamNoise(vRest * 8.0));
             diffuseColor.rgb = mix(
               diffuseColor.rgb,
               diffuseColor.rgb * 0.2,
               shade * _rareDark
             );
           }
           // Snapshot the slime's own diffuse (including foam pattern +
           // gradient / photo + user-picked colour) BEFORE the coating
           // overlay so cracks / tears reveal the actual material the
           // user chose in slime options.
           vec3 slimeBaseColor = diffuseColor.rgb;

           // Wax, foil, and ice paint the ENTIRE ball in the coating
           // colour so the sphere reads as "red wax" / "gold foil" /
           // "clear ice" rather than as "slime with a coating-coloured
           // rim". Same tint uniform for all three (they differ in
           // material response: wax is soft candle sheen, foil is
           // metallic + iridescent, ice is fully matte + crackable) and
           // the flags are mutually exclusive so whichever is 1 wins.
           if (uCoatingIsFoil > 0.5 || uCoatingIsIce > 0.5 || uCoatingIsWax > 0.5) {
             vec3 coatingRGB;
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
               coatingRGB =
                 texture2D(uCoatingGradient, vec2(ct, 0.5)).rgb;
             } else {
               coatingRGB = uCoatingTint;
             }
             // Wax thickness ("콧") — 1콧 = translucent thin coat where
             // the inner slime shows through. Other coatings ignore the
             // uniform (mixAlpha = 1) so their tint stays fully opaque.
             float mixAlpha;
             if (uCoatingIsWax > 0.5) {
               mixAlpha = clamp(uWaxThicknessAlpha, 0.0, 1.0);
             } else if (uCoatingIsIce > 0.5) {
               // 글레이즈 — crystal-glass shell. Full-strength diffuse
               // tint so the shell reads with the same colour intensity
               // as a slime-crystal-material would with the user's pick;
               // transmission (kept on via _applyLook) then carries the
               // tint through the volume so light passes coloured too.
               mixAlpha = 1.0;
             } else {
               mixAlpha = 1.0;
             }
             diffuseColor.rgb = mix(diffuseColor.rgb, coatingRGB, mixAlpha);
           }

           // 텍스트 데칼 (above-coating pass) — mirror of the pre-coat
           // branch, runs AFTER the coating overlay so foil / wax /
           // ice / tube cannot cover the text. Unrolled the same way
           // for the same driver-portability reason. Forced ON for the
           // wax SHELL mesh (uShellMode > 0) so text always paints on
           // top of the wax exterior regardless of the user's toggle;
           // otherwise the shell would hide the text and users would
           // only glimpse it through cracks in the wax.
           // Same wax-shell suppression as pre-coating branch: when the
           // body is beneath a wax shell, don't paint text here either.
           // Shell (uShellMode > 0.001) ignores the suppression.
           if ((uTextAboveCoating > 0.5 && uBodyHasWaxShell < 0.5) || uShellMode > 0.001) {
             if (uTextUse > 0.5) {
               vec3 rnTA = vRest / uGradientRadius;
               vec3 tN = uTextAxis;
               vec3 tU = abs(tN.y) > 0.9 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);
               vec3 tT = normalize(cross(tU, tN));
               vec3 tB = normalize(cross(tN, tT));
               float u = dot(rnTA, tT) * 0.5 + 0.5;
               float v = dot(rnTA, tB) * 0.5 + 0.5;
               float d = dot(rnTA, tN);
               float r = length(vec2(u, v) - 0.5);
               float a = (1.0 - smoothstep(uTextRadius - 0.05, uTextRadius, r))
                       * smoothstep(-0.05, 0.30, d);
               if (a > 0.001) {
                 float _txA = texture2D(uTextMap, vec2(u, v)).a;
                 diffuseColor.rgb = mix(diffuseColor.rgb, uTextColor, _txA * a);
               }
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

           // Cracks reveal the slime's own base colour (snapshotted
           // before the coating overrode diffuseColor). No "wet cream"
           // whitewash — the user-picked slime colour must show through
           // faithfully regardless of material. Previously ice / wax on
           // non-matte materials blended 35% white into the reveal which
           // combined with the diffuse boost clipped saturated colours to
           // solid white (e.g. pink crystal under wax read as white).
           vec3 crackTarget = slimeBaseColor;
           diffuseColor.rgb =
             mix(diffuseColor.rgb, crackTarget, crackReveal);

           // Shell-bead mode: discard fragments inside crack lines so
           // the underlying slime mesh shows through the physical gap.
           //   uShellMode = 0 → slime body, no discard (colour-blend
           //     crack — legacy behaviour).
           //   uShellMode in (0, 1] → hollow-bead SHELL SURFACE. Per-
           //     vertex aShellSide (0 outer, 1 inner) picks between
           //     uShellMode (outer threshold) and 0.85 (inner). Outer
           //     cracks open early; inner only at wide cracks. Both
           //     surfaces discard normally.
           if (uShellMode > 0.001) {
             float threshold = uShellMode;
             if (crackReveal > threshold) discard;
             // Rim darkening: fragments just below the discard
             // threshold read as darker — fakes the shadow cast by
             // the wall cross-section receding into the crack.
             // A pure 2D shader trick (no real 3D geometry), so it
             // only reads convincingly from head-on angles, but it
             // gives cracks visible depth without a mesh rewrite.
             float rimBand = 0.22;
             float rimEdge = threshold - rimBand;
             if (crackReveal > rimEdge) {
               float rimT = (crackReveal - rimEdge) / rimBand;
               rimT = rimT * rimT;
               diffuseColor.rgb *= 1.0 - rimT * 0.65;
             }
           }

           if (uInkAmount > 0.005) {
             float t = inkTurb(vRest * 1.6);
             float threshold = 0.05 + 0.65 * uInkAmount;
             float band = 1.0 - smoothstep(0.0, threshold, abs(t));
             vec3 inkRGB;
             if (uInkGradientUse > 0.5) {
               // Multi-colour ink: sample the palette LUT with a
               // SECOND turbulence noise so every colour appears
               // somewhere along the ribbon, not just the first.
               // 0.5+0.5* remaps signed turb to [0,1] LUT range.
               float g = inkTurb(vRest * 2.7 + vec3(11.3, 47.1, 5.9));
               float lutU = clamp(g * 0.5 + 0.5, 0.02, 0.98);
               inkRGB = texture2D(uInkGradient, vec2(lutU, 0.5)).rgb;
             } else {
               inkRGB = uInkColor;
             }
             diffuseColor.rgb =
               mix(diffuseColor.rgb, inkRGB, clamp(band, 0.0, 1.0));
           }

           `
        )
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
           // 아이스 / 폼 재질 — perturb the surface normal with a rest-
           // space noise gradient so the surface reads as fine wrinkled
           // / crinkled "자글자글" texture instead of a perfectly smooth
           // shape. Applied to BOTH the transparent glass 아이스 body
           // (where it visibly distorts refraction) and the matte 폼
           // body (where it adds micro-relief that reads through the
           // existing foam bubble pattern without changing its matte
           // finish or spot mottling). Sampled in vRest so the pattern
           // stays anchored to the body across deformation. Reuses the
           // foam noise helpers already defined above.
           if (uMaterialIsIce > 0.5 || uMaterialIsMatte > 0.5) {
             vec3 _icePos = vRest * 42.0;
             float _iceEps = 0.55;
             float _iceN = foamNoise(_icePos);
             float _iceNx = foamNoise(_icePos + vec3(_iceEps, 0.0, 0.0));
             float _iceNy = foamNoise(_icePos + vec3(0.0, _iceEps, 0.0));
             float _iceNz = foamNoise(_icePos + vec3(0.0, 0.0, _iceEps));
             vec3 _iceGrad = vec3(
               _iceNx - _iceN,
               _iceNy - _iceN,
               _iceNz - _iceN
             );
             normal = normalize(normal + _iceGrad * 1.8);
           }`
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
           // Base material's own roughness (matte foam / metal / glossy /
           // crystal) as picked by the user — captured BEFORE the coating
           // shell override so the crack pass can revert to it.
           float _baseRoughness = roughnessFactor;
           // Matte foam roughness modulation on the base surface. Bright
           // bubble spots drop roughness so a tiny glint reads as an
           // aerated bubble top, shaded pockets bump roughness so the
           // cavity looks dry / dusty. Applied to _baseRoughness so the
           // foam pattern reads correctly whether visible directly or
           // revealed through a coating crack.
           if (uMaterialIsMatte > 0.5) {
             float bright = smoothstep(0.55, 0.95, vFoam);
             float shade  = smoothstep(0.45, 0.05, vFoam);
             _baseRoughness =
               clamp(_baseRoughness + shade * 0.15 - bright * 0.35, 0.05, 1.0);
           }
           // Coating enforces its OWN shell material response — wax
           // always reads as matte, foil always reads as polished metal,
           // regardless of what the user picked for the underlying slime.
           // The coating's target is applied to the SHELL area only; the
           // crack area reverts to _baseRoughness so torn shell exposes
           // the material's own finish. Wax alpha (1~4콧) scales the
           // shell override so a thin 1콧 coating still lets the base
           // material's finish read through where the shell is intact.
           float _shellR = _baseRoughness;
           float _shellCoverage = 0.0;
           if (uCoatingIsWax > 0.5) {
             // Wax reads as matte but not fully rough — 0.9 dropped the
             // env reflection so far that a pure-white shell looked light
             // grey against a white-mode background. 0.4 keeps the shell
             // clearly less shiny than glossy (0.18) / foil (0.2) while
             // reflecting enough environment light to read as bright
             // white wax.
             _shellR = 0.4;
             _shellCoverage = clamp(uWaxThicknessAlpha, 0.0, 1.0);
           } else if (uCoatingIsTube > 0.5) {
             // 젤 (tube) = glossy paper: check BEFORE foil since tube
             // also flips uCoatingIsFoil (they share the crack shader).
             // Slightly rougher than metal foil for a paper feel.
             _shellR = 0.15;
             _shellCoverage = 1.0;
           } else if (uCoatingIsFoil > 0.5) {
             _shellR = 0.2;
             _shellCoverage = 1.0;
           } else if (uCoatingIsIce > 0.5) {
             // 글레이즈 (ice) = crystal glaze: very low roughness for the
             // wet mirror-glass sheen.
             _shellR = 0.05;
             _shellCoverage = 1.0;
           }
           float _coatedR = mix(_baseRoughness, _shellR, _shellCoverage);
           // Crack revealed roughness is clamped to a satin minimum so a
           // crystal-base (0.05) or glossy-base (0.18) slime doesn't turn
           // the crack area into a mirror that reflects the bright env
           // map and washes the slime colour out to white. Matte / metal
           // are already >= 0.28 so this clamp is a no-op for them.
           float _crackR = max(_baseRoughness, 0.3);
           roughnessFactor = mix(_coatedR, _crackR, crackReveal);`
        )
        .replace(
          '#include <metalnessmap_fragment>',
          `#include <metalnessmap_fragment>
           // Coating's shell metalness — foil forces polished metal,
           // wax forces zero metal (matte wax has no metal reflection).
           // Crack area reverts to the material's own metalness so a
           // torn foil on metal-putty slime still shows metal through
           // the tear, while a torn foil on foam slime shows foam.
           float _baseMetalness = metalnessFactor;
           float _shellM = _baseMetalness;
           float _shellCoverageM = 0.0;
           if (uCoatingIsWax > 0.5) {
             _shellM = 0.0;
             _shellCoverageM = clamp(uWaxThicknessAlpha, 0.0, 1.0);
           } else if (uCoatingIsTube > 0.5) {
             // 젤 paper = no metal. Check before foil since they share
             // uCoatingIsFoil for the crack shader.
             _shellM = 0.0;
             _shellCoverageM = 1.0;
           } else if (uCoatingIsFoil > 0.5) {
             _shellM = 0.9;
             _shellCoverageM = 1.0;
           } else if (uCoatingIsIce > 0.5) {
             // 글레이즈 crystal = no metal.
             _shellM = 0.0;
             _shellCoverageM = 1.0;
           }
           float _coatedM = mix(_baseMetalness, _shellM, _shellCoverageM);
           metalnessFactor = mix(_coatedM, _baseMetalness, crackReveal);`
        )
        .replace(
          '#include <lights_physical_fragment>',
          `#include <lights_physical_fragment>
           // Foil coating carries a mirror clearcoat (1.0) globally so
           // even the crack area gets a wet-lacquer top layer that
           // reflects env light and washes the exposed slime colour
           // out. Reduce clearcoat in crack areas so torn foil reveals
           // the raw slime beneath instead of a lacquered version of it.
           #ifdef USE_CLEARCOAT
             material.clearcoat *= mix(1.0, 0.15, clamp(crackReveal, 0.0, 1.0));
           #endif`
        )
        .replace(
          // Mild diffuse lift in crack strips so the exposed slime pops
          // against the intact coating. Kept moderate (1.25/1.15) so
          // saturated slime colours don't clip past 1.0 into pure white
          // — the previous 1.95/1.7 boost was overdriving pink / red
          // slimes under wax to look solid white through the cracks.
          'vec3 totalDiffuse = reflectedLight.directDiffuse',
          `if (crackReveal > 0.01) {
             reflectedLight.directDiffuse *= mix(1.0, 1.25, crackReveal);
             reflectedLight.indirectDiffuse *= mix(1.0, 1.15, crackReveal);
           }
           vec3 totalDiffuse = reflectedLight.directDiffuse`
        )
        .replace(
          '#include <opaque_fragment>',
          `// WAX SHELL text final override — the standard above-coating
           // text pass (in the map_fragment replacement) baked text into
           // diffuseColor, but on the wax shell mesh (uShellMode > 0)
           // something in the render pipeline swallowed those pixels on
           // some Android GPUs, so users saw the wax exterior with no
           // text (text only showed through cracks on the inner body).
           // Re-apply the text draw here on outgoingLight so it lands
           // AFTER all lighting / roughness / coating calculations and
           // cannot be clobbered. Shell-only — the body has no such
           // driver quirk and drawing again here would double the mix.
           if (uShellMode > 0.001 && uTextUse > 0.5) {
             vec3 _rnTF = vRest / uGradientRadius;
             vec3 _tN = uTextAxis;
             vec3 _tU = abs(_tN.y) > 0.9 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);
             vec3 _tT = normalize(cross(_tU, _tN));
             vec3 _tB = normalize(cross(_tN, _tT));
             float _u = dot(_rnTF, _tT) * 0.5 + 0.5;
             float _v = dot(_rnTF, _tB) * 0.5 + 0.5;
             float _d = dot(_rnTF, _tN);
             float _r = length(vec2(_u, _v) - 0.5);
             float _a = (1.0 - smoothstep(uTextRadius - 0.05, uTextRadius, _r))
                      * smoothstep(-0.05, 0.30, _d);
             if (_a > 0.001) {
               float _sA = texture2D(uTextMap, vec2(_u, _v)).a;
               outgoingLight = mix(outgoingLight, uTextColor, _sA * _a);
             }
           }
           #include <opaque_fragment>`
        )
  }
  material.needsUpdate = true
}
