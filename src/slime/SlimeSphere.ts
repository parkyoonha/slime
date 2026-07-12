import * as THREE from 'three'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import {
  COATINGS,
  COLORS,
  type CoatingId,
  type ColorId,
  type ShapeId,
  shapeScale
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
  velSmoothing: 0.15,
  // dispSmoothing pulls deformations back toward the average of neighbor
  // displacements — that's a spring-back in disguise. Keep it at 0 so
  // kneading is truly plastic.
  dispSmoothing: 0,
  maxDisplacement: 0.65,
  volumePreservation: 0.12
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
  /** Sum of |restPos|² across all vertices — a cheap proxy for volume that
   *  we use to scale the mesh back up when the user compresses it. */
  private restVolumeMetric = 0
  /** Per-vertex accumulated damage 0..1. Grows with kneading force and never
   *  fully recovers on its own — reset()/setShape() zero it. Used by the wax
   *  coating shader to draw a spreading crack pattern. */
  private readonly damage: Float32Array
  private readonly damageAttr: THREE.BufferAttribute
  private restAttr!: THREE.BufferAttribute
  /** Shader uniform: 1 when the wax coating is active, 0 otherwise. Multiplied
   *  into the crack effect so other coatings look untouched even after damage
   *  has been accrued. */
  private readonly damageEnabledUniform = { value: 0.0 }
  private accumulatedForce = 0

  constructor(params: Partial<SlimeParams> = {}) {
    this.params = { ...DEFAULTS, ...params }

    // Merge duplicate seam vertices so we can build a real adjacency graph.
    // Without this the icosphere has repeated positions at shared edges and
    // Laplacian smoothing would tear the mesh apart.
    this.geometry = mergeVertices(
      new THREE.IcosahedronGeometry(this.params.radius, this.params.detail)
    )
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

    // Rest position as a vertex attribute so the wax shader can (a) sample
    // the voronoi plate pattern in the un-deformed frame (plates stay fixed
    // size instead of stretching with the mesh), and (b) compute per-vertex
    // displacement and widen cracks proportionally.
    this.restAttr = new THREE.BufferAttribute(this.restPositions, 3)
    this.restAttr.setUsage(THREE.DynamicDrawUsage)
    this.geometry.setAttribute('aRestPos', this.restAttr)

    const material = new THREE.MeshPhysicalMaterial({
      color: 0xff9ec7,
      roughness: 0.18,
      metalness: 0.0,
      transmission: 0.35,
      thickness: 1.2,
      ior: 1.35,
      clearcoat: 1.0,
      clearcoatRoughness: 0.08,
      sheen: 0.4,
      sheenColor: new THREE.Color(0xffe0ee),
      side: THREE.DoubleSide
    })
    installDamageShader(material, this.damageEnabledUniform)

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
      const [sx, sy, sz] = shapeScale(shape, nx, ny, nz)
      rest[i] = nx * sx * r
      rest[i + 1] = ny * sy * r
      rest[i + 2] = nz * sz * r
    }
    arr.set(rest)
    for (let i = 0; i < this.velocities.length; i++) this.velocities[i] *= 0.3
    this.damage.fill(0)
    this.damageAttr.needsUpdate = true
    this.restAttr.needsUpdate = true
    this.recomputeRestVolumeMetric()
    posAttr.needsUpdate = true
    this.geometry.computeVertexNormals()
  }

  private recomputeRestVolumeMetric() {
    let total = 0
    const rest = this.restPositions
    for (let i = 0; i < rest.length; i++) total += rest[i] * rest[i]
    this.restVolumeMetric = total
  }

  setColor(id: ColorId) {
    const preset = COLORS.find((c) => c.id === id)
    if (!preset) return
    ;(this.mesh.material as THREE.MeshPhysicalMaterial).color.setHex(
      preset.hex
    )
  }

  setCoating(id: CoatingId) {
    const preset = COATINGS.find((c) => c.id === id)
    if (!preset) return
    const mat = this.mesh.material as THREE.MeshPhysicalMaterial
    const p = preset.params
    mat.roughness = p.roughness
    mat.transmission = p.transmission
    mat.thickness = p.thickness
    mat.ior = p.ior
    mat.clearcoat = p.clearcoat
    mat.clearcoatRoughness = p.clearcoatRoughness
    mat.metalness = p.metalness
    mat.sheen = p.sheen
    mat.sheenRoughness = p.sheenRoughness
    mat.sheenColor.setHex(p.sheenColorHex)
    mat.needsUpdate = true
  }

  get restPositionArray(): Float32Array {
    return this.restPositions
  }

  get positionArray(): Float32Array {
    return this.geometry.attributes.position.array as Float32Array
  }

  get unitDirsArray(): Float32Array {
    return this.unitDirs
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

      // Accumulate per-vertex damage (bounded 0..1). Rate is tuned so a
      // brief press starts opening a few cells and sustained kneading
      // spreads cracks noticeably further outward.
      if (localForceMag > 0) {
        const vi = i / 3
        const d = this.damage[vi] + localForceMag * dt * 0.12
        this.damage[vi] = d < 1 ? d : 1
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
    if (dispSmoothing > 0) {
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

    // 5) Volume preservation — gently scale every vertex radially so the mesh
    //    keeps its rest volume. Pressing flat on one side of a sphere makes
    //    the sides bulge outward instead of the whole ball shrinking.
    if (volumePreservation > 0 && this.restVolumeMetric > 0) {
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

    posAttr.needsUpdate = true
    this.geometry.computeVertexNormals()
  }

  reset() {
    const posAttr = this.geometry.attributes.position as THREE.BufferAttribute
    const arr = posAttr.array as Float32Array
    arr.set(this.restPositions)
    this.velocities.fill(0)
    this.damage.fill(0)
    this.damageAttr.needsUpdate = true
    posAttr.needsUpdate = true
    this.geometry.computeVertexNormals()
  }

  /** Zero the crack pattern without touching the geometry. */
  clearDamage() {
    this.damage.fill(0)
    this.damageAttr.needsUpdate = true
  }

  /** Approximation of "how hard the user is squishing right now". */
  get pressureThisFrame(): number {
    return this.accumulatedForce
  }

  /** Enable/disable the crack rendering effect (wired to coating selection). */
  setDamageRenderingEnabled(on: boolean) {
    this.damageEnabledUniform.value = on ? 1.0 : 0.0
  }

  get damageRenderingEnabled(): boolean {
    return this.damageEnabledUniform.value > 0.5
  }

  dispose() {
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
 * to the fragment shader and paint procedural voronoi-cell cracks when the
 * damage uniform is enabled. The base PBR shading otherwise runs unchanged.
 */
function installDamageShader(
  material: THREE.MeshPhysicalMaterial,
  enabledUniform: { value: number }
) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uDamageEnabled = enabledUniform

    shader.vertexShader =
      `attribute float damage;
       attribute vec3 aRestPos;
       varying float vDamage;
       varying vec3 vRest;
       varying float vStretch;
      ` +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vDamage = damage;
         // Rest position anchors the voronoi cells so plate SIZES stay
         // constant — deformation moves plates but doesn't stretch them.
         vRest = aRestPos;
         // Only outward radial displacement counts as "stretch" — pressing a
         // vertex INWARD compresses the wax (should not crack open the
         // plates there), while a vertex bulging OUTWARD from volume
         // preservation genuinely pulls the shell apart.
         vec3 restDir = length(aRestPos) > 1e-4
           ? aRestPos / length(aRestPos)
           : vec3(0.0, 0.0, 1.0);
         vStretch = max(0.0, dot(position - aRestPos, restDir));`
      )

    shader.fragmentShader =
      `uniform float uDamageEnabled;
       varying float vDamage;
       varying vec3 vRest;
       varying float vStretch;

       float damageHash(vec2 p) {
         p = fract(p * vec2(233.34, 851.73));
         p += dot(p, p + 23.45);
         return fract(p.x * p.y);
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
           float crackReveal = 0.0;
           // Enter the crack pass whenever there is EITHER damage OR
           // outward stretch — silhouette vertices never accumulate damage
           // but do stretch from volume preservation, and we want them to
           // crack too.
           if (uDamageEnabled > 0.5 && (vDamage > 0.02 || vStretch > 0.02)) {
             // Voronoi anchored in the REST frame: cell sizes stay constant.
             // Kneading only decides "is this seam crackable yet" (visibility).
             // What actually pushes the plates apart is the mesh STRETCHING —
             // volume-preservation bulges and finger-pressed inflation both
             // grow vStretch, which is the dominant term in crack width.
             vec2 v = damageVoronoi(vRest * 3.5);

             // Two independent visibility ramps merged with max():
             //  - kneaded plates crack from accumulated damage,
             //  - silhouette / opposite-side plates crack from volume-
             //    preservation stretch alone (no finger ever touched them).
             // Without the second ramp, edges stayed pristine no matter how
             // much they bulged.
             float visibility = max(
               smoothstep(0.12, 0.3, vDamage),
               smoothstep(0.05, 0.18, vStretch)
             );

             // No base hairline — only cells with actual damage/stretch
             // build a visible crack. Both terms are strong so once a cell
             // starts cracking it gapes open substantially.
             float damageWidth = smoothstep(0.18, 0.7, vDamage) * 0.11;
             float stretchWidth = clamp(vStretch, 0.0, 0.4) * 0.75;
             // 0.3..2.1: some cells (low y) stay tight, others (high y) open
             // multiple times wider than the median — organic variation.
             float perCell = 0.3 + v.y * 1.8;
             float crackWidth = (damageWidth + stretchWidth) * perCell;
             // Absolute ceiling — raised so the widest seams can gape open
             // dramatically while narrow ones stay hairlines.
             crackWidth = min(crackWidth, 0.55);

             // Hard-edged reveal: crack interior is fully exposed, plate is
             // fully covered. Transition happens in a tiny sliver right at
             // the boundary so we get anti-aliasing but no soft washout.
             float edgeBand = min(0.004, crackWidth * 0.15);
             crackReveal = (1.0 - smoothstep(
               crackWidth - edgeBand,
               crackWidth,
               v.x
             )) * visibility;

             // Slime showing through cracks is pushed hard toward white so it
             // reads as a distinct bright layer against the coated plates.
             vec3 slimeTint = mix(diffuseColor.rgb, vec3(1.0), 0.85);
             diffuseColor.rgb =
               mix(diffuseColor.rgb, slimeTint, crackReveal);
           }`
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
           if (crackReveal > 0.0) {
             // Exposed slime is much glossier than the waxy shell.
             roughnessFactor = mix(roughnessFactor, 0.12, crackReveal * 0.9);
           }`
        )
        .replace(
          // Boost the diffuse contribution inside the crack strips so the
          // bright slime clearly punches through the wax's warm sheen tint.
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
