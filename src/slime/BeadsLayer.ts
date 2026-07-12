import * as THREE from 'three'
import {
  BEAD_COLORS,
  BEAD_MATERIAL_PARAMS,
  type BeadColorId,
  type BeadDistributionId,
  type BeadMaterialId,
  type BeadsConfig
} from './presets'

const MAX_BEADS = 400

/**
 * A decorative layer of round beads that latch onto specific vertex indices,
 * so they follow the soft-body deformation each frame. Uses InstancedMesh for
 * one-draw-call rendering of up to `MAX_BEADS` beads.
 */
export class BeadsLayer {
  readonly group: THREE.Group
  private instanced: THREE.InstancedMesh | null = null
  private vertexIndices: number[] = []
  private currentMaterialId: BeadMaterialId = 'glossy'
  private config: BeadsConfig = {
    colors: [],
    size: 0.05,
    count: 0,
    distribution: 'uniform',
    material: 'glossy'
  }

  private readonly _matrix = new THREE.Matrix4()
  private readonly _pos = new THREE.Vector3()
  private readonly _scale = new THREE.Vector3()
  private readonly _quat = new THREE.Quaternion()
  private readonly _up = new THREE.Vector3(0, 1, 0)
  private readonly _color = new THREE.Color()

  constructor() {
    this.group = new THREE.Group()
  }

  get currentConfig(): Readonly<BeadsConfig> {
    return this.config
  }

  private ensureInstanced() {
    if (this.instanced) return
    const geo = new THREE.SphereGeometry(1, 32, 24)
    const mat = new THREE.MeshPhysicalMaterial({ color: 0xffffff })
    this.applyMaterialParams(mat, this.config.material)
    this.currentMaterialId = this.config.material
    const im = new THREE.InstancedMesh(geo, mat, MAX_BEADS)
    im.frustumCulled = false
    im.count = 0
    im.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_BEADS * 3),
      3
    )
    this.group.add(im)
    this.instanced = im
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

  setConfig(config: BeadsConfig, unitDirs: Float32Array) {
    this.ensureInstanced()
    this.config = { ...config, colors: [...config.colors] }
    const count = Math.min(config.count, MAX_BEADS)
    this.vertexIndices = pickIndices(unitDirs, config.distribution, count)

    const im = this.instanced!
    im.count = this.vertexIndices.length

    // Refresh the shared material when the material selection changes.
    if (config.material !== this.currentMaterialId) {
      this.applyMaterialParams(
        im.material as THREE.MeshPhysicalMaterial,
        config.material
      )
      this.currentMaterialId = config.material
    }

    // Effective palette: fall back to pearl white if user cleared all colors.
    const palette = colorsToHex(
      config.colors.length > 0 ? config.colors : ['pearl']
    )
    for (let i = 0; i < this.vertexIndices.length; i++) {
      this._color.setHex(palette[i % palette.length])
      im.setColorAt(i, this._color)
    }
    if (im.instanceColor) im.instanceColor.needsUpdate = true
  }

  /** Rebuild in place using current config against fresh unit dirs. */
  reseat(unitDirs: Float32Array) {
    if (!this.instanced || this.config.count === 0) return
    this.setConfig(this.config, unitDirs)
  }

  /** Follow the current (deformed) vertex positions each frame. */
  update(currentPositions: Float32Array) {
    const im = this.instanced
    if (!im || im.count === 0) return
    const size = this.config.size

    for (let i = 0; i < this.vertexIndices.length; i++) {
      const vi = this.vertexIndices[i]
      const x = currentPositions[vi * 3]
      const y = currentPositions[vi * 3 + 1]
      const z = currentPositions[vi * 3 + 2]

      this._pos.set(x, y, z)
      // Orient outward from origin so beads seat flush against the surface.
      const len = Math.hypot(x, y, z) || 1
      this._quat.setFromUnitVectors(
        this._up,
        this._pos.clone().divideScalar(len)
      )
      this._scale.set(size, size, size)
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

/** Small integer hash → [0, 1). Used for deterministic pseudo-random ordering. */
function hash01(i: number): number {
  const x = ((i + 1) * 2654435761) >>> 0
  return x / 0xffffffff
}

/**
 * Choose `count` vertex indices according to a distribution pattern. Deterministic
 * so bead layout doesn't jump around when the user tweaks size or amount.
 */
function pickIndices(
  unitDirs: Float32Array,
  dist: BeadDistributionId,
  count: number
): number[] {
  if (count <= 0) return []
  const total = unitDirs.length / 3

  // Filter candidate indices to a region of the sphere.
  let candidates: number[]
  switch (dist) {
    case 'top':
      candidates = filterY(unitDirs, total, (y) => y > 0.3)
      break
    case 'bottom':
      candidates = filterY(unitDirs, total, (y) => y < -0.3)
      break
    case 'equator':
      candidates = filterY(unitDirs, total, (y) => Math.abs(y) < 0.3)
      break
    default:
      candidates = allIndices(total)
  }
  if (candidates.length === 0) candidates = allIndices(total)

  if (dist === 'random') {
    // Deterministic shuffle: sort by hash, take first N.
    candidates.sort((a, b) => hash01(a) - hash01(b))
    return candidates.slice(0, Math.min(count, candidates.length))
  }

  // Even stride through the candidate list. This keeps beads spread out even
  // when count is much smaller than the candidate pool.
  const n = Math.min(count, candidates.length)
  const stride = Math.max(1, candidates.length / n)
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(i * stride) % candidates.length
    out.push(candidates[idx])
  }
  return out
}

function allIndices(total: number): number[] {
  const arr: number[] = new Array(total)
  for (let i = 0; i < total; i++) arr[i] = i
  return arr
}

function filterY(
  unitDirs: Float32Array,
  total: number,
  pred: (y: number) => boolean
): number[] {
  const out: number[] = []
  for (let i = 0; i < total; i++) {
    if (pred(unitDirs[i * 3 + 1])) out.push(i)
  }
  return out
}
