import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import {
  BEAD_MATERIAL_PARAMS,
  resolveColorHex,
  type BeadShapeId,
  type ColorAdjustments,
  type CustomBeadsConfig
} from './presets'

const MAX_CUSTOM_BEADS = 20

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

  constructor() {
    this.group = new THREE.Group()
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
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uCbPhotoUse = useU
      shader.uniforms.uCbPhotoMap = mapU
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
         varying vec3 vCbLocal;
        ` +
        shader.fragmentShader.replace(
          '#include <map_fragment>',
          `#include <map_fragment>
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
   *  by SlimeApp on shape change and after setConfig. */
  reseat(unitDirs: Float32Array) {
    const n = this.meshes.length
    if (this.anchorIdx.length !== n) {
      this.anchorIdx = new Uint32Array(n)
    }
    if (this.anchorDirs.length !== n * 3) {
      // Even Fibonacci sample of the FRONT hemisphere so N beads are
      // spread evenly across the visible face. Same fibonacci trick
      // BeadsLayer chunk uses, but constrained to y = 1 - t (t in
      // [0, 0.5]) so all directions have z > 0.
      const dirs = new Float32Array(n * 3)
      const phi = Math.PI * (Math.sqrt(5) - 1)
      for (let i = 0; i < n; i++) {
        const t = n > 1 ? (i + 0.5) / n : 0.5
        const y = 1 - t
        const r = Math.sqrt(Math.max(0, 1 - y * y))
        const theta = phi * i
        dirs[i * 3] = Math.cos(theta) * r
        dirs[i * 3 + 1] = Math.sin(theta) * r * 0.6
        dirs[i * 3 + 2] = Math.abs(y)
      }
      this.anchorDirs = dirs
    }
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
      const outward = this.config.size * (0.4 - 0.5 * flatness)
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
    for (let i = 0; i < this.meshes.length; i++) {
      const mesh = this.meshes[i]
      const mat = mesh.material as THREE.MeshPhysicalMaterial
      if (palette.length === 0) {
        mat.color.setHex(0xffffff)
      } else {
        const cid = palette[i % palette.length]
        mat.color.setHex(resolveColorHex(cid, this.adjustments))
      }
    }
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
