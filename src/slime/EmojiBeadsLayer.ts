import * as THREE from 'three'

/** A theme-driven layer of character emojis rendered as billboard sprites on
 *  the slime surface. Because emojis are already Unicode characters with rich
 *  vector art baked into the OS font (Apple Color Emoji, Segoe UI Emoji, Noto
 *  Color Emoji), we get instantly-recognisable cute characters — octopus,
 *  turtle, starfish, coral — with zero external assets, zero copyright issues,
 *  and zero downloads. Sprites always face the camera so silhouettes read
 *  clearly no matter how the slime is rotated or deformed.
 *
 *  Rendering strategy — TWO PASSES PER EMOJI, both depth-tested:
 *    1. MAIN pass  — opacity 1.0, depthTest ON. Reads as a normal opaque
 *       billboard: shows only where the sprite centre passes the depth
 *       test (in front of every opaque object at that pixel). This is
 *       what buries the emoji behind beads / behind an opaque slime
 *       front / behind another emoji when the geometry says so.
 *    2. GHOST pass — opacity 0.4, depthTest OFF, drawn FIRST at a lower
 *       renderOrder. Fills in wherever main is depth-culled at reduced
 *       alpha. Only enabled for CRYSTAL slime so the user sees the buried
 *       portion "faintly through the glass"; for opaque materials the
 *       ghost is off and buried emojis correctly hide entirely.
 *
 *  Positioning: base lift of size × 0.2 above the anchor vertex keeps 30%
 *  of the sprite tucked into the slime at rest. On top of that:
 *    • `beadLift` is added by SlimeApp when beads are active, boosting the
 *      emoji above the bead layer so beads don't bury it at rest.
 *    • A COMPRESSION SINK subtracts from lift proportional to how far the
 *      anchoring vertex has been pushed inward from its rest position, so
 *      pressing on an emoji physically buries it into the beads / surface.
 *      Releasing lets the vertex spring back and the emoji rises again.
 */
export interface EmojiBeadsConfig {
  /** Round-robined across every bead, in listed order. */
  emojis: string[]
  /** World-space diameter of each emoji sprite. */
  size: number
  /** Number of sprites to place. Capped by the mesh vertex count. */
  count: number
}

const TEX_SIZE = 256
const FONT_STACK =
  '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif'

/** How faint the ghost pass renders — a fraction of full opacity. Chosen
 *  so a buried emoji reads as "there but recessed" rather than jumping out
 *  as a floating overlay. */
const GHOST_OPACITY = 0.4
const GHOST_RENDER_ORDER = 0
const MAIN_RENDER_ORDER = 100

/** How aggressively vertex compression sinks the emoji. Multiplier applied
 *  to (restMagnitude − currentMagnitude, minus a small dead zone). Kept
 *  low so a light tap barely nudges the emoji and only a sustained press
 *  drags it into the bead layer — earlier tuning at 3.0 buried emojis on
 *  a single tap, which the user flagged as too fast. */
const COMPRESSION_SINK_GAIN = 0.22
/** Compression below this level doesn't sink the emoji at all. Filters
 *  out physics jitter and light contact so idle tracking noise can't drag
 *  the emoji down. */
const COMPRESSION_DEAD_ZONE = 0.06

function makeEmojiTexture(emoji: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = TEX_SIZE
  canvas.height = TEX_SIZE
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.clearRect(0, 0, TEX_SIZE, TEX_SIZE)
    // Font size 80% of canvas: leaves a small transparent margin so the
    // emoji doesn't touch the sprite edge (which would produce faint alpha
    // fringing when magnified).
    ctx.font = `${Math.round(TEX_SIZE * 0.82)}px ${FONT_STACK}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    // Nudge down a hair — most emoji glyphs have a heavier top than bottom
    // in their bounding box, so centre-baseline sits them a touch high.
    ctx.fillText(emoji, TEX_SIZE / 2, TEX_SIZE / 2 + TEX_SIZE * 0.02)
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  return tex
}

/** Cache key: main + ghost materials share ONE texture per emoji, but the
 *  material params differ (opacity, depthTest), so we cache both variants
 *  side-by-side and dispose the texture once. */
interface EmojiMatPair {
  texture: THREE.CanvasTexture
  main: THREE.SpriteMaterial
  ghost: THREE.SpriteMaterial
}

export class EmojiBeadsLayer {
  readonly group: THREE.Group
  private sprites: THREE.Sprite[] = []
  private ghostSprites: THREE.Sprite[] = []
  private vertexIndices: number[] = []
  private materials = new Map<string, EmojiMatPair>()
  private config: EmojiBeadsConfig = { emojis: [], size: 0.15, count: 0 }
  /** Index of the currently-picked emoji (or -1). Kept as internal
   *  state for the drag-anchor lookup even though the previous
   *  blue-glow halo has been removed. */
  private _selectedIndex = -1
  get selectedIndex(): number {
    return this._selectedIndex
  }
  /** Ghost pass visibility — see class-level comment for what this does. */
  private ghostVisible = false
  /** Extra outward lift beyond the base size × 0.2, in world units. Set by
   *  SlimeApp to keep emojis above the bead layer at rest when beads are
   *  active. Zero when there are no beads. */
  private beadLift = 0
  /** Per-emoji smoothed lift value — target lift is recomputed each frame
   *  from the physics (baseLift minus press compression) but the sprite
   *  eases toward it instead of snapping. Makes the "mixing into the
   *  slime" motion feel slow / molasses-like rather than tracking the
   *  finger 1:1. Reallocated whenever the sprite count changes. */
  private smoothedLifts: Float32Array | null = null
  /** Per-emoji "spawn anchor blend" — 1.0 = anchor emoji to REST
   *  vertex position (so a fresh sprite lands on the original
   *  silhouette even if the underlying vertex is currently dented
   *  inward), 0.0 = anchor to the current deformed vertex (normal
   *  press-follows-slime behaviour). Freshly spawned sprites start
   *  at 1.0 and decay to 0.0 over ~300 ms so the emoji doesn't
   *  visually drift after landing. */
  private spawnRestBlend: Float32Array = new Float32Array(0)

  constructor() {
    this.group = new THREE.Group()
  }

  get currentConfig(): Readonly<EmojiBeadsConfig> {
    return this.config
  }

  private getMaterialPair(emoji: string): EmojiMatPair {
    const cached = this.materials.get(emoji)
    if (cached) return cached
    const tex = makeEmojiTexture(emoji)
    // Main pass — full opacity, always depth-tested. Depth handles all the
    // "when is the emoji buried" cases automatically: on the back, in front
    // of the bead layer, when the anchor vertex is pressed down into the
    // slime bulk, etc. No mode switching required.
    const main = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      alphaTest: 0.02,
      depthWrite: false,
      depthTest: true
    })
    // Ghost pass — same texture, depthTest OFF, reduced opacity. Toggled
    // on for crystal slime so the buried portion still reads faintly
    // through the transparent slime body.
    const ghost = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      alphaTest: 0.02,
      depthWrite: false,
      depthTest: false,
      opacity: GHOST_OPACITY
    })
    const pair: EmojiMatPair = { texture: tex, main, ghost }
    this.materials.set(emoji, pair)
    return pair
  }

  /** Toggle the dim ghost pass. Should be true only for CRYSTAL slime —
   *  opaque slimes shouldn't leak back-of-sphere emoji silhouettes through
   *  the front. Cheap: only flips sprite.visible on the existing pool. */
  setGhostVisible(visible: boolean) {
    if (this.ghostVisible === visible) return
    this.ghostVisible = visible
    for (const g of this.ghostSprites) g.visible = visible
  }

  /** Extra outward lift applied to every emoji, in world units. SlimeApp
   *  sets this to roughly (beads.size + margin) when beads are active so
   *  emojis clear the bead layer at rest, and back to 0 when no beads. */
  setBeadLift(h: number) {
    this.beadLift = h
  }

  setConfig(config: EmojiBeadsConfig, unitDirs: Float32Array) {
    // Snapshot the previous per-sprite state BEFORE clearing so we can
    // preserve moved emojis across a rebuild (e.g. adding a new emoji
    // used to snap every existing sprite back to its default front-
    // hemisphere anchor, losing the user's drags).
    const prevIndices = this.vertexIndices.slice()

    this.config = { ...config, emojis: [...config.emojis] }

    for (const sprite of this.sprites) this.group.remove(sprite)
    for (const ghost of this.ghostSprites) this.group.remove(ghost)
    this.sprites = []
    this.ghostSprites = []

    if (config.emojis.length === 0 || config.count <= 0) {
      this.vertexIndices = []
      return
    }

    // `count` is INSTANCES-PER-EMOJI: at count = 1 each selected emoji
    // appears exactly once, at count = 3 each appears three times, etc.
    const perEmoji = Math.max(1, Math.floor(config.count))
    const totalRequested = perEmoji * config.emojis.length

    // Tight cluster around the +Z pole: filter to the front hemisphere for
    // safety, then SORT by descending z so the vertices closest to the
    // dead-centre of the front face come first. Taking the first N picks
    // the N most-central vertices in the mesh — the result is a compact
    // clump of figurines right where the user is looking.
    const totalVerts = unitDirs.length / 3
    const FRONT_Z_THRESHOLD = 0.4
    const frontIndices: number[] = []
    for (let i = 0; i < totalVerts; i++) {
      if (unitDirs[i * 3 + 2] > FRONT_Z_THRESHOLD) frontIndices.push(i)
    }
    frontIndices.sort(
      (a, b) => unitDirs[b * 3 + 2] - unitDirs[a * 3 + 2]
    )
    const effectiveCount = Math.min(totalRequested, frontIndices.length, 200)
    // Preserve previous per-sprite vertex assignments where possible so a
    // config change (adding an emoji, bumping count) doesn't reset the
    // positions the user manually dragged. Sprites that existed before
    // keep their old vertex; only freshly-added slots (i >= prev length)
    // pull a fresh default anchor from the front-facing pool. The pool
    // skips already-used vertices so a new sprite doesn't spawn on top
    // of a preserved one, AND enforces a minimum angular gap between
    // fresh anchors sized to the current sprite diameter so large
    // emojis don't visually overlap each other. Preserved sprites act
    // as immovable obstacles for the spacing check (a user drag is more
    // important than automatic spacing).
    const usedVerts = new Set<number>()
    this.vertexIndices = []
    // Minimum chord distance we want between anchor unit-dirs, sized to
    // the sprite diameter with a small overlap tolerance so adjacent
    // emojis nearly touch instead of leaving a visible gap. Converted
    // to a maxDot threshold (unit vectors → chord² = 2 − 2·dot) so the
    // per-candidate check is a single dot product. Clamped to −1 for
    // sprite sizes so large the constraint is un-satisfiable, in which
    // case every front-facing vertex passes and the fallback ordering
    // (descending z from the sort above) still yields a sensible layout.
    const targetChord = config.size * 0.9
    const maxDot = Math.max(-1, 1 - (targetChord * targetChord) / 2)
    const placedDirs: number[] = []
    const pushPlacedDir = (idx: number) => {
      placedDirs.push(
        unitDirs[idx * 3],
        unitDirs[idx * 3 + 1],
        unitDirs[idx * 3 + 2]
      )
    }
    // Reset the spawn-blend factors to the new size. Existing sprites
    // (preserved vertex indices) leave blend = 0 (anchor to current);
    // freshly-added slots start at 1.0 (anchor to rest silhouette so
    // the sprite lands above any current dent instead of inside it).
    const nextPending = new Float32Array(effectiveCount)
    for (let i = 0; i < effectiveCount; i++) {
      const prev = i < prevIndices.length ? prevIndices[i] : -1
      if (prev >= 0) {
        this.vertexIndices.push(prev)
        usedVerts.add(prev)
        pushPlacedDir(prev)
      } else {
        // Prefer the next unused front-facing vertex whose direction is
        // far enough from every already-placed anchor to avoid overlap.
        let picked = -1
        for (const cand of frontIndices) {
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
        // Fallback — no candidate satisfies the spacing (usually because
        // the requested count × size exceeds the front-cap area); take
        // the next unused front vertex so we still honour the count.
        if (picked < 0) {
          for (const cand of frontIndices) {
            if (!usedVerts.has(cand)) {
              picked = cand
              break
            }
          }
        }
        // Final fallback: pool fully consumed, wrap around.
        if (picked < 0) picked = frontIndices[i % frontIndices.length]
        this.vertexIndices.push(picked)
        usedVerts.add(picked)
        pushPlacedDir(picked)
        nextPending[i] = 1
      }
    }
    this.spawnRestBlend = nextPending

    for (let i = 0; i < effectiveCount; i++) {
      // Cycle emoji index per sprite so consecutive placements alternate
      // between emojis, preventing all copies of the same emoji from
      // clumping together.
      const emoji = config.emojis[i % config.emojis.length]
      const pair = this.getMaterialPair(emoji)

      // Main sprite: opaque, drawn LAST so it stacks above the ghost.
      const main = new THREE.Sprite(pair.main)
      main.scale.set(config.size, config.size, 1)
      main.renderOrder = MAIN_RENDER_ORDER
      this.sprites.push(main)
      this.group.add(main)

      // Ghost sprite: hidden by default; only shown for crystal slime.
      const ghost = new THREE.Sprite(pair.ghost)
      ghost.scale.set(config.size, config.size, 1)
      ghost.renderOrder = GHOST_RENDER_ORDER
      ghost.visible = this.ghostVisible
      this.ghostSprites.push(ghost)
      this.group.add(ghost)
    }

    // Rebuilding the pool invalidates the previous selection; drop it so
    // an old glow doesn't linger over a sprite that no longer exists.
    this.setSelected(null)
  }

  reseat(unitDirs: Float32Array) {
    if (this.config.count === 0 || this.config.emojis.length === 0) return
    this.setConfig(this.config, unitDirs)
  }

  /** Main sprite pool exposed so callers (SlimeApp) can raycast against
   *  them to pick which one the user tapped for drag-to-reposition. The
   *  ghost pass is intentionally NOT raycastable — its dim, always-on
   *  render is a background trick, not an interactive target. */
  getSprites(): readonly THREE.Sprite[] {
    return this.sprites
  }

  /** Mark a sprite as SELECTED (or `null` to clear). The previous
   *  blue-glow halo has been removed — the selection is now silent
   *  visually (the picked emoji simply follows drag input) so the
   *  slime background stays clean when emoji-move mode is active. */
  setSelected(index: number | null) {
    this._selectedIndex =
      index === null || index < 0 || index >= this.sprites.length
        ? -1
        : index
  }

  /** Re-anchor a placed sprite onto a different mesh vertex. Called mid-
   *  drag to move an emoji to wherever the user is dragging on the slime
   *  surface. The vertexIndex should be the mesh vertex closest to the
   *  desired new position (see `findClosestVertex`). */
  moveSprite(spriteIndex: number, vertexIndex: number) {
    if (spriteIndex < 0 || spriteIndex >= this.vertexIndices.length) return
    this.vertexIndices[spriteIndex] = vertexIndex
  }

  /** Find the mesh vertex whose unit direction most closely matches
   *  the given point's direction from origin. Point is expected in the
   *  slime mesh's LOCAL space (i.e. the raycast hit converted via
   *  slime.mesh.worldToLocal). */
  findClosestVertex(
    localX: number,
    localY: number,
    localZ: number,
    unitDirs: Float32Array
  ): number {
    const len = Math.hypot(localX, localY, localZ) || 1
    const dx = localX / len
    const dy = localY / len
    const dz = localZ / len
    let bestI = 0
    let bestDot = -Infinity
    const n = unitDirs.length / 3
    for (let i = 0; i < n; i++) {
      const nx = unitDirs[i * 3]
      const ny = unitDirs[i * 3 + 1]
      const nz = unitDirs[i * 3 + 2]
      const dot = dx * nx + dy * ny + dz * nz
      if (dot > bestDot) {
        bestDot = dot
        bestI = i
      }
    }
    return bestI
  }

  /** Position every emoji sprite each frame. `restPositions` is optional;
   *  when supplied, per-vertex compression (rest length minus current
   *  length) subtracts from the emoji's outward lift so pressing on the
   *  emoji physically sinks it into the surface / bead layer. Without
   *  restPositions the compression sink is skipped. */
  update(currentPositions: Float32Array, restPositions?: Float32Array) {
    const n = this.sprites.length
    if (n === 0) return
    // Base lift — 30% of the sprite hidden below the slime surface at
    // rest for a "sitting in the slime" look. beadLift is added on top
    // by SlimeApp when beads are active so the emoji clears the bead
    // layer instead of getting buried by it before any interaction.
    const baseLift = this.config.size * 0.2 + this.beadLift
    // Minimum lift — even under heavy press the emoji doesn't sink so
    // far below the surface that its selection halo becomes unclickable.
    // Roughly one radius below the surface is plenty for the "buried"
    // read without losing the sprite entirely.
    const MIN_LIFT = -this.config.size * 0.22
    // Asymmetric ease — sinking into the slime is deliberately molasses
    // slow (SINK_EASE) so an emoji doesn't jump downward as soon as a
    // finger touches, but rising back is much snappier (RISE_EASE) so
    // the emoji visibly REAPPEARS on release / when pressure eases off.
    // The behaviour therefore depends on HOW the user presses: press &
    // hold → gradual burial; brief press + release → sprite pops back
    // up almost immediately.
    const SINK_EASE = 0.001
    const RISE_EASE = 0.08
    if (
      this.smoothedLifts === null ||
      this.smoothedLifts.length !== n
    ) {
      // First run (or count changed) — seed each smoothed lift at the
      // current base lift so no visible jump on init / config change.
      this.smoothedLifts = new Float32Array(n).fill(baseLift)
    }
    // Spawn-blend decay per frame. The slime retains most of a dent
    // after release (RELEASE_RESTORE = 0.1 in SlimeSphere) so we can't
    // gate decay on vertex-near-rest — the blend would never expire.
    // Time-based decay (~500 ms total) lets a freshly-spawned emoji
    // ease from its rest-silhouette landing spot down to the anchor
    // vertex position, so subsequent presses can drag the emoji into
    // the slime like every other sprite.
    const SPAWN_DECAY = 0.03
    for (let i = 0; i < n; i++) {
      const vi = this.vertexIndices[i]
      const x = currentPositions[vi * 3]
      const y = currentPositions[vi * 3 + 1]
      const z = currentPositions[vi * 3 + 2]
      const len = Math.hypot(x, y, z) || 1
      // Compression: how much the anchor vertex has been pushed inward
      // from its rest position. Subtracts from the lift so pressing
      // BURIES the emoji into whatever's around it (beads or the surface
      // itself). Depth test on the main sprite then handles the visual
      // burial — beads / opaque slime in front hide the sunk emoji.
      let targetLift = baseLift
      let restLen = len
      if (restPositions) {
        const rx = restPositions[vi * 3]
        const ry = restPositions[vi * 3 + 1]
        const rz = restPositions[vi * 3 + 2]
        restLen = Math.hypot(rx, ry, rz)
        // Dead-zone the compression before scaling so tiny physics
        // wobbles don't move the emoji at all. Only when the vertex
        // is meaningfully pressed inward does the sprite start sinking.
        const effective = Math.max(
          0,
          restLen - len - COMPRESSION_DEAD_ZONE
        )
        targetLift = Math.max(
          MIN_LIFT,
          baseLift - effective * COMPRESSION_SINK_GAIN
        )
      }
      const prev = this.smoothedLifts[i]
      const ease = targetLift < prev ? SINK_EASE : RISE_EASE
      const smoothed = prev + (targetLift - prev) * ease
      this.smoothedLifts[i] = smoothed
      // Blend the anchor length between rest (spawn-pinned) and
      // current (physics-tracking). Fresh sprites start with
      // spawnRestBlend = 1 so they land on top of any current dent,
      // then decay unconditionally each frame so existing emojis
      // eventually track the anchor vertex normally (and can be
      // pressed into the slime with the rest of the surface).
      const blend = this.spawnRestBlend[i] ?? 0
      if (blend > 0) {
        this.spawnRestBlend[i] = Math.max(0, blend - SPAWN_DECAY)
      }
      const anchorLen = len + (restLen - len) * blend
      const s = (anchorLen + smoothed) / len
      const px = x * s
      const py = y * s
      const pz = z * s
      this.sprites[i].position.set(px, py, pz)
      this.ghostSprites[i]?.position.set(px, py, pz)
    }
  }

  dispose() {
    for (const sprite of this.sprites) this.group.remove(sprite)
    for (const ghost of this.ghostSprites) this.group.remove(ghost)
    this.sprites = []
    this.ghostSprites = []
    for (const pair of this.materials.values()) {
      pair.texture.dispose()
      pair.main.dispose()
      pair.ghost.dispose()
    }
    this.materials.clear()
    this.vertexIndices = []
    this._selectedIndex = -1
  }
}
