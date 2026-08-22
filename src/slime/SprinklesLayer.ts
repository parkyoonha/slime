import * as THREE from 'three'
import {
  SPRINKLE_MATERIAL_PARAMS,
  SPRINKLES_LIMITS,
  resolveSprinkleColorHex,
  type ColorAdjustments,
  type SpangleKindId,
  type SprinkleColorId,
  type SprinkleMaterialId,
  type SprinkleShapeId,
  type SprinkleTypeId
} from './presets'

/** Flat config that a single SprinklesLayer instance renders. Instantiate
 *  one SprinklesLayer per active sprinkle type (paper, powder) in SlimeApp
 *  and pass the type-specific slice of the composite SprinklesConfig — this
 *  keeps the layer implementation single-type and lets multiple types
 *  render simultaneously by simply owning multiple layer instances. Ink
 *  isn't rendered through this class (it's a slime-shader effect), so
 *  `type` here will only ever be 'paper' or 'powder'. */
export interface SprinklesLayerConfig {
  type: SprinkleTypeId
  colors: SprinkleColorId[]
  count: number
  size: number
  shape: SprinkleShapeId
  material: SprinkleMaterialId
  fill: boolean
  /** 스팽글 종류. Only meaningful when type === 'paper': 'plastic'
   *  overrides the material chip with a glossy-plastic look and thickens
   *  the extrusion depth so the pieces read as chunky beads instead of
   *  paper-thin confetti. Ignored for powder/ink. */
  kind?: SpangleKindId
}

const MAX_SPRINKLES = 150000

/**
 * Flat, paper-thin decorations scattered across the slime surface — glitter,
 * paper stars, sugar bits. Each sprinkle sits tangent to the surface with a
 * random rotation around the surface normal, so from above they look like
 * stickers, not floating volumes.
 *
 * Mirrors BeadsLayer's structure: two modes (vertex-anchored + Fibonacci fill),
 * radial magnitude interpolation across the 3 nearest vertices for smooth
 * angular coverage, plus a kneading sink so they don't just float when the
 * slime is compressed underneath them.
 */
export class SprinklesLayer {
  readonly group: THREE.Group
  private instanced: THREE.InstancedMesh | null = null

  private vertexIndices: number[] = []
  private spinAngles: Float32Array = new Float32Array(0)
  /** Per-sprinkle outward lift caused by a bead sitting underneath. Zero
   *  where no bead is nearby, ramps up to ~beadSize where a bead directly
   *  covers this sprinkle's direction. */
  private beadLift: Float32Array = new Float32Array(0)
  /** Rest-frame tilt (bead-normal minus slime-normal) at each sprinkle's
   *  contact point on a bead. Added to the current slime normal at runtime
   *  so the flat sprinkle rides tangent to the BEAD's spherical surface
   *  instead of parallel to the underlying slime — the difference between
   *  a sprinkle glued flat on a bead vs. hovering flat above it. (n × 3) */
  private beadNormalOffset: Float32Array = new Float32Array(0)

  private fillMode = false
  /** For every fill sprinkle, the 3 vertex indices of the mesh triangle its
   *  Fibonacci direction ray-casts into (n × 3). */
  private fillVertexIdx: Uint32Array = new Uint32Array(0)
  /** True barycentric weights (u, v, w) of the sprinkle's rest position
   *  inside its triangle — chosen so `Σ w_i × v_i = ray-triangle hit point`.
   *  These weights are constant; applying them to the current triangle's
   *  vertices at runtime gives a point mathematically ON the deformed mesh
   *  surface, never floating. (n × 3) */
  private fillVertexWeight: Float32Array = new Float32Array(0)
  private fillSpin: Float32Array = new Float32Array(0)

  private currentMaterialId: SprinkleMaterialId = 'glitter'
  private currentKind: SpangleKindId | undefined = undefined
  /** Tracks which geometry is currently on the InstancedMesh. Uses the
   *  sentinel string 'powder' when a faceted powder grain is bound, else a
   *  standard SprinkleShapeId. Lets swapGeometry detect the powder-⇄-paper
   *  toggle without leaking into the SprinkleShapeId type. */
  private currentShapeKey: SprinkleShapeId | 'powder' = 'star'
  private config: SprinklesLayerConfig = {
    type: 'paper',
    colors: [],
    size: 0.035,
    count: 0,
    shape: 'star',
    material: 'glitter',
    fill: false
  }
  private currentColorAdjustments: ColorAdjustments | undefined = undefined

  private readonly _matrix = new THREE.Matrix4()
  private readonly _pos = new THREE.Vector3()
  private readonly _scale = new THREE.Vector3()
  private readonly _quat = new THREE.Quaternion()
  private readonly _spinQuat = new THREE.Quaternion()
  private readonly _forward = new THREE.Vector3(0, 0, 1)
  private readonly _outward = new THREE.Vector3()
  private readonly _color = new THREE.Color()

  constructor() {
    this.group = new THREE.Group()
  }

  get currentConfig(): Readonly<SprinklesLayerConfig> {
    return this.config
  }

  private ensureInstanced() {
    if (this.instanced) return
    const geo = buildSprinkleGeometry(this.config.shape)
    const mat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide
    })
    this.applyMaterialParams(mat, this.config.material, this.config.kind)
    this.currentMaterialId = this.config.material
    this.currentKind = this.config.kind
    this.currentShapeKey = this.config.shape
    const im = new THREE.InstancedMesh(geo, mat, MAX_SPRINKLES)
    im.frustumCulled = false
    im.count = 0
    im.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_SPRINKLES * 3),
      3
    )
    this.group.add(im)
    this.instanced = im
  }

  private swapGeometry(key: SprinkleShapeId | 'powder') {
    if (!this.instanced) return
    const old = this.instanced.geometry
    this.instanced.geometry =
      key === 'powder' ? buildPowderGrainGeometry() : buildSprinkleGeometry(key)
    old.dispose()
    this.currentShapeKey = key
  }

  private applyMaterialParams(
    mat: THREE.MeshPhysicalMaterial,
    id: SprinkleMaterialId,
    kind?: SpangleKindId
  ) {
    // Start from the material preset so 무광/반짝이/크리스탈 keep driving
    // the underlying look (roughness / metalness / sheen / iridescence /
    // transmission). This is the base for BOTH kinds — paper renders it
    // as-is, plastic layers a glossy clearcoat on top below.
    const p = SPRINKLE_MATERIAL_PARAMS[id]
    mat.roughness = p.roughness
    mat.metalness = p.metalness
    mat.clearcoat = p.clearcoat
    mat.clearcoatRoughness = p.clearcoatRoughness
    mat.sheen = p.sheen
    mat.sheenRoughness = p.sheenRoughness
    mat.iridescence = p.iridescence
    mat.iridescenceIOR = p.iridescenceIOR
    mat.envMapIntensity = p.envMapIntensity
    // Optional physical transmission — crystal preset sets these to
    // make the sprinkle read as clear glass; other presets omit
    // them (defaults zero out cleanly).
    mat.transmission = p.transmission ?? 0
    mat.thickness = p.thickness ?? 0
    if (p.ior !== undefined) mat.ior = p.ior
    // 플라스틱 종류: force a hard glossy clearcoat over whatever material
    // preset the user picked so the surface reads as moulded plastic
    // regardless of base material. Base roughness / metalness / sheen /
    // iridescence / transmission from the material preset are preserved
    // so 반짝이 plastic still sparkles, 크리스탈 plastic still transmits
    // light, 무광 plastic reads as diffuse under the shiny coat.
    if (kind === 'plastic') {
      mat.clearcoat = 1.0
      mat.clearcoatRoughness = 0.03
      // Bump envMap so the plastic coat picks up the room reflection
      // strongly (that's what makes plastic read as plastic).
      mat.envMapIntensity = Math.max(mat.envMapIntensity, 1.4)
    }
    mat.needsUpdate = true
  }

  /** Cache the shared colour adjustments map so the next
   *  applyInstanceColors pass picks up per-sprinkle-colour hue /
   *  lightness deltas set via the panel sliders. */
  setColorAdjustments(adjustments: ColorAdjustments) {
    this.currentColorAdjustments = adjustments
    // Re-emit the instance colours immediately so the change lands
    // this frame without waiting for the next setConfig call.
    const im = this.instanced
    if (!im) return
    const count = im.count
    if (count <= 0) return
    const palette = colorsToHex(
      this.config.colors.length > 0 ? this.config.colors : ['gold'],
      this.currentColorAdjustments
    )
    for (let i = 0; i < count; i++) {
      this._color.setHex(palette[i % palette.length])
      im.setColorAt(i, this._color)
    }
    if (im.instanceColor) im.instanceColor.needsUpdate = true
  }

  setConfig(
    config: SprinklesLayerConfig,
    unitDirs: Float32Array,
    restPositions: Float32Array,
    indexBuffer: Uint16Array | Uint32Array,
    beadInfo: { positions: Float32Array; size: number } | null = null
  ) {
    this.ensureInstanced()
    this.config = { ...config, colors: [...config.colors] }

    const im = this.instanced!

    // Ink alone is drawn inside the slime shader (marble swirls). Zero the
    // instance count so nothing shows on top of the slime for that type.
    if (config.type === 'ink') {
      im.count = 0
      this.vertexIndices = []
      this.fillMode = false
      return
    }

    // Powder: switch to a tiny FACETED grain instead of the flat dot puck
    // paper sprinkles use. A flat disc that stays tangent to the slime
    // reflects light in one direction across the whole population — reads
    // as paper. An octahedral grain has facets at every angle, and with
    // per-grain random spin different grains catch highlights independently,
    // which is the whole "sparkle" of real glitter. Panel doesn't expose
    // size / shape for powder, so overriding both here is invisible to the
    // user.
    const isPowder = config.type === 'powder'
    const effectiveShape: SprinkleShapeId = isPowder ? 'dot' : config.shape
    // Powder grain size — bumped from 0.003 so each grain covers ~3× more
    // area, which combined with the higher MAX_SPRINKLES ceiling gives the
    // "꽉 채우기" mode a genuine coating look instead of a sparse dusting.
    const effectiveSize = isPowder ? 0.005 : config.size
    const shapeKey: SprinkleShapeId | 'powder' = isPowder
      ? 'powder'
      : effectiveShape

    if (
      config.material !== this.currentMaterialId ||
      config.kind !== this.currentKind
    ) {
      this.applyMaterialParams(
        im.material as THREE.MeshPhysicalMaterial,
        config.material,
        config.kind
      )
      this.currentMaterialId = config.material
      this.currentKind = config.kind
    }
    if (shapeKey !== this.currentShapeKey) {
      this.swapGeometry(shapeKey)
    }

    let effectiveCount: number
    // Powder always uses Fibonacci-sphere scatter (fill mode's layout), NOT
    // vertex anchoring — anchoring to the 2562-vertex icosphere pulled dots
    // into visible rings/clusters that mirrored the mesh's symmetry, which
    // looked like arranged confetti rather than sprinkled powder. Fibonacci
    // + ray-triangle barycentric gives a truly random-looking scatter, and
    // the count is driven straight off the slider (with a big multiplier so
    // the max slider makes a proper heap) instead of the fill formula that
    // assumes non-overlapping pieces.
    if (isPowder) {
      // Two powder distributions selectable from the panel:
      //   config.fill = false → marble-ribbon density (grains concentrate
      //     along the same swirl mask ink uses; count drives ribbon
      //     width). This is the original decorative look.
      //   config.fill = true  → uniform Fibonacci scatter across the WHOLE
      //     surface at MAX_SPRINKLES density — reads as a real powder
      //     coating with no ribbon shape. Users who want "꽉 채우기" pick
      //     this from the count sub-cat toggle.
      this.fillMode = true
      if (config.fill) {
        effectiveCount = MAX_SPRINKLES
        this.buildFillLayout(
          effectiveCount,
          unitDirs,
          restPositions,
          indexBuffer
        )
      } else {
        // Marble ribbon path — grain count scales superlinearly with the
        // slider so the wider high-amount ribbon actually fills its
        // territory instead of leaving Fibonacci gaps between grains.
        const amount = Math.max(
          0,
          Math.min(1, config.count / SPRINKLES_LIMITS.powderCountMax)
        )
        const linear = config.count * 60
        const quadratic = config.count * config.count * 0.25
        effectiveCount = Math.min(
          MAX_SPRINKLES,
          Math.max(64, Math.round(linear + quadratic))
        )
        this.buildFillLayout(
          effectiveCount,
          unitDirs,
          restPositions,
          indexBuffer,
          makePowderDensity(amount)
        )
      }
      this.vertexIndices = []
      this.spinAngles = new Float32Array(0)
    } else if (config.fill) {
      // Paper spangles use the original 1.6× factor — a clean non-
      // overlapping scatter at every size. Plastic spangles ALWAYS
      // overshoot to 5·π/size² so pieces overlap by roughly half their
      // width and no gaps show between the chunky moulded silhouettes
      // (which don't tile like flat paper).
      const densityK = config.kind === 'plastic' ? 5 : 1.6
      const target = Math.ceil(
        (Math.PI * densityK) / (effectiveSize * effectiveSize)
      )
      effectiveCount = Math.min(MAX_SPRINKLES, Math.max(64, target))
      this.fillMode = true
      this.buildFillLayout(
        effectiveCount,
        unitDirs,
        restPositions,
        indexBuffer
      )
      this.vertexIndices = []
      this.spinAngles = new Float32Array(0)
    } else {
      const totalVerts = unitDirs.length / 3
      effectiveCount = Math.min(config.count, MAX_SPRINKLES, totalVerts)
      this.fillMode = false
      this.vertexIndices = pickIndices(unitDirs, effectiveCount)
      this.buildVertexLayout(this.vertexIndices)
      this.fillVertexIdx = new Uint32Array(0)
      this.fillVertexWeight = new Float32Array(0)
      this.fillSpin = new Float32Array(0)
    }

    im.count = effectiveCount

    const palette = colorsToHex(
      config.colors.length > 0 ? config.colors : ['gold'],
      this.currentColorAdjustments
    )
    for (let i = 0; i < effectiveCount; i++) {
      this._color.setHex(palette[i % palette.length])
      im.setColorAt(i, this._color)
    }
    if (im.instanceColor) im.instanceColor.needsUpdate = true

    this.computeBeadLift(
      effectiveCount,
      unitDirs,
      restPositions,
      beadInfo
    )
  }

  /** For each sprinkle, ray-cast its outward direction against every bead
   *  sphere using the bead's real rest CENTER (which accounts for per-bead
   *  depth offsets). The intersection gives the exact height at which the
   *  sprinkle should sit on the bead's curving surface — full ≈ `beadSize`
   *  at the top, smoothly tapering to zero at the bead's equator, and no
   *  lift once the ray misses the bead. That's what makes sprinkles hug the
   *  actual visible bead shape instead of a phantom bead-at-surface. */
  private computeBeadLift(
    n: number,
    unitDirs: Float32Array,
    restPositions: Float32Array,
    beadInfo: { positions: Float32Array; size: number } | null
  ) {
    this.beadLift = new Float32Array(n)
    this.beadNormalOffset = new Float32Array(n * 3)
    if (!beadInfo || beadInfo.positions.length === 0) return

    const beadPositions = beadInfo.positions
    const beadCount = beadPositions.length / 3
    // Effective radius = actual bead + a thin extra layer that stands in for
    // the slime coating covering the bead. Sprinkles land on this outer
    // envelope, giving the "stuck to slime-covered bead" look.
    const beadRadius = beadInfo.size * 1.05
    const beadRadiusSq = beadRadius * beadRadius

    for (let i = 0; i < n; i++) {
      let dx: number
      let dy: number
      let dz: number
      let restLen: number
      if (this.fillMode) {
        const i3 = i * 3
        const v0 = this.fillVertexIdx[i3] * 3
        const v1 = this.fillVertexIdx[i3 + 1] * 3
        const v2 = this.fillVertexIdx[i3 + 2] * 3
        const w0 = this.fillVertexWeight[i3]
        const w1 = this.fillVertexWeight[i3 + 1]
        const w2 = this.fillVertexWeight[i3 + 2]
        const px =
          w0 * restPositions[v0] +
          w1 * restPositions[v1] +
          w2 * restPositions[v2]
        const py =
          w0 * restPositions[v0 + 1] +
          w1 * restPositions[v1 + 1] +
          w2 * restPositions[v2 + 1]
        const pz =
          w0 * restPositions[v0 + 2] +
          w1 * restPositions[v1 + 2] +
          w2 * restPositions[v2 + 2]
        restLen = Math.hypot(px, py, pz) || 1
        dx = px / restLen
        dy = py / restLen
        dz = pz / restLen
      } else {
        const vi = this.vertexIndices[i]
        dx = unitDirs[vi * 3]
        dy = unitDirs[vi * 3 + 1]
        dz = unitDirs[vi * 3 + 2]
        restLen = Math.hypot(
          restPositions[vi * 3],
          restPositions[vi * 3 + 1],
          restPositions[vi * 3 + 2]
        )
      }

      // Try every bead — pick the one whose ray-sphere intersection puts the
      // sprinkle highest above the slime. Also remember WHICH bead won so we
      // can capture the bead's local normal for orientation.
      let bestLift = 0
      let bestIdx = -1
      for (let k = 0; k < beadCount; k++) {
        const cx = beadPositions[k * 3]
        const cy = beadPositions[k * 3 + 1]
        const cz = beadPositions[k * 3 + 2]
        // Möller ray-sphere from origin along (dx,dy,dz):
        //   |t·dir − C|² = R²
        //   t² − 2t(dir·C) + |C|² − R² = 0
        const bDot = dx * cx + dy * cy + dz * cz
        const cSq = cx * cx + cy * cy + cz * cz
        const disc = bDot * bDot - cSq + beadRadiusSq
        if (disc <= 0) continue
        const t = bDot + Math.sqrt(disc)
        const lift = t - restLen
        if (lift > bestLift) {
          bestLift = lift
          bestIdx = k
        }
      }
      this.beadLift[i] = bestLift

      // Store the tilt between the bead's surface normal (from bead center
      // out to the sprinkle contact point) and the slime's surface normal
      // (radial at rest). Applied to the current slime normal at runtime, it
      // rotates the sprinkle so its flat face rests tangent to the bead.
      if (bestIdx >= 0) {
        const t = restLen + bestLift
        const hitX = dx * t
        const hitY = dy * t
        const hitZ = dz * t
        const bx = beadPositions[bestIdx * 3]
        const by = beadPositions[bestIdx * 3 + 1]
        const bz = beadPositions[bestIdx * 3 + 2]
        let nx = hitX - bx
        let ny = hitY - by
        let nz = hitZ - bz
        const nlen = Math.hypot(nx, ny, nz) || 1
        nx /= nlen
        ny /= nlen
        nz /= nlen
        const i3 = i * 3
        this.beadNormalOffset[i3] = nx - dx
        this.beadNormalOffset[i3 + 1] = ny - dy
        this.beadNormalOffset[i3 + 2] = nz - dz
      }
    }
  }

  reseat(
    unitDirs: Float32Array,
    restPositions: Float32Array,
    indexBuffer: Uint16Array | Uint32Array,
    beadInfo: { positions: Float32Array; size: number } | null = null
  ) {
    if (!this.instanced) return
    if (!this.config.fill && this.config.count === 0) return
    this.setConfig(
      this.config,
      unitDirs,
      restPositions,
      indexBuffer,
      beadInfo
    )
  }

  private buildVertexLayout(vertexIndices: number[]) {
    const n = vertexIndices.length
    this.spinAngles = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const vi = vertexIndices[i]
      this.spinAngles[i] = hash01(vi * 11 + 7) * Math.PI * 2
    }
  }

  private buildFillLayout(
    n: number,
    unitDirs: Float32Array,
    restPositions: Float32Array,
    indexBuffer: Uint16Array | Uint32Array,
    /** Optional density weighting. When defined, this function over-
     *  generates Fibonacci candidates and keeps the top-n by densityFn
     *  score — anything peaked (like a turbulence field) produces the
     *  organic patchiness the powder look needs. Undefined = uniform
     *  Fibonacci scatter (paper's original behaviour). */
    densityFn?: (x: number, y: number, z: number) => number
  ) {
    this.fillVertexIdx = new Uint32Array(n * 3)
    this.fillVertexWeight = new Float32Array(n * 3)
    this.fillSpin = new Float32Array(n)

    // Adjacency: for each vertex, the triangle indices that touch it. We use
    // this to jump straight from "nearest vertex to fibDir" to the small set
    // of candidate triangles that could contain fibDir, instead of scanning
    // all 5120 triangles of the icosphere.
    const vertexCount = unitDirs.length / 3
    const triCount = indexBuffer.length / 3
    const triangleCounts = new Uint32Array(vertexCount)
    for (let t = 0; t < indexBuffer.length; t++) triangleCounts[indexBuffer[t]]++
    const triangleOffsets = new Uint32Array(vertexCount + 1)
    for (let v = 0; v < vertexCount; v++) {
      triangleOffsets[v + 1] = triangleOffsets[v] + triangleCounts[v]
    }
    const triangleList = new Uint32Array(indexBuffer.length)
    const cursors = new Uint32Array(vertexCount)
    for (let t = 0; t < triCount; t++) {
      const a = indexBuffer[t * 3]
      const b = indexBuffer[t * 3 + 1]
      const c = indexBuffer[t * 3 + 2]
      triangleList[triangleOffsets[a] + cursors[a]++] = t
      triangleList[triangleOffsets[b] + cursors[b]++] = t
      triangleList[triangleOffsets[c] + cursors[c]++] = t
    }

    // Generate Fibonacci-sphere candidates. When densityFn is set, we make
    // 8× more than we need and later keep the ones with the highest scores —
    // that concentrates grains in the peaks of the density field (patches
    // / streaks) instead of covering the sphere evenly. The 8× headroom is
    // what gives powder its "packed heap" look: keeping only the top ⅛ of
    // candidates puts every grain deep inside a turbulence peak, so the
    // patches read as dense clumps rather than a light dusting.
    const overGen = densityFn ? 8 : 1
    const candidateCount = Math.min(250000, n * overGen)
    const phi = Math.PI * (Math.sqrt(5) - 1)
    const candX: number[] = new Array(candidateCount)
    const candY: number[] = new Array(candidateCount)
    const candZ: number[] = new Array(candidateCount)
    const candScore: number[] = densityFn ? new Array(candidateCount) : []
    // Small positional jitter (1.5× NN spacing) breaks the perfect
    // Fibonacci grid without letting grains overlap — bigger jitter
    // caused grains to land on the same spot (wasting coverage) while
    // leaving other spots empty, which read as clustered stripes with
    // dead gaps. Combined with the high candidate density from 8×
    // over-generation, this small jitter is enough to hide the lattice.
    const baseJitterAmp = densityFn
      ? 1.5 * Math.sqrt((4 * Math.PI) / candidateCount)
      : 0
    for (let i = 0; i < candidateCount; i++) {
      const tPar = candidateCount > 1 ? i / (candidateCount - 1) : 0
      const y0 = 1 - tPar * 2
      const r = Math.sqrt(Math.max(0, 1 - y0 * y0))
      const theta = phi * i
      let x = Math.cos(theta) * r
      let y = y0
      let z = Math.sin(theta) * r
      if (baseJitterAmp > 0) {
        x += (hash01(i * 71 + 3) - 0.5) * baseJitterAmp
        y += (hash01(i * 79 + 11) - 0.5) * baseJitterAmp
        z += (hash01(i * 83 + 17) - 0.5) * baseJitterAmp
        const invLen = 1 / Math.sqrt(x * x + y * y + z * z)
        x *= invLen
        y *= invLen
        z *= invLen
      }
      candX[i] = x
      candY[i] = y
      candZ[i] = z
      if (densityFn) {
        // Score = density raised to a fractional power then modestly
        // scattered by random. Fractional power (0.6) compresses high
        // values less than low, so mid/edge candidates stay competitive
        // with center ones; the tighter random multiplier (0.6..1.0)
        // preserves that ordering enough to keep grain-per-area density
        // uniform inside the ribbon while still softening the boundary.
        // Wider jitter here caused lucky candidates to cluster and
        // unlucky ones to drop out — visible as gap-and-clump stripes.
        const raw = densityFn(x, y, z)
        const scoreBase = Math.pow(raw, 0.6)
        const jitter = 0.6 + 0.4 * hash01(i * 97 + 41)
        candScore[i] = scoreBase * jitter
      }
    }

    // Rank by density, keep top n. Uses an index array so we can reorder
    // candidates without shuffling all three coordinate buffers.
    let order: number[]
    if (densityFn) {
      order = Array.from({ length: candidateCount }, (_, k) => k)
      order.sort((a, b) => candScore[b] - candScore[a])
      order.length = n
    } else {
      order = Array.from({ length: n }, (_, k) => k)
    }

    for (let i = 0; i < n; i++) {
      const src = order[i]
      const x = candX[src]
      const y = candY[src]
      const z = candZ[src]

      const i3 = i * 3
      this.fillSpin[i] = hash01(i * 13 + 5) * Math.PI * 2

      // Find nearest vertex to seed the triangle search — the containing
      // triangle almost always shares this vertex.
      let bestDot = -Infinity
      let nearestV = 0
      for (let j = 0; j < vertexCount; j++) {
        const dot =
          unitDirs[j * 3] * x +
          unitDirs[j * 3 + 1] * y +
          unitDirs[j * 3 + 2] * z
        if (dot > bestDot) {
          bestDot = dot
          nearestV = j
        }
      }

      // Try triangles incident to nearestV. If none contain the fibDir ray,
      // expand to triangles incident to the second-nearest vertex, and as a
      // last resort scan every triangle.
      const found = tryContainingTriangle(
        nearestV,
        x,
        y,
        z,
        restPositions,
        indexBuffer,
        triangleList,
        triangleOffsets
      )

      let triIdx = found.triIdx
      let ba = found.a
      let bb = found.b
      let bc = found.c
      let bu = found.u
      let bv = found.v
      let bw = found.w
      if (triIdx < 0) {
        const global = scanAllTriangles(
          x,
          y,
          z,
          restPositions,
          indexBuffer,
          triCount
        )
        triIdx = global.triIdx
        ba = global.a
        bb = global.b
        bc = global.c
        bu = global.u
        bv = global.v
        bw = global.w
      }

      this.fillVertexIdx[i3] = ba
      this.fillVertexIdx[i3 + 1] = bb
      this.fillVertexIdx[i3 + 2] = bc
      this.fillVertexWeight[i3] = bu
      this.fillVertexWeight[i3 + 1] = bv
      this.fillVertexWeight[i3 + 2] = bw
    }
  }

  update(currentPositions: Float32Array, currentNormals: Float32Array) {
    const im = this.instanced
    if (!im || im.count === 0) return
    const isPowder = this.config.type === 'powder'
    // Powder overrides the panel's size — the panel doesn't expose it for
    // powder, and we hard-wire it in setConfig too. `size` here matches
    // effectiveSize used at config time so scale + position agree.
    const size = isPowder ? 0.005 : this.config.size
    const n = im.count

    const halfWidth = size
    const halfHeight = size
    // Paper sprinkles are near-flat foil (depth ≈ 0.02 × width) — as thin
    // as the extrude bevel allows. Plastic spangles are noticeably thicker
    // (2.5 × width) so they read as chunky moulded beads instead of
    // paper-thin confetti. Powder grains are 3D faceted octahedra, so
    // depth must equal width — otherwise the grain gets squashed into a
    // disc and the sparkle collapses back into one facet.
    const isPlastic = this.config.kind === 'plastic'
    const halfDepth = isPowder
      ? size
      : isPlastic
        ? size * 2.5
        : size * 0.02
    // Base lift = 0 so sprinkles ride flush with the mesh. `beadLift[i]` adds
    // a per-instance outward offset where a bead is underneath, so sprinkles
    // sit on top of beads (slime → beads → sprinkles) instead of poking into
    // them or floating past bare slime spots.

    if (this.fillMode) {
      for (let i = 0; i < n; i++) {
        const i3 = i * 3
        const v0 = this.fillVertexIdx[i3] * 3
        const v1 = this.fillVertexIdx[i3 + 1] * 3
        const v2 = this.fillVertexIdx[i3 + 2] * 3
        const w0 = this.fillVertexWeight[i3]
        const w1 = this.fillVertexWeight[i3 + 1]
        const w2 = this.fillVertexWeight[i3 + 2]

        // Position: exact barycentric point on the current triangle. Because
        // the weights (u, v, w) were computed from a ray-triangle intersection
        // at rest, the resulting point stays mathematically ON the deformed
        // mesh surface every frame — no chord-midpoint float, no gap.
        let px =
          w0 * currentPositions[v0] +
          w1 * currentPositions[v1] +
          w2 * currentPositions[v2]
        let py =
          w0 * currentPositions[v0 + 1] +
          w1 * currentPositions[v1 + 1] +
          w2 * currentPositions[v2 + 1]
        let pz =
          w0 * currentPositions[v0 + 2] +
          w1 * currentPositions[v1 + 2] +
          w2 * currentPositions[v2 + 2]

        // Orientation: interpolated surface normal from the same 3 vertices,
        // renormalised. This tilts the flat sprinkle to match local surface
        // slope so it doesn't poke through a bulge or hover over a dent.
        let nx =
          w0 * currentNormals[v0] +
          w1 * currentNormals[v1] +
          w2 * currentNormals[v2]
        let ny =
          w0 * currentNormals[v0 + 1] +
          w1 * currentNormals[v1 + 1] +
          w2 * currentNormals[v2 + 1]
        let nz =
          w0 * currentNormals[v0 + 2] +
          w1 * currentNormals[v1 + 2] +
          w2 * currentNormals[v2 + 2]
        // Bead-normal tilt: adds the (rest-frame) bead-normal-minus-slime-
        // normal to the current slime normal, so the effective orientation
        // is the bead's local up direction. For sprinkles not on a bead this
        // offset is zero. Applied before renormalisation so the resulting
        // vector is a proper unit vector.
        nx += this.beadNormalOffset[i3]
        ny += this.beadNormalOffset[i3 + 1]
        nz += this.beadNormalOffset[i3 + 2]
        const nlen = Math.hypot(nx, ny, nz) || 1
        nx /= nlen
        ny /= nlen
        nz /= nlen

        const bl = this.beadLift[i] || 0
        if (bl > 0) {
          px += nx * bl
          py += ny * bl
          pz += nz * bl
        }

        this._pos.set(px, py, pz)
        if (isPowder) {
          // Fully random rotation per grain via a stable hash-derived
          // quaternion. Each octahedron ends up facing a different direction,
          // so their facets pick up light on their own axes — that
          // per-grain variance is what creates the glitter sparkle. Uniform
          // outward orientation (what flat sprinkles use) would leave every
          // grain reflecting the same highlight and the population would
          // read as a matte pigment, not glitter.
          const q0 = hash01(i * 17 + 3) * 2 - 1
          const q1 = hash01(i * 23 + 11) * 2 - 1
          const q2 = hash01(i * 29 + 5) * 2 - 1
          const q3 = hash01(i * 41 + 19) * 2 - 1
          const invLen =
            1 / Math.sqrt(q0 * q0 + q1 * q1 + q2 * q2 + q3 * q3)
          this._quat.set(
            q0 * invLen,
            q1 * invLen,
            q2 * invLen,
            q3 * invLen
          )
        } else {
          this._outward.set(nx, ny, nz)
          this._quat.setFromUnitVectors(this._forward, this._outward)
          this._spinQuat.setFromAxisAngle(this._outward, this.fillSpin[i])
          this._quat.premultiply(this._spinQuat)
        }

        this._scale.set(halfWidth, halfHeight, halfDepth)
        this._matrix.compose(this._pos, this._quat, this._scale)
        im.setMatrixAt(i, this._matrix)
      }
      im.instanceMatrix.needsUpdate = true
      return
    }

    for (let i = 0; i < n; i++) {
      const vi = this.vertexIndices[i]
      const px0 = currentPositions[vi * 3]
      const py0 = currentPositions[vi * 3 + 1]
      const pz0 = currentPositions[vi * 3 + 2]

      // Normal from mesh — reflects the actual local surface slope after
      // deformation, not just the radial direction.
      let nx = currentNormals[vi * 3]
      let ny = currentNormals[vi * 3 + 1]
      let nz = currentNormals[vi * 3 + 2]
      const i3 = i * 3
      nx += this.beadNormalOffset[i3]
      ny += this.beadNormalOffset[i3 + 1]
      nz += this.beadNormalOffset[i3 + 2]
      const nlen = Math.hypot(nx, ny, nz) || 1
      nx /= nlen
      ny /= nlen
      nz /= nlen

      const bl = this.beadLift[i] || 0
      this._pos.set(px0 + nx * bl, py0 + ny * bl, pz0 + nz * bl)
      this._outward.set(nx, ny, nz)
      this._quat.setFromUnitVectors(this._forward, this._outward)
      this._spinQuat.setFromAxisAngle(this._outward, this.spinAngles[i])
      this._quat.premultiply(this._spinQuat)

      this._scale.set(halfWidth, halfHeight, halfDepth)
      this._matrix.compose(this._pos, this._quat, this._scale)
      im.setMatrixAt(i, this._matrix)
    }
    im.instanceMatrix.needsUpdate = true
  }

  dispose() {
    if (this.instanced) {
      this.group.remove(this.instanced)
      this.instanced.geometry.dispose()
      ;(this.instanced.material as THREE.Material).dispose()
      this.instanced = null
    }
    this.vertexIndices = []
    this.spinAngles = new Float32Array(0)
    this.beadLift = new Float32Array(0)
    this.beadNormalOffset = new Float32Array(0)
    this.fillVertexIdx = new Uint32Array(0)
    this.fillVertexWeight = new Float32Array(0)
    this.fillSpin = new Float32Array(0)
  }
}

/* ─── helpers ─────────────────────────────────────────── */

function colorsToHex(
  colors: SprinkleColorId[],
  adjustments?: ColorAdjustments
): number[] {
  const out: number[] = []
  for (const id of colors) {
    out.push(resolveSprinkleColorHex(id, adjustments))
  }
  return out.length > 0 ? out : [0xffcf5e]
}

function hash01(i: number): number {
  const x = ((i + 1) * 2654435761) >>> 0
  return x / 0xffffffff
}

/** Ray-triangle intersection + barycentric extraction. Ray goes from origin
 *  along direction (dx, dy, dz). Returns {u, v, w} barycentric weights of the
 *  hit point, or null if the ray misses the triangle. */
function intersectRay(
  dx: number,
  dy: number,
  dz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number
): { u: number; v: number; w: number } | null {
  const eps = 1e-8
  // Möller–Trumbore
  const e1x = bx - ax
  const e1y = by - ay
  const e1z = bz - az
  const e2x = cx - ax
  const e2y = cy - ay
  const e2z = cz - az
  const px = dy * e2z - dz * e2y
  const py = dz * e2x - dx * e2z
  const pz = dx * e2y - dy * e2x
  const det = e1x * px + e1y * py + e1z * pz
  if (det > -eps && det < eps) return null
  const invDet = 1 / det
  // Ray origin is (0,0,0), so T = -A = (-ax, -ay, -az)
  const tx = -ax
  const ty = -ay
  const tz = -az
  const v = (tx * px + ty * py + tz * pz) * invDet
  if (v < -eps || v > 1 + eps) return null
  const qx = ty * e1z - tz * e1y
  const qy = tz * e1x - tx * e1z
  const qz = tx * e1y - ty * e1x
  const w = (dx * qx + dy * qy + dz * qz) * invDet
  if (w < -eps || v + w > 1 + eps) return null
  const t = (e2x * qx + e2y * qy + e2z * qz) * invDet
  if (t <= 0) return null
  const u = 1 - v - w
  return { u, v, w }
}

/** Try the triangles incident to the seed vertex until we find one whose plane
 *  the fibDir ray hits inside. */
function tryContainingTriangle(
  seedVertex: number,
  dx: number,
  dy: number,
  dz: number,
  restPositions: Float32Array,
  indexBuffer: Uint16Array | Uint32Array,
  triangleList: Uint32Array,
  triangleOffsets: Uint32Array
): {
  triIdx: number
  a: number
  b: number
  c: number
  u: number
  v: number
  w: number
} {
  const start = triangleOffsets[seedVertex]
  const end = triangleOffsets[seedVertex + 1]
  for (let k = start; k < end; k++) {
    const t = triangleList[k]
    const a = indexBuffer[t * 3]
    const b = indexBuffer[t * 3 + 1]
    const c = indexBuffer[t * 3 + 2]
    const hit = intersectRay(
      dx,
      dy,
      dz,
      restPositions[a * 3],
      restPositions[a * 3 + 1],
      restPositions[a * 3 + 2],
      restPositions[b * 3],
      restPositions[b * 3 + 1],
      restPositions[b * 3 + 2],
      restPositions[c * 3],
      restPositions[c * 3 + 1],
      restPositions[c * 3 + 2]
    )
    if (hit) return { triIdx: t, a, b, c, u: hit.u, v: hit.v, w: hit.w }
  }
  return { triIdx: -1, a: 0, b: 0, c: 0, u: 0, v: 0, w: 0 }
}

/** Fallback: scan every triangle. Used only when the seed-vertex heuristic
 *  misses (very rare — usually only near degenerate mesh spots). */
function scanAllTriangles(
  dx: number,
  dy: number,
  dz: number,
  restPositions: Float32Array,
  indexBuffer: Uint16Array | Uint32Array,
  triCount: number
): {
  triIdx: number
  a: number
  b: number
  c: number
  u: number
  v: number
  w: number
} {
  for (let t = 0; t < triCount; t++) {
    const a = indexBuffer[t * 3]
    const b = indexBuffer[t * 3 + 1]
    const c = indexBuffer[t * 3 + 2]
    const hit = intersectRay(
      dx,
      dy,
      dz,
      restPositions[a * 3],
      restPositions[a * 3 + 1],
      restPositions[a * 3 + 2],
      restPositions[b * 3],
      restPositions[b * 3 + 1],
      restPositions[b * 3 + 2],
      restPositions[c * 3],
      restPositions[c * 3 + 1],
      restPositions[c * 3 + 2]
    )
    if (hit) return { triIdx: t, a, b, c, u: hit.u, v: hit.v, w: hit.w }
  }
  // Should never happen for a closed mesh: fall back to first triangle with
  // dummy weights so we don't crash. Sprinkle will be at vertex 0.
  return {
    triIdx: 0,
    a: indexBuffer[0],
    b: indexBuffer[1],
    c: indexBuffer[2],
    u: 1,
    v: 0,
    w: 0
  }
}

function pickIndices(unitDirs: Float32Array, count: number): number[] {
  if (count <= 0) return []
  const total = unitDirs.length / 3
  const n = Math.min(count, total)
  const stride = Math.max(1, total / n)
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    out.push(Math.floor(i * stride) % total)
  }
  return out
}

/** Build a density field for powder that mirrors the ink swirl ribbon
 *  mask, parametrised by amount (0..1). Nested-sine turbulence with a
 *  "score = 1 near a zero-crossing, 0 elsewhere" shape. Ribbon WIDTH
 *  scales with amount — small amount = tight narrow band, large amount =
 *  fat band. */
function makePowderDensity(
  amount: number
): (x: number, y: number, z: number) => number {
  const threshold = 0.05 + 0.65 * amount
  return (x, y, z) => {
    let px = x * 1.6
    let py = y * 1.6
    let pz = z * 1.6
    let n = 0
    let amp = 1
    for (let i = 0; i < 4; i++) {
      n += amp * Math.sin(px * 1.7 + Math.sin(py * 1.3 + pz * 0.9) * 2)
      px *= 2.05
      py *= 2.05
      pz *= 2.05
      amp *= 0.5
    }
    const absN = Math.abs(n)
    const t = absN < threshold ? absN / threshold : 1
    return 1 - t * t * (3 - 2 * t)
  }
}

/** Faceted 3D grain used exclusively for powder. Radius 1 in local space
 *  so the instance's uniform scale maps directly to grain size. Octahedron
 *  gives 8 flat faces — combined with per-grain random rotation and a
 *  glossy-metal material, each face catches light on its own axis and the
 *  aggregate reads as a sparkling glitter field rather than uniform dots. */
function buildPowderGrainGeometry(): THREE.BufferGeometry {
  const geo = new THREE.OctahedronGeometry(1, 0)
  geo.computeVertexNormals()
  return geo
}

/** Flat sprinkle geometry — normalized so scale.x/y = half-width/height and
 *  scale.z = half-depth. All shapes are built centered at origin with their
 *  face normal along +Z (which we then rotate to match the surface normal). */
function buildSprinkleGeometry(shape: SprinkleShapeId): THREE.BufferGeometry {
  const depth = 0.5 // scale.z multiplier will make this tiny
  const bevel = {
    bevelEnabled: true,
    bevelThickness: 0.05,
    bevelSize: 0.04,
    bevelSegments: 1,
    depth,
    curveSegments: 6
  }
  switch (shape) {
    case 'dot': {
      const s = new THREE.Shape()
      s.absarc(0, 0, 0.9, 0, Math.PI * 2, false)
      const geo = new THREE.ExtrudeGeometry(s, { ...bevel, curveSegments: 12 })
      geo.translate(0, 0, -depth / 2)
      geo.computeVertexNormals()
      return geo
    }
    case 'star': {
      const s = new THREE.Shape()
      const outer = 1.0
      const inner = 0.42
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
      const geo = new THREE.ExtrudeGeometry(s, bevel)
      geo.translate(0, 0, -depth / 2)
      geo.computeVertexNormals()
      return geo
    }
    case 'heart': {
      const s = new THREE.Shape()
      s.moveTo(0, -0.9)
      s.bezierCurveTo(1.2, 0.05, 0.8, 1.05, 0, 0.4)
      s.bezierCurveTo(-0.8, 1.05, -1.2, 0.05, 0, -0.9)
      const geo = new THREE.ExtrudeGeometry(s, bevel)
      geo.translate(0, 0.05, -depth / 2)
      geo.computeVertexNormals()
      return geo
    }
    case 'bar': {
      const s = new THREE.Shape()
      const w = 0.3
      const h = 1.0
      const r = 0.12 // rounded corners
      s.moveTo(-w + r, -h)
      s.lineTo(w - r, -h)
      s.quadraticCurveTo(w, -h, w, -h + r)
      s.lineTo(w, h - r)
      s.quadraticCurveTo(w, h, w - r, h)
      s.lineTo(-w + r, h)
      s.quadraticCurveTo(-w, h, -w, h - r)
      s.lineTo(-w, -h + r)
      s.quadraticCurveTo(-w, -h, -w + r, -h)
      const geo = new THREE.ExtrudeGeometry(s, { ...bevel, curveSegments: 4 })
      geo.translate(0, 0, -depth / 2)
      geo.computeVertexNormals()
      return geo
    }
    case 'diamond': {
      const s = new THREE.Shape()
      s.moveTo(0, 1)
      s.lineTo(0.7, 0)
      s.lineTo(0, -1)
      s.lineTo(-0.7, 0)
      s.closePath()
      const geo = new THREE.ExtrudeGeometry(s, { ...bevel, curveSegments: 2 })
      geo.translate(0, 0, -depth / 2)
      geo.computeVertexNormals()
      return geo
    }
  }
}
