import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import {
  BEAD_MATERIAL_PARAMS,
  resolveCustomBeadHex,
  type BeadShapeId,
  type ColorAdjustments,
  type CustomBeadsConfig
} from './presets'

const MAX_CUSTOM_BEADS = 40

/**
 * 커스텀비즈. Emoji-style additive layer of coloured 3D bead meshes.
 *
 * Small pool of up to MAX_CUSTOM_BEADS beads placed on the slime's front
 * hemisphere by an even Fibonacci-sphere sampling limited to +Z. Each
 * bead uses the shape buildBeadGeometry produces for the requested
 * BeadShapeId and picks its colour by cycling through config.colors.
 *
 * Physics is intentionally simple for the first pass — beads snap to
 * the nearest slime vertex each frame to follow deformation but don't
 * yet expose a drag handle. The interface (update / reseat / dispose)
 * mirrors EmojiBeadsLayer so SlimeApp can wire this in the same slot.
 */
export class CustomBeadsLayer {
  readonly group: THREE.Group
  private config: CustomBeadsConfig = {
    colors: [],
    shapes: ['disc'],
    size: 0.28,
    count: 0,
    flatness: 0
  }
  private adjustments: ColorAdjustments = {}
  /** Per-bead anchor slime vertex index — used by update() to sample
   *  the deformed surface each frame. Populated by reseat(). */
  private anchorIdx: Uint32Array = new Uint32Array(0)
  /** Per-bead outward direction on the FRONT hemisphere. Snapped
   *  to the nearest slime vertex direction so subsequent reseat()
   *  calls (shape change) keep beads on their slots. */
  private anchorDirs: Float32Array = new Float32Array(0)
  /** Slot of meshes — one per bead index, disposed / rebuilt when
   *  config.shapes changes so each bead can carry its own geometry. */
  private meshes: THREE.Mesh[] = []
  /** Cached shape id used for each mesh; drives the buildGeometry
   *  swap when config.shapes rotates. */
  private meshShape: BeadShapeId[] = []
  private material: THREE.MeshPhysicalMaterial
  /** Shared photo texture printed on every custom bead's outward
   *  face when set. Uniform ref is threaded into each cloned bead
   *  material via onBeforeCompile so updating this affects them all. */
  private photoTexture: THREE.Texture | null = null
  private readonly photoUseUniform = { value: 0.0 }
  private readonly photoMapUniform: { value: THREE.Texture | null } = {
    value: null
  }
  private readonly _forward = new THREE.Vector3(0, 0, 1)
  private readonly _outward = new THREE.Vector3()
  private readonly _quat = new THREE.Quaternion()
  /** Set true by SlimeApp whenever the outer slime is covered by a
   *  full-fill compact bead shell. Adds a small outward offset so
   *  custom beads clear the shell instead of sinking into it; when
   *  false (naked slime), custom beads sit flush against the surface. */
  private fillLayerActive = false
  /** Gradient LUT uniforms — shared across every cloned bead material
   *  so one recolour rebuild updates all beads at once. */
  private readonly gradientUseUniform = { value: 0.0 }
  private readonly gradientTexUniform: { value: THREE.Texture | null } = {
    value: null
  }
  private gradientTexture: THREE.DataTexture | null = null

  constructor() {
    this.group = new THREE.Group()
    // Draw custom beads AFTER the main compact / chunk bead layers so
    // they visually sit on top even when a full-fill shell would
    // otherwise Z-fight or occlude them. Depth test stays on so a bead
    // on the far side still hides behind the slime silhouette.
    this.group.renderOrder = 20
    // One shared material — per-bead colour comes via mesh.material
    // clone on rebuild. Plastic params match BEAD_MATERIAL_PARAMS so
    // the accent beads read consistent with the main beads layer.
    const params = BEAD_MATERIAL_PARAMS.plastic
    this.material = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      roughness: params.roughness,
      metalness: params.metalness,
      clearcoat: params.clearcoat,
      clearcoatRoughness: params.clearcoatRoughness,
      transmission: params.transmission,
      thickness: params.thickness,
      ior: params.ior,
      sheen: params.sheen,
      sheenRoughness: params.sheenRoughness,
      iridescence: params.iridescence,
      iridescenceIOR: params.iridescenceIOR,
      envMapIntensity: params.envMapIntensity
    })
    this.installPhotoShader(this.material)
  }

  /** Attach onBeforeCompile that samples the shared photo texture on
   *  the bead's outward face (local +Z). Each cloned mesh material
   *  inherits this hook + shares the same uniform refs so a single
   *  setPhoto call retextures every bead at once. */
  private installPhotoShader(mat: THREE.MeshPhysicalMaterial) {
    const useU = this.photoUseUniform
    const mapU = this.photoMapUniform
    const gradUseU = this.gradientUseUniform
    const gradTexU = this.gradientTexUniform
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uCbPhotoUse = useU
      shader.uniforms.uCbPhotoMap = mapU
      shader.uniforms.uCbGradientUse = gradUseU
      shader.uniforms.uCbGradient = gradTexU
      shader.vertexShader =
        `varying vec3 vCbLocal;\n` +
        shader.vertexShader.replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           vCbLocal = position;`
        )
      shader.fragmentShader =
        `uniform float uCbPhotoUse;
         uniform sampler2D uCbPhotoMap;
         uniform float uCbGradientUse;
         uniform sampler2D uCbGradient;
         varying vec3 vCbLocal;
        ` +
        shader.fragmentShader.replace(
          '#include <map_fragment>',
          `#include <map_fragment>
           // Per-bead gradient — samples the shared palette LUT keyed
           // off this vertex's Y in bead-local space, so every bead
           // shows the full top-to-bottom gradient across ITSELF (not
           // one flat colour per bead).
           if (uCbGradientUse > 0.5) {
             float gt = clamp(vCbLocal.y * 0.5 + 0.5, 0.0, 1.0);
             diffuseColor.rgb =
               texture2D(uCbGradient, vec2(gt, 0.5)).rgb;
           }
           if (uCbPhotoUse > 0.5) {
             vec2 uv = vec2(
               vCbLocal.x * 0.5 + 0.5,
               1.0 - (vCbLocal.y * 0.5 + 0.5)
             );
             float rXY = length(vec2(vCbLocal.x, vCbLocal.y));
             float radialMask = 1.0 - smoothstep(0.94, 1.0, rXY);
             float zMask = smoothstep(0.0, 0.35, vCbLocal.z);
             float photoAlpha = radialMask * zMask;
             if (photoAlpha > 0.001) {
               vec3 photoRGB = texture2D(uCbPhotoMap, uv).rgb;
               diffuseColor.rgb =
                 mix(diffuseColor.rgb, photoRGB, photoAlpha);
             }
           }`
        )
    }
  }

  /** Compute (size, size, size * flattenFactor) so a flatness=1 bead
   *  reads as a coin along the outward axis without changing its
   *  in-plane footprint. Called from both setConfig (on rebuild) and
   *  after any config change so the sliders live-update. */
  private applyMeshScale(mesh: THREE.Mesh) {
    const s = this.config.size
    const flatZ = s * (1 - 0.85 * Math.max(0, Math.min(1, this.config.flatness)))
    mesh.scale.set(s, s, flatZ)
  }

  setPhoto(texture: THREE.Texture | null) {
    if (this.photoTexture && this.photoTexture !== texture) {
      this.photoTexture.dispose()
    }
    this.photoTexture = texture
    this.photoMapUniform.value = texture
    this.photoUseUniform.value = texture ? 1.0 : 0.0
  }

  setColorAdjustments(adjustments: ColorAdjustments) {
    this.adjustments = adjustments
    this.recolour()
  }

  /** Rebuild the bead pool to match `config`. Reuses existing meshes
   *  when only colours / positions changed; only rebuilds geometry
   *  when a bead's assigned shape actually differs. */
  setConfig(cfg: CustomBeadsConfig, unitDirs: Float32Array) {
    this.config = { ...cfg, colors: [...cfg.colors], shapes: [...cfg.shapes] }
    const desiredCount = Math.min(cfg.count, MAX_CUSTOM_BEADS)
    // Assign per-bead shape by cycling through the selected shapes
    // list (bead i → shapes[i % shapes.length]).
    const shapes: BeadShapeId[] =
      cfg.shapes.length > 0 ? cfg.shapes : ['sphere']
    // Trim excess meshes.
    while (this.meshes.length > desiredCount) {
      const mesh = this.meshes.pop()!
      this.meshShape.pop()
      this.group.remove(mesh)
      mesh.geometry.dispose()
    }
    // Add / rebuild meshes to reach the desired count.
    for (let i = 0; i < desiredCount; i++) {
      const wantShape: BeadShapeId = shapes[i % shapes.length]
      if (
        i >= this.meshes.length ||
        this.meshShape[i] !== wantShape
      ) {
        const geo = buildBeadGeometry(wantShape)
        const mat = this.material.clone()
        // `.clone()` copies material params but does NOT re-run the
        // onBeforeCompile mixin — every cloned material has to be
        // hooked separately so its shader receives the photo + per-
        // bead gradient uniforms.
        this.installPhotoShader(mat)
        const mesh = new THREE.Mesh(geo, mat)
        if (i < this.meshes.length) {
          this.group.remove(this.meshes[i])
          this.meshes[i].geometry.dispose()
          this.meshes[i] = mesh
          this.meshShape[i] = wantShape
          this.group.add(mesh)
        } else {
          this.meshes.push(mesh)
          this.meshShape.push(wantShape)
          this.group.add(mesh)
        }
      }
      // Always re-apply the per-bead scale (size + flatness) so tweaks
      // to either slider ripple through without needing a full rebuild.
      this.applyMeshScale(this.meshes[i])
    }
    this.recolour()
    this.reseat(unitDirs)
  }

  /** Re-assign each bead's anchor to its nearest slime vertex. Called
   *  by SlimeApp on shape change and after setConfig.
   *
   *  Placement matches EmojiBeadsLayer's "cluster tight on +Z front cap"
   *  strategy — beads bunch up on the visible face like a pinned set of
   *  charms instead of spreading around the full front hemisphere. Each
   *  fresh anchor observes a minimum angular gap sized to the current
   *  bead diameter so beads don't overlap each other, matching the
   *  emoji layer's spacing rule. Preserved anchors (existing bead slots
   *  the user may have dragged) survive across reseats and act as
   *  immovable obstacles for the spacing check on new slots. */
  reseat(unitDirs: Float32Array) {
    const n = this.meshes.length
    if (this.anchorIdx.length !== n) {
      this.anchorIdx = new Uint32Array(n)
    }
    const prevDirs = this.anchorDirs
    const prevN = Math.floor(prevDirs.length / 3)
    const newDirs = new Float32Array(n * 3)
    const preservedCount = Math.min(prevN, n)
    for (let i = 0; i < preservedCount * 3; i++) {
      newDirs[i] = prevDirs[i]
    }
    // Only rebuild fresh anchors when there are new slots to fill —
    // shrinking or same-count reseat leaves every drag-position intact.
    if (n > preservedCount) {
      const total = unitDirs.length / 3
      // Rank EVERY vertex by descending z so beads start clustered at
      // the +Z pole (visible face) and spill outward toward the equator
      // (and beyond, if needed) as count × size demands. No hard front-
      // cap: capping to z > 0.4 makes 40 large beads impossible to place
      // without overlap. Sorting the entire sphere means we always find
      // room while still preferring the front for the first picks.
      const rankedIndices: number[] = new Array(total)
      for (let j = 0; j < total; j++) rankedIndices[j] = j
      rankedIndices.sort(
        (a, b) => unitDirs[b * 3 + 2] - unitDirs[a * 3 + 2]
      )
      // Chord distance we require between anchor unit-dirs. Sized to
      // the WORST-CASE per-shape footprint: cube extends to 1.5× the
      // slider size (RoundedBoxGeometry outer = 1.5), torus / heart /
      // star also stretch past a plain sphere's radius, so 1× the
      // slider size would let those shapes visibly overlap even
      // though sphere-to-sphere beads at that distance just touched.
      // 2.4× the slider size leaves a clear visual gap for every
      // shape in the mix. Clamped so it never becomes un-satisfiable.
      const targetChord = Math.min(1.9, this.config.size * 2.4)
      const maxDot = Math.max(-1, 1 - (targetChord * targetChord) / 2)
      const placedDirs: number[] = []
      for (let i = 0; i < preservedCount; i++) {
        placedDirs.push(
          newDirs[i * 3],
          newDirs[i * 3 + 1],
          newDirs[i * 3 + 2]
        )
      }
      const usedVerts = new Set<number>()
      for (let i = preservedCount; i < n; i++) {
        let picked = -1
        for (const cand of rankedIndices) {
          if (usedVerts.has(cand)) continue
          const cx = unitDirs[cand * 3]
          const cy = unitDirs[cand * 3 + 1]
          const cz = unitDirs[cand * 3 + 2]
          let ok = true
          for (let k = 0; k < placedDirs.length; k += 3) {
            const dot =
              cx * placedDirs[k] +
              cy * placedDirs[k + 1] +
              cz * placedDirs[k + 2]
            if (dot > maxDot) {
              ok = false
              break
            }
          }
          if (ok) {
            picked = cand
            break
          }
        }
        // Truly no room — sphere is packed to the limit for this size.
        // Skip the remaining beads rather than fall back to any vertex,
        // because a fallback would guarantee overlap and the user asked
        // for strict non-overlap regardless of count / size. In practice
        // this branch is unreachable under CUSTOM_BEADS_LIMITS (40 beads
        // at size 0.45 occupy ~40% of the sphere with slack to spare).
        if (picked < 0) break
        usedVerts.add(picked)
        newDirs[i * 3] = unitDirs[picked * 3]
        newDirs[i * 3 + 1] = unitDirs[picked * 3 + 1]
        newDirs[i * 3 + 2] = unitDirs[picked * 3 + 2]
        placedDirs.push(
          unitDirs[picked * 3],
          unitDirs[picked * 3 + 1],
          unitDirs[picked * 3 + 2]
        )
      }
    }
    this.anchorDirs = newDirs
    const total = unitDirs.length / 3
    for (let i = 0; i < n; i++) {
      const dx = this.anchorDirs[i * 3]
      const dy = this.anchorDirs[i * 3 + 1]
      const dz = this.anchorDirs[i * 3 + 2]
      let best = 0
      let bestDot = -Infinity
      for (let j = 0; j < total; j++) {
        const d =
          unitDirs[j * 3] * dx +
          unitDirs[j * 3 + 1] * dy +
          unitDirs[j * 3 + 2] * dz
        if (d > bestDot) {
          bestDot = d
          best = j
        }
      }
      this.anchorIdx[i] = best
    }
  }

  /** Raycast pick — returns the index of the topmost hit custom-bead
   *  mesh, or -1 if the ray misses every bead. Meshes are children of
   *  `group`, so caller can also raycast the group directly; this
   *  helper hides the mesh → index mapping. */
  pickBead(raycaster: THREE.Raycaster): number {
    if (this.meshes.length === 0) return -1
    const hits = raycaster.intersectObjects(this.meshes, false)
    if (hits.length === 0) return -1
    return this.meshes.indexOf(hits[0].object as THREE.Mesh)
  }

  /** Re-seat a single bead at the requested unit direction on the slime
   *  surface. Updates the persisted anchorDirs slot AND re-picks the
   *  nearest slime vertex for anchorIdx so the drag position sticks
   *  across subsequent frames / reseats. */
  setBeadDir(idx: number, unitDir: THREE.Vector3, unitDirs: Float32Array) {
    if (idx < 0 || idx >= this.meshes.length) return
    if (this.anchorDirs.length < (idx + 1) * 3) return
    this.anchorDirs[idx * 3] = unitDir.x
    this.anchorDirs[idx * 3 + 1] = unitDir.y
    this.anchorDirs[idx * 3 + 2] = unitDir.z
    const total = unitDirs.length / 3
    let best = 0
    let bestDot = -Infinity
    for (let j = 0; j < total; j++) {
      const d =
        unitDirs[j * 3] * unitDir.x +
        unitDirs[j * 3 + 1] * unitDir.y +
        unitDirs[j * 3 + 2] * unitDir.z
      if (d > bestDot) {
        bestDot = d
        best = j
      }
    }
    this.anchorIdx[idx] = best
  }

  update(currentPositions: Float32Array) {
    const n = this.meshes.length
    for (let i = 0; i < n; i++) {
      const vi = this.anchorIdx[i]
      const px = currentPositions[vi * 3]
      const py = currentPositions[vi * 3 + 1]
      const pz = currentPositions[vi * 3 + 2]
      const mesh = this.meshes[i]
      const rMag = Math.hypot(px, py, pz) || 1
      const nx = px / rMag
      const ny = py / rMag
      const nz = pz / rMag
      // Move the bead inward toward the slime as flatness grows so
      // the flat side stays pressed against (or embedded slightly
      // below) the slime surface instead of hovering above it. At
      // flatness=0 the bead sits with ~10% embed like a marble
      // pressed into dough; at flatness=1 the bead is buried nearly
      // flush so only its outer face reads as a raised coin on the
      // slime.
      const flatness = Math.max(
        0,
        Math.min(1, this.config.flatness)
      )
      // Base outward offset — bead nestled into the slime surface.
      // Reduced baseline (was 0.4) so a naked slime shows the bead
      // partially embedded rather than sitting proud. A full-fill
      // compact shell adds a small extra lift so custom beads still
      // clear it without floating too far above.
      const fillLift = this.fillLayerActive ? 0.05 : 0
      const outward =
        fillLift + this.config.size * (0.15 - 0.4 * flatness)
      mesh.position.set(
        px + nx * outward,
        py + ny * outward,
        pz + nz * outward
      )
      this._outward.set(nx, ny, nz)
      this._quat.setFromUnitVectors(this._forward, this._outward)
      mesh.quaternion.copy(this._quat)
    }
  }

  private recolour() {
    const palette = this.config.colors
    const gradient = !!this.config.gradient
    const n = this.meshes.length
    const paletteColors = palette.map(
      (cid) => new THREE.Color(resolveCustomBeadHex(cid, this.adjustments))
    )
    const useGradientShader = gradient && paletteColors.length >= 2
    if (useGradientShader) {
      this.rebuildGradientTexture(paletteColors)
      this.gradientUseUniform.value = 1
    } else {
      this.gradientUseUniform.value = 0
    }
    for (let i = 0; i < n; i++) {
      const mesh = this.meshes[i]
      const mat = mesh.material as THREE.MeshPhysicalMaterial
      if (useGradientShader) {
        // Shader samples the gradient LUT; base colour set to white
        // so the sampled RGB isn't multiplied down.
        mat.color.setRGB(1, 1, 1)
      } else if (paletteColors.length === 0) {
        mat.color.setHex(0xffffff)
      } else {
        mat.color.copy(paletteColors[i % paletteColors.length])
      }
    }
  }

  private rebuildGradientTexture(colors: readonly THREE.Color[]) {
    if (this.gradientTexture) this.gradientTexture.dispose()
    const size = 64
    const data = new Uint8Array(size * 4)
    const cA = new THREE.Color()
    const cB = new THREE.Color()
    for (let i = 0; i < size; i++) {
      const t = i / (size - 1)
      const scaled = t * (colors.length - 1)
      const lo = Math.floor(scaled)
      const hi = Math.min(lo + 1, colors.length - 1)
      const frac = scaled - lo
      cA.copy(colors[lo])
      cB.copy(colors[hi])
      cA.lerp(cB, frac)
      data[i * 4] = Math.round(cA.r * 255)
      data[i * 4 + 1] = Math.round(cA.g * 255)
      data[i * 4 + 2] = Math.round(cA.b * 255)
      data[i * 4 + 3] = 255
    }
    const tex = new THREE.DataTexture(
      data,
      size,
      1,
      THREE.RGBAFormat,
      THREE.UnsignedByteType
    )
    tex.colorSpace = THREE.SRGBColorSpace
    tex.needsUpdate = true
    this.gradientTexture = tex
    this.gradientTexUniform.value = tex
  }

  /** Called by SlimeApp whenever the outer slime's compact-fill bead
   *  shell toggles active / inactive — adjusts the outward offset so
   *  custom beads clear the shell only when it exists, and sit flush
   *  against the naked slime otherwise. */
  setFillLayerActive(active: boolean) {
    this.fillLayerActive = active
  }

  dispose() {
    for (const mesh of this.meshes) {
      this.group.remove(mesh)
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
    }
    this.meshes = []
    this.meshShape = []
    this.material.dispose()
  }
}

/** Local geometry factory — mirrors BeadsLayer.buildBeadGeometry so
 *  the CustomBeadsLayer can pick the same visual for each shape. */
function buildBeadGeometry(shape: BeadShapeId): THREE.BufferGeometry {
  switch (shape) {
    case 'sphere':
      return new THREE.SphereGeometry(1, 14, 10)
    case 'cube':
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
      const geo = new THREE.CylinderGeometry(1.0, 1.0, 0.8, 24, 1)
      geo.rotateX(Math.PI / 2)
      geo.computeVertexNormals()
      return geo
    }
  }
}
