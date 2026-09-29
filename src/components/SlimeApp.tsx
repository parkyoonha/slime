import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { useHandLandmarker } from '../hooks/useHandLandmarker'
import { SlimeSphere, type WeightedTip } from '../slime/SlimeSphere'
import { BeadsLayer } from '../slime/BeadsLayer'
import { CustomBeadsLayer } from '../slime/CustomBeadsLayer'
import { EmojiBeadsLayer } from '../slime/EmojiBeadsLayer'
import { SprinklesLayer } from '../slime/SprinklesLayer'
import {
  BEAD_MATERIALS,
  BEAD_SHAPES,
  BEADS_DEFAULT,
  COATINGS,
  CUSTOM_BEADS_DEFAULT,
  EMOJI_BEADS_DEFAULT,
  MATERIALS,
  SHAPES,
  SLIME_TEXT_DEFAULT,
  resolveColorHex,
  resolveInnerCoatingHex,
  resolveFoilCoatingHex,
  resolveWaxCoatingHex,
  type ColorAdjustments,
  SPRINKLE_COLORS,
  SPRINKLES_DEFAULT,
  SPRINKLES_LIMITS,
  type BeadsConfig,
  type CoatingColorId,
  type CoatingId,
  type ColorId,
  type CustomBeadsConfig,
  type EmojiBeadsConfig,
  type MaterialId,
  type ShapeId,
  type SlimeText,
  type SprinklesConfig
} from '../slime/presets'
import {
  FINGERS,
  HAND_CONNECTIONS,
  type Landmark,
  extensionToWeight,
  fingerCurl
} from '../lib/coords'
import { SoundEngine } from '../sound/SoundEngine'
import CustomizePanel, { type SelectionTag } from './CustomizePanel'
import { AccountDrawerTop, AccountDrawerFooter } from './AccountDrawerSection'
import styles from './SlimeApp.module.css'

const CAMERA_Z = 3.4
const SCALE_MIN = 0.4
const SCALE_MAX = 2.4
/** Perspective FOV used by the scene camera (kept in sync with the
 *  PerspectiveCamera constructor below). Exported at module scope so the
 *  initial-scale helper can compute the viewport's world width without
 *  duplicating the constant. */
const CAMERA_FOV = 45

/** Compute a default sphere scale that fills most of the viewport on
 *  whichever dimension is TIGHTER. Targets ~1.15× the narrower dimension
 *  so the diameter fills the full width on portrait phones (and stays
 *  generous on desktop up to the cap) — the customize panel also
 *  auto-shrinks the sphere by ~10% when expanded, so a comfortably
 *  large base scale keeps the sphere feeling substantial even with the
 *  panel open. Falls back to a safe 1.15 when window isn't available
 *  (SSR / edge cases). */
/** Convert a numeric colour (0xRRGGBB) to an `#rrggbb` CSS string.
 *  Small helper used by the unified tag row's colour swatch chips. */
function hexToCssColor(hex: number): string {
  return `#${hex.toString(16).padStart(6, '0')}`
}

function computeInitialScale(): number {
  if (typeof window === 'undefined') return 1.15
  const aspect = window.innerWidth / (window.innerHeight || 1)
  const worldHeight = 2 * CAMERA_Z * Math.tan((CAMERA_FOV * Math.PI) / 360)
  const worldWidth = worldHeight * aspect
  const narrower = Math.min(worldWidth, worldHeight)
  // Match the horizontal margins of the bottom options card so the
  // slime at rest occupies the same visible width as the panel below
  // it. `.controlsInner` has 18 px inner padding on each side, so the
  // slime's on-screen diameter should equal (viewportWidth − 36 px).
  const insetPx = 36
  const viewportPx = window.innerWidth || 1
  const widthFraction = Math.max(0.4, 1 - insetPx / viewportPx)
  const scale = (narrower * widthFraction) / 2
  return Math.min(1.4, Math.max(SCALE_MIN, scale))
}

// Slime base "squish" is now a single Slime.mp3 recording (random
// windows scheduled from it per press, same as the old 8-clip pool).
// Slimetapping.mp3 plays in parallel via the `slimeTap` named
// channel — see render loop.
// Slime-squish sample files. Files that exist under public/sounds/ are used
// verbatim; missing ones are silently skipped. Add more clips for variety —
// the sample scheduler picks one at random per squelch tick.
const SQUISH_SAMPLE_URLS = ['/sounds/Slime.mp3']

// Coating- / beads-specific one-shot sample files. Loaded once on mount and
// triggered from the render loop when the corresponding coating is active
// and the slime is being pressed hard enough.
const NAMED_SAMPLE_URLS = {
  // Single wax file with an attack region baked into the first ~5 s
  // and the sustain region between [5, 13] set as the buffer loop
  // points. First press after a reset starts from t=0 (attack plays,
  // then loop kicks in); subsequent presses start straight from
  // loopStart so the sustain plays without re-attacking.
  wax: '/sounds/Wakcom.mp3',
  // Extra layer that plays IN PARALLEL with the wax coating loop —
  // Thinwax.mp3 stacked over Wakcom so the thick-wax crack carries
  // the thin-crackle texture underneath. Uses its own channel so
  // the actual 씬왁스 coating (which also loads Thinwax.mp3 on the
  // `thinwax` channel) stays independent.
  waxLayer: '/sounds/Thinwax.mp3',
  // 씬왁스 — full-file loop of Thinwax.mp3. Independent from the ice
  // channel so the thin-wax and glaze/ice coatings can carry
  // distinct sound identities.
  thinwax: '/sounds/Thinwax0.mp3',
  // 박지 (foil) coating and 퍼티 (metal material) originally pointed at
  // Hoil.mp3 and Popp.mp3 respectively; swapped so foil cracks now use
  // the pop sample and the putty material kneading uses the wet foil
  // sample — matches the user's chosen sound identity for each channel.
  foil: '/sounds/Bak.mp3',
  // 글레이즈 (ice) 코팅 — sharp crack.
  ice: '/sounds/Crack.mp3',
  // 젤(tube) coating crack — wet-jelly squelch.
  tube: '/sounds/Jelly.mp3',
  // 꽉비즈 (compact) + 비즈볼 (chunk) share the `beads` channel.
  beads: '/sounds/Bead0.mp3',
  // 스팽글 종이 옵션 — crunchier crinkle.
  paper: '/sounds/Crunchier.mp3',
  // 스팽글 플라스틱 옵션 — sharper star-like tick.
  plastic: '/sounds/Sharpstar.mp3',
  // Parallel layer stacked on top of plastic — Crunchier.mp3 gives
  // the plastic tick a softer crinkle underneath. Own channel so
  // gain / attenuation can be tuned independently from `paper`
  // (which also loads Crunchier.mp3).
  plasticLayer: '/sounds/Crunchier.mp3',
  // 슬라임 / 슬라임볼 폼(matte) 재질 앰비언트.
  matte: '/sounds/Papers.mp3',
  // 슬라임 / 슬라임볼 퍼티(metal) 재질 앰비언트.
  metal: '/sounds/Glaze.mp3',
  // 소프트 재질 ambient.
  soft: '/sounds/Softslime.mp3',
  // 아이스 재질 (재질 vs 코팅 구분: 코팅은 Iced.mp3의 'ice' 채널).
  iceMat: '/sounds/Smoothie.mp3',
  // Ambient loop that fires when the user presses a slime that has
  // emojis on it.
  emoji: '/sounds/Imoji.mp3',
  // 추가비즈 loop — shares Imoji.mp3 with the emoji channel so both
  // additive-bead surfaces carry the same acoustic signature; kept
  // as its own channel so gain / attenuation can be tuned
  // independently.
  customBeads: '/sounds/Imoji.mp3',
  // Slime.mp3의 squish와 병렬로 재생되는 tapping 레이어. 압력 따라
  // gain이 움직이며, squish가 무음 처리되는 조건(iceMat/matte/metal/
  // soft 재질, ice 코팅)에서 함께 무음.
  slimeTap: '/sounds/Slimetapping.mp3'
} as const

// Optional [startSec, endSec] source-range constraints for each named
// sample. Only random windows within these bounds are played, so a single
// mp3 containing several distinct sounds can be pointed at the desired
// segment. Set to `null` to allow the full recording. Adjust the wax
// range to pick the exact section of Wak.mp3 you want as the crack sound.
const NAMED_SAMPLE_RANGES: Record<
  'wax' | 'waxLayer' | 'thinwax' | 'foil' | 'ice' | 'tube' | 'beads' | 'paper' | 'plastic' | 'plasticLayer' | 'matte' | 'metal' | 'soft' | 'iceMat' | 'emoji' | 'customBeads' | 'slimeTap',
  readonly [number, number] | null
> = {
  // Wakcom.mp3 with only [6, 8] spliced out at load time. Post-
  // splice coords for the loop (original loop [9, 13]):
  //   • original 9 → post-splice 7 (9 − 2)
  //   • original 13 → post-splice 11 (13 − 2)
  // `waxStartOffset = 2.4` (pre-splice, unchanged since 2.4 < 6)
  // starts the attack; playback flows through the excised gap and
  // settles into the [7, 11] loop for both manual and auto press.
  wax: [7, 11],
  // Thinwax.mp3 loops between t=2.5 s and t=7 s. Range acts as
  // loopStart/loopEnd so playback naturally starts at 2.5 s and
  // repeats [2.5, 7] for as long as press pressure holds — same
  // behaviour whether the user is pressing manually or the
  // auto-press session is running.
  thinwax: [2.5, 7],
  // waxLayer reuses the same Thinwax loop region so the parallel
  // layer under a wax-coating press has the same rhythm as the
  // primary thinwax channel.
  waxLayer: [2.5, 7],
  // Popp.mp3 (now on the foil channel) needs no leading trim.
  foil: null,
  // Glaze.mp3 — whole file loops with no trim.
  ice: null,
  tube: null,
  beads: null,
  paper: null,
  plastic: null,
  plasticLayer: null,
  matte: null,
  // Purty.mp3 is a clean recording that starts audible at t=0 —
  // no trim needed, loops the whole file.
  metal: null,
  soft: null,
  iceMat: null,
  emoji: null,
  customBeads: null,
  slimeTap: null
}

/** Down-scale applied to a layer group when its owning config's `inside`
 *  flag is on. Per-layer values because each layer's outward extent
 *  differs — flat paper spangles sit deep at 0.72, but volumetric beads
 *  and thick plastic spangles need a smaller factor so their outer edge
 *  doesn't poke back up to the slime surface. Compact beads carry a
 *  separate `compactWrap` so the wrap-shell hangs near the slime skin
 *  while the bead cores drop deeper for a clearly-embedded look. */
const INSIDE_SCALE = {
  // Spangles + beads sit DEEP inside the slime so press-time
  // bulging never pushes them through the slime surface — the
  // slime silhouette itself is what the user should see, with
  // the inclusion only hinted at through the (semi-)transparent
  // body.
  spangleFlat: 0.55,
  spanglePlastic: 0.45,
  compact: 0.55,
  compactWrap: 0.58,
  // Emoji + custom beads sit near the slime edge but DEFINITELY inside
  // the surface — the previous 0.90 / 0.92 pair scaled the bead's centre
  // to just below the surface but the bead's own outward extent (radius
  // for custom beads, sprite half-height + baseLift for emojis) still
  // poked back through, so they read as sitting ON the skin instead of
  // BENEATH it. 0.82 keeps them close enough to the edge to be clearly
  // visible through / at the silhouette while ensuring their outermost
  // face lands under the surface at typical sizes.
  customBeads: 0.82,
  emoji: 0.82
} as const

export default function SlimeApp() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  // Height of the bottom controls block (panel + toggle row) in CSS pixels.
  // Written by a ResizeObserver on the .controls div and read every frame
  // in the render loop so opening a category can gently shift the slime
  // up + shrink it to keep the sphere from being covered by the panel.
  const controlsRef = useRef<HTMLDivElement>(null)
  const controlsHeightRef = useRef(0)
  const [cameraStatus, setCameraStatus] = useState<
    'idle' | 'requesting' | 'ready' | 'error'
  >('idle')
  const [cameraError, setCameraError] = useState<string | null>(null)
  // Hand tracking toggle — now gates the entire camera + MediaPipe
  // pipeline, not just the skeleton overlay. When OFF: no camera stream,
  // no `detect()` calls, no overlay. Touch/pointer input still works
  // (that's the low-power interaction path). Persisted across sessions
  // so a user who prefers touch-only doesn't have to re-toggle each
  // launch. Default FALSE — first-launch users see the app run purely
  // on touch (no camera prompt, no MediaPipe model fetch), avoiding the
  // "grant camera → model fetch fails → app closes" crash path on the
  // very first APK open. Hand tracking has to be explicitly opted into
  // from the panel.
  const [skeletonOn, setSkeletonOn] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    const saved = window.localStorage.getItem('wakbu-hand-tracking')
    return saved === null ? false : saved === 'true'
  })
  // Gate the model fetch on the toggle so the WASM + landmarker download
  // (~8 MB cold) only happens once the user actually turns hand tracking
  // on — first-launch users with tracking off get a plain touch-only app
  // with zero network activity for the hand pipeline.
  const { status: handStatus, error: handError, detect } = useHandLandmarker(skeletonOn)
  const skeletonOnRef = useRef(skeletonOn)
  useEffect(() => {
    skeletonOnRef.current = skeletonOn
    try {
      window.localStorage.setItem('wakbu-hand-tracking', String(skeletonOn))
    } catch {
      // Private-mode storage error — toggle still works for the session.
    }
  }, [skeletonOn])
  // Pending flag for the hand-detect confirmation dialog. Set when the
  // user requests to turn hand-detect ON from OFF; a confirmation
  // modal then explains the battery / heat cost and lets them commit
  // or cancel.
  const [handDetectPending, setHandDetectPending] = useState(false)

  // Scale state lives entirely in a ref — no UI reads it, and pinch / wheel
  // handlers write directly without triggering React re-renders. The
  // initial value is computed once against the viewport aspect so a phone
  // in portrait (narrow width) starts with the sphere well inside the
  // frame instead of touching both edges, while a desktop-wide viewport
  // keeps a natural ~1.0 scale.
  const sizeRef = useRef(computeInitialScale())

  // Customization state. Defaults form the entry look: white + crystal +
  // no coating, no beads, no sprinkles, no emojis — a clear glassy slime
  // that the user starts from and can build on. Restored by the 디폴트 button.
  // Slime colour is a MULTI-SELECT — picking one paints solid, picking two
  // or more paints a vertical gradient (colors[0] → colors[n-1] top-to-
  // bottom). Empty is treated as the default 'white' by the slime.
  // Empty default — no colour is pre-selected so first-run users
  // see a plain (near-white via SlimeSphere's null-colour fallback)
  // slime and pick their own colour on entry. 진주 pre-select felt
  // like a fake commitment they hadn't made yet.
  const [colors, setColors] = useState<ColorId[]>([])
  // Per-colour HSL deltas the user has dialled in via the adjustment
  // sliders under each colour chip. Keyed on preset id so an adjusted
  // 아쿠아 stays adjusted whether the user's editing slime or beads.
  // Persisted so tweaks survive across sessions.
  const [colorAdjustments, setColorAdjustments] = useState<ColorAdjustments>(
    () => {
      if (typeof window === 'undefined') return {}
      try {
        const raw = window.localStorage.getItem('wakbu-color-adjustments')
        const parsed = raw ? JSON.parse(raw) : {}
        return parsed && typeof parsed === 'object'
          ? (parsed as ColorAdjustments)
          : {}
      } catch {
        return {}
      }
    }
  )
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(
        'wakbu-color-adjustments',
        JSON.stringify(colorAdjustments)
      )
    } catch {
      // localStorage may be unavailable in private mode — just skip.
    }
  }, [colorAdjustments])
  const [material, setMaterial] = useState<MaterialId>('crystal')
  const [coating, setCoating] = useState<CoatingId>('none')
  // 크런치 — small hidden "grain" bumps that pop out on the slime surface
  // where the user is pressing. Pure shader vertex displacement; no
  // physics or bead layer, just a Fibonacci-hashed outward bump amplified
  // by local compression amount.
  const [crunchOn, setCrunchOn] = useState<boolean>(false)
  // Wax coating tint — multi-select array so 2+ colours paint a top-to-
  // bottom gradient across the coating (single-pick keeps the flat tint).
  // Draws from the general COLORS palette because wax is an ordinary
  // pigmented surface. Default is 'white' so the wax coating reads as a
  // translucent white shell out of the box (special alpha for white only).
  const [coatingColors, setCoatingColors] = useState<ColorId[]>(['white'])
  // Foil surface colour — same multi-select story but sourced from a
  // narrower COATING_COLORS palette of saturated metallic hues. Kept
  // separate from `coatingColors` so switching between wax and foil
  // preserves each palette's last pick independently.
  const [foilColors, setFoilColors] = useState<CoatingColorId[]>(['silver'])
  const [shape, setShape] = useState<ShapeId>('sphere')
  const [beads, setBeads] = useState<BeadsConfig>(BEADS_DEFAULT)
  // 속슬라임 — a second BeadsConfig that renders as an inner squishy
  // inclusion inside the slime. Same option surface as 속비즈 (chunk)
  // — colours / count / size / shape / material / coating — but its
  // dedicated BeadsLayer instance runs a soft compress-on-press pass
  // so it visibly squishes with slime deformation.
  const [innerSlime, setInnerSlime] = useState<BeadsConfig>(BEADS_DEFAULT)
  // 커스텀비즈 — emoji-style additive layer of coloured 3D bead meshes.
  // Placed and moved like emojis; palette + shape live here so the
  // config persists independently of the main beads config.
  const [customBeads, setCustomBeads] =
    useState<CustomBeadsConfig>(CUSTOM_BEADS_DEFAULT)
  // Single shared photo texture printed onto every custom bead's
  // outward face. Null = no photo (normal coloured beads).
  const [customBeadsPhoto, setCustomBeadsPhoto] =
    useState<THREE.Texture | null>(null)
  const [sprinkles, setSprinkles] =
    useState<SprinklesConfig>(SPRINKLES_DEFAULT)
  // Emoji beads — an additive sprinkle-style layer of emoji characters.
  // Themes are just palettes of emojis: the user selects a theme in the
  // panel to open its emoji palette, picks which specific emojis to add,
  // and adjusts size / count independently. The rest of the slime
  // (color / material / coating / beads / sprinkles) is left alone.
  const [emojiBeads, setEmojiBeads] =
    useState<EmojiBeadsConfig>(EMOJI_BEADS_DEFAULT)

  // Top-right menu / guide modal — both start closed, guide opens from
  // the menu, menu itself opens on button click and closes on outside tap.
  const [menuOpen, setMenuOpen] = useState(false)
  // Scrollable unified tag row edge-fade tracking — mirrors the pattern
  // used by PrimaryChipsRow in CustomizePanel: when the row is scrolled
  // all the way to an end, drop the fade on that side so the first /
  // last tag reads crisp. Uses a stateful ref (callback ref → element
  // state) so the effect wires up the listeners exactly once when the
  // tag row DOM element mounts.
  const [unifiedTagRowEl, setUnifiedTagRowEl] =
    useState<HTMLDivElement | null>(null)
  const [unifiedTagAtStart, setUnifiedTagAtStart] = useState(true)
  const [unifiedTagAtEnd, setUnifiedTagAtEnd] = useState(true)
  useEffect(() => {
    if (!unifiedTagRowEl) return
    const update = () => {
      const max = unifiedTagRowEl.scrollWidth - unifiedTagRowEl.clientWidth
      setUnifiedTagAtStart(unifiedTagRowEl.scrollLeft <= 1)
      setUnifiedTagAtEnd(unifiedTagRowEl.scrollLeft >= max - 1 || max <= 0)
    }
    update()
    unifiedTagRowEl.addEventListener('scroll', update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(unifiedTagRowEl)
    return () => {
      unifiedTagRowEl.removeEventListener('scroll', update)
      ro.disconnect()
    }
  }, [unifiedTagRowEl])
  // Collection dropdown — bookmark button top-left toggles a small
  // menu with "저장하기" and "컬렉션 보기" buttons.
  const [collectionMenuOpen, setCollectionMenuOpen] = useState(false)
  // Bottom-area mode toggle. 'options' shows CustomizePanel + tag
  // row (default). 'collection' hides those and replaces them with
  // an inline swipeable collection carousel — toggled via the
  // bottom-row right side collection button.
  const [bottomMode, setBottomMode] = useState<'options' | 'collection'>(
    'options'
  )
  const bottomModeRef = useRef(bottomMode)
  useEffect(() => {
    bottomModeRef.current = bottomMode
  }, [bottomMode])
  // Which slime the inline carousel has centered. -1 = no
  // selection (initial + on every entry to collection mode) so
  // the user must explicitly tap a card before the action buttons
  // appear. Ignored when `bottomMode !== 'collection'`.
  const [carouselIdx, setCarouselIdx] = useState(-1)
  useEffect(() => {
    if (bottomMode === 'collection') setCarouselIdx(-1)
  }, [bottomMode])
  // Delete mode — activated by long-pressing a collection card.
  // Every card gains a checkbox and the action row swaps to
  // 취소 / 삭제(N) so the user can multi-select entries to drop.
  const [deleteMode, setDeleteMode] = useState(false)
  const [selectedForDelete, setSelectedForDelete] = useState<Set<string>>(
    new Set()
  )
  useEffect(() => {
    if (bottomMode !== 'collection') {
      setDeleteMode(false)
      setSelectedForDelete(new Set())
    }
  }, [bottomMode])
  // 사진 슬라임 (스티커) — file picker lives inside the slime tab's
  // Header (right-slot camera button). `stickerOn` toggles the button
  // between "add" and "clear" modes.
  const [stickerOn, setStickerOn] = useState(false)
  // 텍스트 데칼 — ONE text label per slime. Content / colour / size are
  // the only knobs. The label always sits on the camera-facing
  // hemisphere; a coating on top auto-lifts the text above so it stays
  // legible. Colour is pushed to the shader as a uniform so tint
  // changes never trigger a texture upload.
  const [slimeText, setSlimeText] = useState<SlimeText>(SLIME_TEXT_DEFAULT)
  // Which slime sub-panel is active (color / material / … / text). Only
  // meaningful when activePanel === 'slime'; used to enable the
  // click-to-pick-cube-face raycast branch in onPointerDown while the
  // text sub is open.
  const [activeSlimeSub, setActiveSlimeSub] = useState<string | null>(null)
  // (activePanel state removed — "슬라임 안" toggle now lives at the
  // top-left of each relevant sub-panel inside CustomizePanel itself,
  // so SlimeApp no longer needs to mirror the category out.)
  // Imperative "jump to category" bridge — CustomizePanel registers
  // its openCategory here so unified-tag-row clicks can navigate
  // straight into the panel that owns the tag.
  const openCategoryRef = useRef<
    ((id: string | null, subId?: string) => void) | null
  >(null)
  // Up to 4 photo beads — big chunk-style beads on the slime's front
  // hemisphere with a photo decal on each. Managed as a fixed-length
  // slots array so users can add / remove specific slots without
  // reshuffling the others. `null` = empty slot. Textures are
  // disposed when the slot is cleared or replaced.
  const [photoBeads, setPhotoBeads] = useState<(THREE.Texture | null)[]>(
    () => [null, null, null, null]
  )
  // Full-screen grid modal — opened from the browse view via
  // "모두보기". Shows saved slimes as a 2-row × N-column preview grid.
  const [collectionOpen, setCollectionOpen] = useState(false)
  // Browse mode — while non-null, the app is rendering a saved slime
  // from the collection and the user can swipe left/right to pick a
  // different one. Slime press interaction is disabled during
  // browse; use the top "닫기" button to return to normal editing.
  const [browseIdx, setBrowseIdx] = useState<number | null>(null)
  // Naming dialog — reused for both "save new slime" (mode 'save',
  // pending state snapshot + thumb) and "rename existing" (mode
  // 'rename', target id). Null while closed.
  const [nameDialog, setNameDialog] = useState<
    | {
        mode: 'save'
        pendingState: unknown
        pendingThumb: string | undefined
        input: string
      }
    | { mode: 'rename'; id: string; input: string }
    | null
  >(null)
  const browseIdxRef = useRef(browseIdx)
  useEffect(() => {
    browseIdxRef.current = browseIdx
  }, [browseIdx])
  // Legacy 만져보기 flag — kept as a value-only read for the older
  // display-none gates on .controls / hud overlays. Never flipped now
  // that collection mode itself is the full-screen preview surface
  // (top of screen = live slime, bottom = carousel), so effectively
  // constant false. Removed setter to satisfy the noUnusedLocals lint.
  const collectionPreview = false
  // 수정하기 confirmation — populated when the user clicks "수정하기"
  // on a saved entry while there are unsaved changes to the current
  // slime. The modal asks whether to save current before switching.
  const [pendingCollectionEdit, setPendingCollectionEdit] =
    useState<{ state: unknown } | null>(null)
  // Snapshot of the user's WIP slime taken the instant they entered
  // browse mode. The "×" close button restores this so previewing a
  // saved slime doesn't destroy in-progress work.
  const preBrowseStateRef = useRef<unknown | null>(null)
  // Snapshot of the WIP slime taken when the user hits "만져보기" on
  // a saved collection entry. Restored when they hit "컬렉션으로
  // 돌아가기" so the carousel isn't showing the previewed slime behind
  // it — the user drops back into whatever they had been editing.
  const preCollectionPreviewStateRef = useRef<unknown | null>(null)
  // Preview-mode toggle inside browse view — off by default; when
  // OFF, slime interactions are disabled and the whole overlay
  // absorbs pointer input for horizontal swipe navigation. When
  // ON, interactions (press / rotate / pinch) are enabled and
  // swipe nav is disabled (single-finger drag rotates instead).
  const [previewMode, setPreviewMode] = useState(false)
  const previewModeRef = useRef(previewMode)
  useEffect(() => {
    previewModeRef.current = previewMode
  }, [previewMode])
  // Auto-spin timer — set to performance.now() + 600 on every
  // browsed-index change. Render loop reads this and rotates the
  // slime a full 360° over that 0.6 s window so the user sees each
  // saved slime from every angle before it settles.
  const autoSpinUntilRef = useRef(0)
  // Carousel slide — set when the user swipes between saved slimes.
  // Render loop applies mesh.position.x based on progress: current
  // slime slides OUT in the swipe direction, state is swapped at
  // the midpoint, then the new slime slides IN from the opposite
  // side. Duration 400ms → feels connected without lingering.
  const carouselRef = useRef<{
    startTime: number
    duration: number
    /** +1 = slide out to the RIGHT (used when going back to prev),
     *  -1 = slide out to the LEFT (used when going to next). */
    direction: 1 | -1
    /** Pending state apply. Called at midpoint (offscreen) so the
     *  user never sees the state swap flash. */
    swap: (() => void) | null
  } | null>(null)
  // "Reset needed" flag for browse mode. Flips true the first time
  // the user presses the previewed slime (in preview mode), so a
  // reset button can appear above the slime. Cleared when the user
  // hits reset, switches saved item, or leaves preview mode.
  const [browsePressed, setBrowsePressed] = useState(false)
  const browsePressedRef = useRef(browsePressed)
  useEffect(() => {
    browsePressedRef.current = browsePressed
  }, [browsePressed])
  const [collection, setCollection] = useState<
    {
      id: string
      name: string
      createdAt: number
      state: unknown
      /** Base64 JPEG preview captured from the live canvas at save
       *  time (data-URL). Missing on entries saved before the
       *  thumbnail feature was added. */
      thumb?: string
    }[]
  >(() => {
    if (typeof window === 'undefined') return []
    try {
      const saved = window.localStorage.getItem('wakbu-collection')
      if (!saved) return []
      const parsed = JSON.parse(saved)
      if (Array.isArray(parsed)) return parsed
    } catch {
      // Corrupted storage — start fresh.
    }
    return []
  })
  useEffect(() => {
    try {
      window.localStorage.setItem(
        'wakbu-collection',
        JSON.stringify(collection)
      )
    } catch {
      // Private-mode storage error — collection still works for the session.
    }
  }, [collection])
  // One-shot migration for pre-PNG saves: old thumbnails were saved as
  // JPEG which fills the transparent WebGL bg with pure black, creating
  // a visible dark rectangle around each slime that doesn't match the
  // pill background. Convert every JPEG entry to a chroma-keyed PNG
  // (near-black → transparent) so the pill's page tone shows through.
  useEffect(() => {
    const jpegEntries = collection.filter((c) =>
      c.thumb?.startsWith('data:image/jpeg')
    )
    if (jpegEntries.length === 0) return
    let cancelled = false
    ;(async () => {
      const migrated = await Promise.all(
        collection.map(async (entry) => {
          if (!entry.thumb?.startsWith('data:image/jpeg')) return entry
          try {
            const img = new Image()
            img.src = entry.thumb
            await new Promise<void>((resolve, reject) => {
              img.onload = () => resolve()
              img.onerror = () => reject(new Error('load failed'))
            })
            const c = document.createElement('canvas')
            c.width = img.naturalWidth
            c.height = img.naturalHeight
            const ctx = c.getContext('2d')
            if (!ctx) return entry
            ctx.drawImage(img, 0, 0)
            const px = ctx.getImageData(0, 0, c.width, c.height)
            const d = px.data
            // Chroma-key near-black to transparent. Threshold is
            // generous so JPEG compression halos around the slime
            // silhouette also drop out cleanly.
            for (let i = 0; i < d.length; i += 4) {
              if (d[i] < 12 && d[i + 1] < 12 && d[i + 2] < 12) {
                d[i + 3] = 0
              }
            }
            ctx.putImageData(px, 0, 0)
            return { ...entry, thumb: c.toDataURL('image/png') }
          } catch {
            return entry
          }
        })
      )
      if (cancelled) return
      setCollection(migrated)
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // Emoji move mode — modal toggle. When ON, slime press is
  // disabled and any tap/drag on the slime moves emojis instead.
  // Off is the normal state (press works, emojis stay put).
  const [emojiMoveOn, setEmojiMoveOn] = useState(false)
  const emojiMoveOnRef = useRef(emojiMoveOn)
  useEffect(() => {
    emojiMoveOnRef.current = emojiMoveOn
  }, [emojiMoveOn])
  // Wax coating uses a single file with an attack region baked into
  // its head and a loop region for the sustain (see NAMED_SAMPLE_URLS
  // + NAMED_SAMPLE_RANGES for `wax`). This ref latches "the next
  // press should include the attack" — the render loop passes offset
  // 0 to `setLoopingSampleLevel` when true (so playback starts at the
  // top of the file, plays the attack once, then falls into the loop
  // region), and passes no offset otherwise (playback jumps straight
  // to loopStart and just loops the sustain). Consumed on the first
  // frame that clears the audible level threshold.
  const waxAttackPendingRef = useRef(true)
  // Wrapper around slime physics reset that ALSO re-arms the wax
  // attack one-shot, so the very next press on a wax-coated slime
  // fires Wax4 again + then continues the WaxCrunch sustain loop.
  const applyPressReset = () => {
    waxAttackPendingRef.current = true
    applyRef.current?.reset()
  }
  // Auto-press mode — when engaged, the render loop injects synthetic
  // press tips at pseudo-random points on the front hemisphere with a
  // rhythmic envelope, so the slime squishes on its own for a fixed
  // duration. `startAt` seeds the cycle timer + PRNG; `endAt` bounds
  // the session. UI badge (`autoPressOn`) mirrors the ref for the
  // button's active state and gets flipped off from inside the loop
  // when the deadline passes.
  // Developer-set fallback default; user can override + persist via
  // the countdown pill's edit modal (kept in localStorage under
  // `wakbu-auto-default-ms`).
  const AUTO_PRESS_DEFAULT_MS = 10000
  const [autoPressDefaultMs, setAutoPressDefaultMs] = useState<number>(
    () => {
      try {
        const raw = window.localStorage.getItem('wakbu-auto-default-ms')
        const n = raw ? Number(raw) : NaN
        if (Number.isFinite(n) && n > 0 && n <= 3600 * 1000) return n
      } catch {
        // private mode / storage error — fall through to default.
      }
      return AUTO_PRESS_DEFAULT_MS
    }
  )
  useEffect(() => {
    try {
      window.localStorage.setItem(
        'wakbu-auto-default-ms',
        String(autoPressDefaultMs)
      )
    } catch {
      // ignore
    }
  }, [autoPressDefaultMs])
  const [autoPressOn, setAutoPressOn] = useState(false)
  const autoPressStartRef = useRef(0)
  const autoPressEndAtRef = useRef(0)
  // Top-of-screen countdown pill state — remaining ms is polled from
  // an interval that also flips `autoPressOn` off once the deadline
  // lapses (previously handled by a setTimeout keyed to the fixed
  // duration; now the duration can change mid-session so polling is
  // simpler than reshuffling timers).
  const [autoPressRemainingMs, setAutoPressRemainingMs] = useState(0)
  // Time-edit modal — opens when the user taps the countdown pill.
  // Local edit values decouple the picker from the live session so
  // the user can dial without disturbing the running countdown.
  const [autoTimeOpen, setAutoTimeOpen] = useState(false)
  const [autoTimeEditMin, setAutoTimeEditMin] = useState(0)
  const [autoTimeEditSec, setAutoTimeEditSec] = useState(10)
  const [autoSaveAsDefault, setAutoSaveAsDefault] = useState(false)
  // Poll the deadline while a session is active: updates the countdown
  // display each tick and flips `autoPressOn` off the instant the
  // remaining time hits zero. Interval-based instead of a setTimeout
  // so mid-session duration edits (via the picker) don't need timer
  // reshuffling — the next tick just reads the fresh endAt.
  useEffect(() => {
    if (!autoPressOn) return
    const tick = () => {
      const remaining = autoPressEndAtRef.current - performance.now()
      if (remaining <= 0) {
        autoPressEndAtRef.current = 0
        autoPressNextAtRef.current = Number.POSITIVE_INFINITY
        setAutoPressRemainingMs(0)
        setAutoPressOn(false)
        return
      }
      setAutoPressRemainingMs(remaining)
    }
    tick()
    const id = window.setInterval(tick, 200)
    return () => window.clearInterval(id)
  }, [autoPressOn])
  // Currently in-flight synthetic presses. Each entry lives out its
  // own duration/envelope independently, so overlapping "flurries" and
  // isolated pokes can coexist. Purged as they finish. Kept as plain
  // number bags (not Vector3s) so the per-frame prune costs nothing.
  const autoPressActivesRef = useRef<
    Array<{
      startedAt: number
      duration: number
      posX: number
      posY: number
      posZ: number
      peak: number
      radius: number
      env: number
    }>
  >([])
  // Timestamp of the next scheduled spawn. Randomized between "flurry"
  // (tight overlap), "normal", and "long pause" bands so the rhythm
  // never settles into a heartbeat cadence.
  const autoPressNextAtRef = useRef(0)
  // Refs mirrored from state for the cube-face text raycast branch inside
  // onPointerDown — the pointer handler is installed once at mount and
  // otherwise runs against a stale closure, so we thread every input it
  // needs through refs kept in sync via effects below.
  const activeSlimeSubRef = useRef<string | null>(null)
  const shapeRef = useRef<ShapeId>('sphere')
  const slimeTextRef = useRef<SlimeText>(SLIME_TEXT_DEFAULT)
  // Auto-exit emoji move mode when the emoji layer becomes empty
  // (user removed all emojis). Prevents an orphan mode where the
  // toggle button disappears but press stays disabled.
  useEffect(() => {
    const hasEmojis =
      emojiBeads.emojis.length > 0 && emojiBeads.count > 0
    const hasCustomBeads = customBeads.count > 0
    if (!hasEmojis && !hasCustomBeads && emojiMoveOn) setEmojiMoveOn(false)
  }, [emojiBeads, customBeads, emojiMoveOn])
  // When the soft keyboard closes on Android (default adjustResize
  // behaviour), the WebView grows back but the input can retain focus —
  // that leaves the `.textSubPanel:focus-within` collapse latched,
  // hiding the font / size / color chips even though the user is done
  // typing. Detect the resize-back and blur any focused input so the
  // sub-panel re-expands on its own. Uses a running "biggest seen"
  // baseline so an initial launch with the keyboard already up doesn't
  // freeze the baseline at the shrunk size.
  useEffect(() => {
    if (typeof window === 'undefined') return
    let maxSeenH = window.innerHeight
    let prevH = window.innerHeight
    const onResize = () => {
      const now = window.innerHeight
      maxSeenH = Math.max(maxSeenH, now)
      if (now > prevH + 80 && now >= maxSeenH - 20) {
        const el = document.activeElement
        if (el instanceof HTMLElement && el.tagName === 'INPUT') {
          el.blur()
        }
      }
      prevH = now
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const [toast, setToast] = useState<string | null>(null)
  // Light / dark theme — persisted across sessions in localStorage so a
  // returning user gets the same look they left with. Read once on mount
  // via useState's initializer; SSR-safe fallback = 'dark' (the app's
  // origin look). Every change writes back and flips the `data-theme`
  // attribute on <html>, which every module reads through CSS variables.
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    if (typeof window === 'undefined') return 'dark'
    const saved = window.localStorage.getItem('wakbu-theme')
    return saved === 'light' ? 'light' : 'dark'
  })
  useEffect(() => {
    if (typeof document === 'undefined') return
    document.documentElement.setAttribute('data-theme', theme)
    try {
      window.localStorage.setItem('wakbu-theme', theme)
    } catch {
      // Private-mode storage error — theme still works for the session.
    }
    // Keep the WebGL background orb in sync so the scene doesn't stay
    // dark inside a light-mode UI. Colours match the CSS --bg-orb tokens.
    applyRef.current?.setSceneBackground(
      theme === 'light' ? 0xe5deec : 0x000000
    )
    applyRef.current?.setEdgeTheme(theme)
  }, [theme])

  // Imperative handles exposed by the scene effect.
  const applyRef = useRef<{
    setColors: (v: readonly ColorId[]) => void
    setMaterial: (v: MaterialId) => void
    setCoating: (v: CoatingId) => void
    setWaxThicknessAlpha: (a: number) => void
    setCrunchOn: (on: boolean) => void
    setCoatingColors: (hexes: number[]) => void
    setShape: (v: ShapeId) => void
    setBeads: (v: BeadsConfig) => void
    setSprinkles: (v: SprinklesConfig) => void
    setEmojiBeads: (v: EmojiBeadsConfig) => void
    /** Toggle the emoji layer's dim ghost pass (crystal slime only). */
    setEmojiGhost: (v: boolean) => void
    /** Extra outward lift added to every emoji, in world units. */
    setEmojiBeadLift: (h: number) => void
    /** Re-tint the WebGL background orb — kept in sync with the React
     *  light / dark theme so the scene stops reading as dark inside the
     *  light-mode UI. */
    setSceneBackground: (hex: number) => void
    /** Push the current UI theme into the slime shader so the crystal
     *  material's grazing-angle rim brightness tracks the background. */
    setEdgeTheme: (theme: 'dark' | 'light') => void
    /** Push per-colour HSL deltas from the adjustment sliders. Both
     *  slime and beads re-resolve palette hex through these deltas
     *  so an 아쿠아 tweak reads the same across surfaces. */
    setColorAdjustments: (adjustments: ColorAdjustments) => void
    /** Apply (or clear) the 촬영 스티커 photo decal on the slime's
     *  front hemisphere. Pass null to disable and dispose the
     *  underlying texture. */
    setPhotoDecal: (texture: THREE.Texture | null) => void
    /** Swap the 텍스트 데칼 texture (single slot per slime).
     *  Axis is managed independently via setTextAxis. */
    setTextDecal: (texture: THREE.Texture | null) => void
    /** Axis-only text update — cheap enough to call every render
     *  frame for the sphere camera-facing path. */
    setTextAxis: (axisX: number, axisY: number, axisZ: number) => void
    /** Toggle whether text draws OVER the coating (crisp on top) or
     *  UNDER it (buried, tinted by translucent coats). */
    setTextAboveCoating: (above: boolean) => void
    /** Text tint. Canvas ships white alpha mask; the shader tints
     *  fragments by this colour × canvas alpha, so a colour change is
     *  a single uniform write with no texture upload. */
    setTextColor: (hex: number) => void
    /** Whether ANY text slot has an uploaded texture — lets the
     *  render loop skip per-frame axis math when there's nothing
     *  to place. */
    hasTextDecal: () => boolean
    /** Push the full set of photo bead textures (up to 4) into the
     *  bead layer. Non-null entries print onto the existing beads —
     *  the pool is split evenly so 1 photo = all beads, 2 = half+half,
     *  etc. Passing all-null clears photos entirely. */
    setPhotoBeads: (textures: (THREE.Texture | null)[]) => void
    /** Push a 속슬라임 config (BeadsConfig shape) into the dedicated
     *  inner BeadsLayer instance. Applies squish-on-press physics on
     *  top of the standard chunk render. */
    setInnerSlime: (v: BeadsConfig) => void
    /** Push 커스텀비즈 config into the additive layer. */
    setCustomBeads: (v: CustomBeadsConfig) => void
    /** Set (or clear) the shared photo texture printed on every
     *  custom bead's outward face. */
    setCustomBeadsPhoto: (texture: THREE.Texture | null) => void
    reset: () => void
    /** Snapshot the slime with a CANONICAL scale (1) and identity
     *  rotation so every thumbnail in the collection reads at a
     *  consistent size and orientation. The temporary transform is
     *  reverted immediately, so the live view is unaffected. */
    captureCanonicalThumbnail: () => string | undefined
  } | null>(null)

  useEffect(() => {
    applyRef.current?.setColors(colors)
  }, [colors])
  useEffect(() => {
    // Push adjustments FIRST so the layer classes cache them, then
    // re-emit setColors so the slime + wrap materials pick up the
    // freshly-adjusted hex. Also re-run setBeads via the beads state
    // effect below (colorAdjustments doesn't invalidate beads config
    // but triggers re-emit through setColorAdjustments in the layer).
    applyRef.current?.setColorAdjustments(colorAdjustments)
  }, [colorAdjustments])
  useEffect(() => {
    applyRef.current?.setMaterial(material)
  }, [material])
  useEffect(() => {
    applyRef.current?.setCoating(coating)
    // Wax-coating tint alpha:
    //   씬왁스 → always translucent (alpha 0.30) regardless of colour,
    //     since 씬왁스 by definition is a THIN coat that reads as a
    //     translucent wash — the inner slime bleeds through every tint.
    //   왁스 → colour-dependent: white picks the translucent 0.80 shell
    //     (real white candle wax lets some interior light through),
    //     any other colour paints a fully opaque solid shell (alpha 1.0).
    //   Non-wax coatings ignore this uniform.
    const isWhiteWax =
      coatingColors.length > 0 && coatingColors[0] === 'white'
    let waxAlpha = 1.0
    if (coating === 'thinwax') {
      waxAlpha = 0.30
    } else if (coating === 'wax') {
      waxAlpha = isWhiteWax ? 0.80 : 1.0
    }
    applyRef.current?.setWaxThicknessAlpha(waxAlpha)
  }, [coating, coatingColors])
  useEffect(() => {
    applyRef.current?.setCrunchOn(crunchOn)
  }, [crunchOn])
  // Coating tint is now INDEPENDENT of the slime's own colour picks —
  // wax reads from the general slime palette (COLORS) via `coatingColors`,
  // foil reads from the metallic COATING_COLORS palette via `foilColors`.
  // The user picks the coating colour separately in the panel so a red
  // slime can wear a gold wax coating (or blue slime under silver foil,
  // etc). Empty selection falls back to a warm off-white so the coating
  // has some visible tint even before the user picks one.
  useEffect(() => {
    let hexes: number[]
    if (coating === 'foil') {
      // Foil colours resolve through their own `fc:` adjustment namespace
      // so tweaking a foil silver stays independent from tweaks to any
      // other palette usage.
      const palette = foilColors.map((id) =>
        resolveFoilCoatingHex(id, colorAdjustments)
      )
      hexes = palette.length > 0 ? palette : [0xb5bbc4]
    } else {
      // Wax / thinwax / tube (젤) / ice (글레이즈) coatings all pull from
      // the general COLORS palette via the shared `coatingColors` state,
      // keyed under `wc:` so their tunes stay independent from slime.
      const palette = coatingColors.map((id) =>
        resolveWaxCoatingHex(id, colorAdjustments)
      )
      // No pick → pure white so the default coating reads as clean
      // white rather than a warm off-white / cream.
      hexes = palette.length > 0 ? palette : [0xffffff]
    }
    applyRef.current?.setCoatingColors(hexes)
  }, [coating, coatingColors, foilColors, colorAdjustments])
  useEffect(() => {
    applyRef.current?.setShape(shape)
  }, [shape])
  useEffect(() => {
    applyRef.current?.setBeads(beads)
  }, [beads])
  useEffect(() => {
    applyRef.current?.setInnerSlime(innerSlime)
  }, [innerSlime])
  useEffect(() => {
    applyRef.current?.setCustomBeads(customBeads)
  }, [customBeads])
  useEffect(() => {
    applyRef.current?.setCustomBeadsPhoto(customBeadsPhoto)
  }, [customBeadsPhoto])
  useEffect(() => {
    applyRef.current?.setSprinkles(sprinkles)
  }, [sprinkles])
  useEffect(() => {
    applyRef.current?.setEmojiBeads(emojiBeads)
  }, [emojiBeads])
  useEffect(() => {
    // Push the whole slot array — BeadsLayer rebuilds its atlas +
    // per-instance quadrant assignment based on which slots are
    // non-null and how many active beads exist.
    applyRef.current?.setPhotoBeads(photoBeads)
  }, [photoBeads])
  // Mirror latest state into the pointer-handler-facing refs.
  useEffect(() => {
    activeSlimeSubRef.current = activeSlimeSub
  }, [activeSlimeSub])
  useEffect(() => {
    shapeRef.current = shape
  }, [shape])
  useEffect(() => {
    slimeTextRef.current = slimeText
  }, [slimeText])
  // Text decal pipeline — SINGLE text label per slime. The canvas is
  // redrawn only when content / size changes (the shape of the alpha
  // mask); colour is a shader uniform pushed separately so tint
  // changes don't require a texture upload. Debounced 40 ms to
  // coalesce slider drags. Front-hemisphere placement (camera-facing
  // for sphere via the render loop's setTextAxis call).
  const textCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const textTextureRef = useRef<THREE.CanvasTexture | null>(null)
  const textKeyRef = useRef<string>('')
  useEffect(() => {
    const trimmed = slimeText.content.trim()
    const key = `${trimmed}|${slimeText.size}`
    const timer = setTimeout(() => {
      if (key === textKeyRef.current) return
      textKeyRef.current = key
      if (!trimmed) {
        const prev = textTextureRef.current
        if (prev) {
          prev.dispose()
          textTextureRef.current = null
        }
        applyRef.current?.setTextDecal(null)
        return
      }
      if (!textCanvasRef.current) {
        const c = document.createElement('canvas')
        c.width = 512
        c.height = 512
        textCanvasRef.current = c
      }
      const canvas = textCanvasRef.current
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const size = canvas.width
      ctx.clearRect(0, 0, size, size)
      const fontPx = Math.max(32, Math.round(size * 0.32 * slimeText.size))
      const family =
        '"Noto Sans KR", "Malgun Gothic", system-ui, sans-serif'
      ctx.font = `900 ${fontPx}px ${family}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      // Canvas ships as a pure-white alpha mask; the shader tints
      // those alpha pixels by uTextColor at draw time, so colour
      // changes are one uniform write with no texture upload.
      ctx.fillStyle = '#ffffff'
      const maxWidth = size * 0.85
      const measured = ctx.measureText(trimmed).width
      if (measured > maxWidth) {
        const scale = maxWidth / measured
        const shrunk = Math.max(24, Math.round(fontPx * scale))
        ctx.font = `900 ${shrunk}px ${family}`
      }
      ctx.fillText(trimmed, size / 2, size / 2)
      const tex = new THREE.CanvasTexture(canvas)
      tex.colorSpace = THREE.SRGBColorSpace
      tex.anisotropy = 4
      tex.needsUpdate = true
      textTextureRef.current = tex
      applyRef.current?.setTextDecal(tex)
    }, 40)
    return () => clearTimeout(timer)
  }, [slimeText.content, slimeText.size])
  // Colour push — no debounce. Fires on every render so a colour chip
  // click always reaches the shader on the same tick, regardless of
  // whether the deps-array reconciler catches the change (a previous
  // deps-array approach silently failed on the Android WebView bundle).
  useEffect(() => {
    const hex = resolveColorHex(slimeText.color, colorAdjustments)
    applyRef.current?.setTextColor(hex)
  })
  // aboveCoating — auto-lift text above any active coating so the
  // letters stay legible instead of getting buried under wax / foil /
  // ice / tube. On plain (uncoated) slime the flag stays off so the
  // text mixes into the material at the pre-coating stage.
  useEffect(() => {
    const hasText = slimeText.content.trim().length > 0
    const coatingActive = coating !== 'none'
    applyRef.current?.setTextAboveCoating(coatingActive && hasText)
  }, [slimeText.content, coating])
  // Emoji visibility — two independent knobs:
  //  • Ghost pass (dim fill-in through opaque geometry) is on for CRYSTAL
  //    slime only, so the buried portion of an emoji reads faintly through
  //    the transparent slime body without leaking through opaque slime.
  //  • Extra bead-lift pushes emojis outward enough to clear the bead
  //    layer at rest — so beads no longer bury them by default — while
  //    the layer's own compression-sink still lets a finger press
  //    physically submerge an emoji into the bead layer under load.
  useEffect(() => {
    const beadsActive =
      beads.combo !== 'none' && (beads.fill || beads.count > 0)
    const slimeCrystal = material === 'crystal'
    applyRef.current?.setEmojiGhost(slimeCrystal)
    // Bead-lift depends on WHERE the beads physically sit:
    //   • No beads → 0 (emoji rests on slime surface).
    //   • 속비즈 (chunk combo + 1 bead, placed at slime ORIGIN) → 0.
    //     The bead is fully embedded inside the slime, not on the
    //     surface, so pushing emojis outward by bead-size would
    //     leave them floating in empty space above the surface.
    //   • Compact fill (mini beads packed on the surface) → half-
    //     size lift so emojis mix into the bead layer instead of
    //     hovering distinctly above it.
    //   • Regular chunk (multiple beads on surface) → full size +
    //     small margin so emoji clears each bead's outer cap.
    let beadLift = 0
    if (beadsActive) {
      const isCenteredSingleChunk =
        beads.combo === 'chunk' && beads.count === 1
      if (isCenteredSingleChunk) {
        beadLift = 0
      } else if (beads.combo === 'compact' || beads.fill) {
        beadLift = beads.size * 0.6
      } else {
        beadLift = beads.size + 0.05
      }
    }
    applyRef.current?.setEmojiBeadLift(beadLift)
  }, [material, beads])

  // Snap the entire customisation back to the entry state (white + crystal
  // slime, no beads / sprinkles / emojis) AND clear any physics deformation.
  // Distinct from the plain 리셋 button, which only wipes the slime's
  // current dents/velocities without touching config.
  // Undo history — every user state change pushes the previous
  // snapshot here so the 이전 bottom-bar button can walk back
  // step by step. Capped at 30 entries; suppression flag stops
  // undo-triggered applies from feeding themselves back in.
  const undoHistoryRef = useRef<unknown[]>([])
  const suppressHistoryRef = useRef(false)
  const lastSnapshotRef = useRef<unknown>(null)
  // Tracks whether the current in-editor slime has been modified
  // since it was last saved to the collection. Drives the
  // beforeunload confirm prompt so users don't accidentally lose
  // their in-progress slime by closing the tab / navigating away.
  const hasUnsavedChangesRef = useRef(false)
  useEffect(() => {
    const cur = buildStateSnapshot()
    if (lastSnapshotRef.current === null) {
      lastSnapshotRef.current = cur
      return
    }
    if (suppressHistoryRef.current) {
      suppressHistoryRef.current = false
      lastSnapshotRef.current = cur
      return
    }
    undoHistoryRef.current.push(lastSnapshotRef.current)
    if (undoHistoryRef.current.length > 30) {
      undoHistoryRef.current.shift()
    }
    lastSnapshotRef.current = cur
    hasUnsavedChangesRef.current = true
    // Only depend on the mutable state fields — refs / functions
    // are stable across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    colors,
    material,
    coating,
    coatingColors,
    foilColors,
    shape,
    beads,
    innerSlime,
    customBeads,
    sprinkles,
    emojiBeads,
    crunchOn
  ])
  // Warn the user before leaving with unsaved slime changes so they
  // don't accidentally lose an in-progress design. Modern browsers
  // ignore the custom message and show their own generic prompt.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (!hasUnsavedChangesRef.current) return
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [])

  const resetToDefaults = () => {
    setColors([])
    setMaterial('crystal')
    setCoating('none')
    setCoatingColors(['white'])
    setFoilColors(['silver'])
    setShape('sphere')
    setBeads(BEADS_DEFAULT)
    setInnerSlime(BEADS_DEFAULT)
    setCustomBeads(CUSTOM_BEADS_DEFAULT)
    setSprinkles(SPRINKLES_DEFAULT)
    setEmojiBeads(EMOJI_BEADS_DEFAULT)
    setCrunchOn(false)
    setSlimeText(SLIME_TEXT_DEFAULT)
    // Wipe every hue / lightness tune so the adjust sliders re-open
    // at zero if the user tunes a colour again after resetting.
    setColorAdjustments({})
    applyPressReset()
    // Also collapse the CustomizePanel — nuking every option should
    // clear the "opened category" state too so the panel isn't left
    // showing controls for options that no longer differ from default.
    openCategoryRef.current?.(null)
  }

  // Encode the full customisation into the URL so a shared link lands the
  // recipient on the exact same slime the sender was playing with. JSON
  // + URL-safe base64 (btoa with +→- and /→_) is compact enough to fit in
  // a query param without a shortener while staying trivially decodable.
  // Snapshot every user-facing customisation into a JSON-safe object.
  // Shared by the share-URL encoder AND the collection save path so
  // both routes carry exactly the same fields with no drift risk.
  const buildStateSnapshot = () => ({
    c: colors,
    m: material,
    co: coating,
    cc: coatingColors,
    fc: foilColors,
    sh: shape,
    b: beads,
    sp: sprinkles,
    e: emojiBeads,
    is: innerSlime,
    cb: customBeads,
    cr: crunchOn,
    tx: slimeText,
    ca: colorAdjustments
  })

  // Apply a decoded snapshot to the live customisation. Missing /
  // wrong-typed fields are silently skipped so partial or old-format
  // snapshots don't break the app.
  const applyStateSnapshot = (raw: unknown) => {
    if (!raw || typeof raw !== 'object') return
    const s = raw as Record<string, unknown>
    // Always apply Array fields even when empty — a saved default
     // slime (no colours picked) needs to CLEAR the current colour
     // list rather than inherit the previous slime's colours.
    if (Array.isArray(s.c)) setColors(s.c as ColorId[])
    if (typeof s.m === 'string') setMaterial(s.m as MaterialId)
    if (typeof s.co === 'string') {
      // Old wax snapshots carried a separate `wt` (waxThickness 1..4);
      // the coating ladder is now encoded directly in the coating id
      // (thinwax = translucent wax, wax = fully opaque), so we translate
      // old wt into the new id:
      //   wt ≤ 2 (thinner half) → thinwax
      //   wt ≥ 3 (thicker half) → wax
      // Snapshots without wt but with coating='wax' keep as 'wax'.
      const rawCo = s.co as string
      let coerced: CoatingId
      if (rawCo === 'wax' && typeof s.wt === 'number') {
        coerced = s.wt <= 2 ? 'thinwax' : 'wax'
      } else {
        coerced = rawCo as CoatingId
      }
      setCoating(coerced)
    }
    if (Array.isArray(s.cc) && s.cc.length > 0)
      setCoatingColors(s.cc as ColorId[])
    else if (typeof s.cc === 'string')
      setCoatingColors([s.cc as ColorId])
    if (Array.isArray(s.fc) && s.fc.length > 0)
      setFoilColors(s.fc as CoatingColorId[])
    else if (typeof s.fc === 'string')
      setFoilColors([s.fc as CoatingColorId])
    if (typeof s.sh === 'string') {
      // 'twist' shape was removed from the picker — coerce old snapshots
      // to 'sphere' so they still render with a valid shape id.
      const rawSh = s.sh as string
      setShape((rawSh === 'twist' ? 'sphere' : rawSh) as ShapeId)
    }
    // Coerce any 'ice' / 'tube' coatings baked into a bead or inner-slime
    // config to 'none' since those coating ids no longer have a chip.
    const coerceBeadCoating = (b: BeadsConfig): BeadsConfig =>
      b.coating === 'ice' || b.coating === 'tube'
        ? { ...b, coating: 'none' }
        : b
    // Slime-ball (innerSlime) now uses the slime MATERIALS palette.
    // Legacy configs may still carry BeadMaterialId 'plastic' from before
    // that switch — coerce to 'glossy' (current 슬라임볼 default) so the
    // ball still renders with a sensible material and keeps the same
    // radius as the multi-colour gradient path.
    const coerceInnerMaterial = (b: BeadsConfig): BeadsConfig => {
      const m = MATERIALS.find((x) => x.id === b.material)
      return m ? b : { ...b, material: 'glossy' }
    }
    if (s.b && typeof s.b === 'object')
      setBeads(coerceBeadCoating(s.b as BeadsConfig))
    if (s.sp && typeof s.sp === 'object') {
      // Legacy saves predate the 스팽글 종류 field — default missing
      // paper.kind to 'paper' so the sound routing has a valid value.
      const sp = s.sp as SprinklesConfig
      setSprinkles({
        ...sp,
        paper: { ...sp.paper, kind: sp.paper?.kind ?? 'paper' }
      })
    }
    if (s.e && typeof s.e === 'object')
      setEmojiBeads(s.e as EmojiBeadsConfig)
    if (s.is && typeof s.is === 'object')
      setInnerSlime(
        coerceInnerMaterial(coerceBeadCoating(s.is as BeadsConfig))
      )
    if (s.cb && typeof s.cb === 'object')
      setCustomBeads(s.cb as CustomBeadsConfig)
    if (typeof s.cr === 'boolean') setCrunchOn(s.cr)
    // Text decal — single item per slime. Legacy snapshots may carry
    // either the multi-slot `{ items: [...] }` shape or the older
    // per-item `{ content, fontId, size, color, face, aboveCoating }`
    // shape; both are coerced into the current SlimeText fields.
    if (s.tx && typeof s.tx === 'object') {
      const raw = s.tx as Record<string, unknown>
      let content = ''
      let color: ColorId = SLIME_TEXT_DEFAULT.color
      let size = SLIME_TEXT_DEFAULT.size
      if (Array.isArray(raw.items) && raw.items.length > 0) {
        const first = raw.items[0] as Record<string, unknown>
        content = typeof first.content === 'string' ? first.content : ''
        color = (first.color as ColorId) ?? color
        size = typeof first.size === 'number' ? first.size : size
      } else if (typeof raw.content === 'string') {
        content = raw.content
        color = (raw.color as ColorId) ?? color
        size = typeof raw.size === 'number' ? raw.size : size
      }
      setSlimeText({ content, color, size })
    } else {
      setSlimeText(SLIME_TEXT_DEFAULT)
    }
    // Hue/lightness slider tweaks live outside the colour list itself,
    // so a snapshot without `ca` predates this field — reset to {} in
    // that case so an older save doesn't inherit the current session's
    // adjustments and shift the loaded slime's colours.
    if (s.ca && typeof s.ca === 'object') {
      setColorAdjustments(s.ca as ColorAdjustments)
    } else {
      setColorAdjustments({})
    }
  }

  /** Load an image file into a square, centre-cropped CanvasTexture
   *  ready for use as a shader decal. Shared by the slime sticker
   *  and the photo bead pipelines so both get identical crop / size /
   *  colour-space treatment. Returns null when the browser can't
   *  decode the image so callers can silently no-op. */
  const loadPhotoTexture = async (
    file: File
  ): Promise<THREE.CanvasTexture | null> => {
    const url = URL.createObjectURL(file)
    try {
      const img = new Image()
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = () => reject(new Error('image load failed'))
        img.src = url
      })
      const side = Math.min(img.naturalWidth, img.naturalHeight)
      const canvas = document.createElement('canvas')
      const size = Math.min(512, side)
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d')
      if (!ctx) return null
      const sx = (img.naturalWidth - side) / 2
      const sy = (img.naturalHeight - side) / 2
      ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size)
      const tex = new THREE.CanvasTexture(canvas)
      tex.colorSpace = THREE.SRGBColorSpace
      tex.needsUpdate = true
      return tex
    } catch {
      return null
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  const handlePhotoSticker = async (file: File) => {
    const tex = await loadPhotoTexture(file)
    if (!tex) return
    applyRef.current?.setPhotoDecal(tex)
    setStickerOn(true)
  }

  const clearSticker = () => {
    applyRef.current?.setPhotoDecal(null)
    setStickerOn(false)
  }

  const setPhotoBeadAt = async (index: number, file: File) => {
    const tex = await loadPhotoTexture(file)
    if (!tex) return
    setPhotoBeads((prev) => {
      const next = prev.slice()
      // Dispose the outgoing texture so replacing a slot doesn't
      // slowly leak GPU memory across many photo picks.
      if (next[index]) next[index]!.dispose()
      next[index] = tex
      return next
    })
  }

  const clearPhotoBeadAt = (index: number) => {
    setPhotoBeads((prev) => {
      const next = prev.slice()
      if (next[index]) {
        next[index]!.dispose()
        next[index] = null
      }
      return next
    })
  }

  const encodeShareUrlFromState = (state: unknown): string => {
    const json = JSON.stringify(state)
    const b64 = btoa(unescape(encodeURIComponent(json)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    const { origin, pathname } = window.location
    return `${origin}${pathname}?d=${b64}`
  }
  const encodeShareUrl = (): string =>
    encodeShareUrlFromState(buildStateSnapshot())

  // Collection helpers — save current design under a user-provided
  // name (asked via nameDialog), load a saved design back into live
  // state, rename, remove one.
  const beginSaveToCollection = () => {
    // Capture the canonical thumbnail + state snapshot NOW so the
    // preview matches what the user was looking at when they hit
    // save, regardless of any tweaks made while the name dialog
    // is open.
    const pendingThumb = applyRef.current?.captureCanonicalThumbnail()
    const pendingState = buildStateSnapshot()
    setNameDialog({
      mode: 'save',
      pendingState,
      pendingThumb,
      input: `슬라임 ${collection.length + 1}`
    })
  }
  const commitNameDialog = () => {
    if (!nameDialog) return
    const trimmed = nameDialog.input.trim()
    if (nameDialog.mode === 'save') {
      const name = trimmed || `슬라임 ${collection.length + 1}`
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      setCollection((prev) => [
        ...prev,
        {
          id,
          name,
          createdAt: Date.now(),
          state: nameDialog.pendingState,
          thumb: nameDialog.pendingThumb
        }
      ])
      // Fresh save — clear the unsaved-changes gate so the
      // beforeunload confirm won't fire until the user tweaks
      // something new.
      hasUnsavedChangesRef.current = false
      setToast(`${name} 저장됨`)
      window.setTimeout(() => setToast(null), 2000)
    } else {
      // Rename mode — no-op on empty input.
      if (!trimmed) {
        setNameDialog(null)
        return
      }
      setCollection((prev) =>
        prev.map((c) =>
          c.id === nameDialog.id ? { ...c, name: trimmed } : c
        )
      )
    }
    setNameDialog(null)
  }
  const beginRename = (id: string) => {
    const entry = collection.find((c) => c.id === id)
    if (!entry) return
    setNameDialog({ mode: 'rename', id, input: entry.name })
  }
  const loadFromCollection = (id: string) => {
    const entry = collection.find((c) => c.id === id)
    if (!entry) return
    applyStateSnapshot(entry.state)
    setCollectionOpen(false)
    setBrowseIdx(null)
    setToast(`${entry.name} 불러옴`)
    window.setTimeout(() => setToast(null), 2000)
  }
  // Auto-preview the carousel-selected collection item on top of the
  // scene while in collection mode. Runs each time the selected index
  // (or the collection itself) changes so a swipe / tap immediately
  // reflects on the interactive slime above. First-time entry into
  // collection mode picks the FIRST item when nothing is explicitly
  // selected (carouselIdx = -1 → clamped to 0).
  useEffect(() => {
    if (bottomMode !== 'collection') return
    const items = collection.filter((c) => c.thumb)
    if (items.length === 0) return
    const idx =
      carouselIdx < 0
        ? 0
        : Math.min(carouselIdx, items.length - 1)
    const item = items[idx]
    if (!item) return
    applyStateSnapshot(item.state)
    applyPressReset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bottomMode, carouselIdx, collection])
  const deleteFromCollection = (id: string) => {
    setCollection((prev) => prev.filter((c) => c.id !== id))
  }

  // Share a specific saved slime via Web Share API (falls back to
  // clipboard copy). Used from the collection cards + browse view.
  const shareCollectionItem = async (id: string) => {
    const entry = collection.find((c) => c.id === id)
    if (!entry) return
    const url = encodeShareUrlFromState(entry.state)
    const payload = {
      title: 'soundslime',
      text: `${entry.name} 만들어봤어!`,
      url
    }
    try {
      if (typeof navigator !== 'undefined' && 'share' in navigator) {
        await navigator.share(payload)
        return
      }
    } catch {
      // User dismissed — fall through to clipboard.
    }
    try {
      await navigator.clipboard.writeText(url)
      setToast('링크가 복사되었습니다')
      window.setTimeout(() => setToast(null), 2000)
    } catch {
      setToast('공유 실패')
      window.setTimeout(() => setToast(null), 2000)
    }
  }

  // Swipe to a specific browsed item (clamped to range) and apply
  // its saved state to the live view. Also fully resets the slime
  // mesh (rotation / dents / scale) so navigating between saved
  // items always shows each one in its canonical un-touched form.
  const setBrowsedIndex = (nextIdx: number) => {
    const visible = collection.filter((c) => c.thumb)
    if (visible.length === 0) {
      setBrowseIdx(null)
      return
    }
    const clamped = Math.max(0, Math.min(visible.length - 1, nextIdx))
    if (clamped === browseIdx) return
    const currentIdx = browseIdx ?? clamped
    // -1 direction = swipe LEFT (going to next / higher idx) → old
    // slime slides off to the LEFT. +1 = opposite (prev).
    const direction: 1 | -1 = clamped > currentIdx ? -1 : 1
    // Any swipe / arrow nav automatically drops preview mode so the
    // next slime opens in "just viewing" state.
    setPreviewMode(false)
    setBrowsePressed(false)
    // Kick a carousel slide. The state swap happens at midpoint
    // (offscreen), then auto-spin runs on the incoming slime.
    carouselRef.current = {
      startTime: performance.now(),
      duration: 400,
      direction,
      swap: () => {
        setBrowseIdx(clamped)
        applyStateSnapshot(visible[clamped].state)
        applyPressReset()
        autoSpinUntilRef.current = performance.now() + 600
      }
    }
  }


  const handleShare = async () => {
    const url = encodeShareUrl()
    const payload = {
      title: 'soundslime',
      text: '내가 만든 슬라임 놀아봐!',
      url
    }
    try {
      if (typeof navigator !== 'undefined' && 'share' in navigator) {
        await navigator.share(payload)
        return
      }
    } catch {
      // User dismissed the share sheet — fall through to clipboard copy.
    }
    try {
      await navigator.clipboard.writeText(url)
      setToast('링크가 복사되었습니다')
      window.setTimeout(() => setToast(null), 2000)
    } catch {
      setToast('공유 실패')
      window.setTimeout(() => setToast(null), 2000)
    }
  }

  // On mount, decode a ?d= share param (if present) and apply it as the
  // initial customisation state so the recipient lands on the sender's
  // exact slime. Missing / malformed params silently no-op — the app
  // just boots with defaults.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const d = params.get('d')
    if (!d) return
    try {
      const b64 = d.replace(/-/g, '+').replace(/_/g, '/')
      const json = decodeURIComponent(escape(atob(b64)))
      applyStateSnapshot(JSON.parse(json))
    } catch {
      // Ignore invalid share params — user still gets a working slime.
    }
  }, [])

  // Sound engine — created lazily; kick off sample fetch/decode as soon as
  // the component mounts so the audio pool is ready by the time the user
  // actually kneads. Waiting for the first pointer gesture to START the
  // fetch left an audible ~600 ms gap while mp3s downloaded and decoded.
  // The AudioContext still needs a gesture to *play* (iOS/Safari), but a
  // suspended context can decode buffers just fine ahead of time.
  const soundRef = useRef<SoundEngine | null>(null)
  if (soundRef.current === null) soundRef.current = new SoundEngine()
  useEffect(() => {
    const engine = soundRef.current
    void engine?.loadSquishSamples(SQUISH_SAMPLE_URLS)
    // Wakcom.mp3 has a dead middle section [6, 8] we don't want
    // audible — pass it as `skipRanges` so the loader hands the
    // engine a spliced buffer. Loop range + start offset above are
    // expressed in POST-SPLICE seconds.
    void engine?.loadNamedSample('wax', NAMED_SAMPLE_URLS.wax, [
      [6, 8]
    ])
    void engine?.loadNamedSample('waxLayer', NAMED_SAMPLE_URLS.waxLayer)
    void engine?.loadNamedSample('thinwax', NAMED_SAMPLE_URLS.thinwax)
    void engine?.loadNamedSample('foil', NAMED_SAMPLE_URLS.foil)
    void engine?.loadNamedSample('ice', NAMED_SAMPLE_URLS.ice)
    void engine?.loadNamedSample('tube', NAMED_SAMPLE_URLS.tube)
    void engine?.loadNamedSample('beads', NAMED_SAMPLE_URLS.beads)
    void engine?.loadNamedSample('paper', NAMED_SAMPLE_URLS.paper)
    void engine?.loadNamedSample('plastic', NAMED_SAMPLE_URLS.plastic)
    void engine?.loadNamedSample(
      'plasticLayer',
      NAMED_SAMPLE_URLS.plasticLayer
    )
    void engine?.loadNamedSample('matte', NAMED_SAMPLE_URLS.matte)
    void engine?.loadNamedSample('metal', NAMED_SAMPLE_URLS.metal)
    void engine?.loadNamedSample('soft', NAMED_SAMPLE_URLS.soft)
    void engine?.loadNamedSample('iceMat', NAMED_SAMPLE_URLS.iceMat)
    // Imoji.mp3 has a dead middle section [4, 5] to splice out —
    // apply the same skip to the customBeads channel that reuses
    // the same file.
    void engine?.loadNamedSample('emoji', NAMED_SAMPLE_URLS.emoji, [
      [4, 5]
    ])
    void engine?.loadNamedSample('customBeads', NAMED_SAMPLE_URLS.customBeads, [
      [4, 5]
    ])
    void engine?.loadNamedSample('slimeTap', NAMED_SAMPLE_URLS.slimeTap)
    engine?.setNamedSampleRange('wax', NAMED_SAMPLE_RANGES.wax)
    engine?.setNamedSampleRange('thinwax', NAMED_SAMPLE_RANGES.thinwax)
    engine?.setNamedSampleRange('waxLayer', NAMED_SAMPLE_RANGES.waxLayer)
    engine?.setNamedSampleRange('foil', NAMED_SAMPLE_RANGES.foil)
    engine?.setNamedSampleRange('ice', NAMED_SAMPLE_RANGES.ice)
    engine?.setNamedSampleRange('tube', NAMED_SAMPLE_RANGES.tube)
    engine?.setNamedSampleRange('beads', NAMED_SAMPLE_RANGES.beads)
    engine?.setNamedSampleRange('paper', NAMED_SAMPLE_RANGES.paper)
    engine?.setNamedSampleRange('plastic', NAMED_SAMPLE_RANGES.plastic)
    engine?.setNamedSampleRange(
      'plasticLayer',
      NAMED_SAMPLE_RANGES.plasticLayer
    )
    engine?.setNamedSampleRange('matte', NAMED_SAMPLE_RANGES.matte)
    engine?.setNamedSampleRange('metal', NAMED_SAMPLE_RANGES.metal)
    engine?.setNamedSampleRange('soft', NAMED_SAMPLE_RANGES.soft)
    engine?.setNamedSampleRange('iceMat', NAMED_SAMPLE_RANGES.iceMat)
    engine?.setNamedSampleRange('emoji', NAMED_SAMPLE_RANGES.emoji)
    engine?.setNamedSampleRange(
      'customBeads',
      NAMED_SAMPLE_RANGES.customBeads
    )
    engine?.setNamedSampleRange('slimeTap', NAMED_SAMPLE_RANGES.slimeTap)
    // Softy.mp3 recorded quietly — boost the soft channel above the
    // 0..1 intensity ceiling so it reads at a comparable level to the
    // other material ambients on the same press pressure.
    engine?.setLoopingSampleGain('soft', 1.0)
    // Smoothie.mp3 (iceMat / 아이스 재질) recorded very quietly —
    // heavy boost above the intensity ceiling so even a light press
    // reads clearly at the top of the mix.
    engine?.setLoopingSampleGain('iceMat', 6.0)
    // Foil.mp3 (박지 coating) also recorded low — boost so the crack
    // sits at a comparable level to the other coating loops.
    engine?.setLoopingSampleGain('foil', 4.0)
    // Waxwax.mp3 (왁스 코팅, 어택+서스테인 통합 파일) — 다른 코팅
    // 채널과 균형 맞추기 위해 부스트.
    engine?.setLoopingSampleGain('wax', 3.0)
    // Thinwax.mp3 (씬왁스 코팅 loop) — 녹음 자체가 조용해서 다른
    // 코팅 채널과 균형 맞추려면 큰 부스트 필요.
    engine?.setLoopingSampleGain('thinwax', 6.0)
    // waxLayer도 같은 Thinwax.mp3를 씀 — 왁스 위에 얹히는 레이어라
    // primary thinwax보다 조금 낮게 부스트해서 위압하지 않도록.
    engine?.setLoopingSampleGain('waxLayer', 4.0)
    // Crisp.mp3 (글레이즈 ice 코팅) — 다른 코팅 채널 대비 조용해서
    // 균형 맞추기 위해 부스트.
    engine?.setLoopingSampleGain('ice', 3.0)
    // Papers.mp3 (폼/matte 재질) — 다른 재질 채널과 균형 맞추기
    // 위해 부스트.
    engine?.setLoopingSampleGain('matte', 3.0)
    // Glaze.mp3 (퍼티/metal 재질) — 같이 부스트.
    engine?.setLoopingSampleGain('metal', 3.0)
    // Imoji.mp3 (이모지) — 이모지 press 시 슬라임 base가 dim되므로
    // 그만큼 emoji가 acoustic foreground를 확실히 잡도록 부스트.
    engine?.setLoopingSampleGain('emoji', 3.0)
    // 추가비즈 (같은 Imoji.mp3 재사용) — 요청 gain 3.0.
    engine?.setLoopingSampleGain('customBeads', 3.0)
    // 스팽글 플라스틱 (Sharpstar.mp3) 부스트.
    engine?.setLoopingSampleGain('plastic', 3.0)
    // 플라스틱 위 병렬 Crunchier.mp3 레이어 — primary보다 낮게 잡아
    // 배경으로 깔림.
    engine?.setLoopingSampleGain('plasticLayer', 2.0)
    return () => {
      engine?.dispose()
    }
  }, [])

  // Refs mirroring React coating/beads state so the render loop (which runs
  // outside React) can pick the correct one-shot sample to play each frame.
  const coatingRef = useRef<CoatingId>('none')
  useEffect(() => {
    coatingRef.current = coating
  }, [coating])
  // Material mirror — matte swaps the default procedural squish for the
  // Sprinkle.mp3 loop, so the render loop needs to know the current
  // material to route pressure to the right channel each frame.
  const materialRef = useRef<MaterialId>('crystal')
  useEffect(() => {
    materialRef.current = material
  }, [material])
  // Bead coating mirror — chunk beads can carry an independent coating
  // (wax / caramel / foil / tube) whose crack sounds should fire in
  // parallel with the slime's own coating sounds when either surface
  // is being pressed.
  const beadCoatingRef = useRef<CoatingId>('none')
  useEffect(() => {
    beadCoatingRef.current = beads.coating
  }, [beads.coating])
  // 속슬라임 coating mirror — separate from beadCoatingRef so wax /
  // foil crack sounds fire independently when the user has coated
  // the inner slime inclusion. Both are Max'd into one sample slot
  // per coating type so any of the three surfaces (slime / beads /
  // inner slime) can drive playback without stepping on the others.
  const innerSlimeCoatingRef = useRef<CoatingId>('none')
  useEffect(() => {
    innerSlimeCoatingRef.current = innerSlime.coating
  }, [innerSlime.coating])
  // Re-arm the wax attack one-shot any time a surface switches TO the
  // wax coating (outer slime, beads, or inner slime). Guarantees the
  // Wax4 crack fires on the first press after the user picks wax from
  // the coating panel, without needing an explicit reset first.
  useEffect(() => {
    if (
      coating === 'wax' ||
      beads.coating === 'wax' ||
      innerSlime.coating === 'wax'
    ) {
      waxAttackPendingRef.current = true
    }
  }, [coating, beads.coating, innerSlime.coating])
  // Inner slime's material — mirrors the outer slime's materialRef so the
  // render loop can trigger the ball's material-specific ambient (matte
  // foam / metal putty) independently from the outer slime's material.
  // Ball inherits the outer slime MATERIALS palette so the union type
  // matches; regular BeadMaterialId values ('plastic') are treated as
  // 'crystal' for sound routing (a legacy default that predates the
  // palette switch).
  const innerSlimeMaterialRef = useRef<MaterialId | 'plastic'>('crystal')
  useEffect(() => {
    innerSlimeMaterialRef.current = innerSlime.material as
      | MaterialId
      | 'plastic'
  }, [innerSlime.material])
  const beadsActiveRef = useRef<boolean>(false)
  useEffect(() => {
    // Compact "미니 꽉 채우기" packs densely via `fill: true` while count
    // stays 0, so the activity check has to accept EITHER fill or a
    // non-zero explicit count.
    beadsActiveRef.current =
      beads.combo !== 'none' && (beads.fill || beads.count > 0)
  }, [beads])
  // Emoji layer activity — mirrors React state so the render loop can
  // drive an ambient loop when the user presses a slime that has emojis
  // active. Requires BOTH an emoji picked AND count > 0 (matches the
  // EmojiBeadsLayer render gate).
  const emojiActiveRef = useRef<boolean>(false)
  useEffect(() => {
    emojiActiveRef.current =
      emojiBeads.emojis.length > 0 && emojiBeads.count > 0
  }, [emojiBeads])
  // 추가비즈 (custom-beads) activity — mirror React state so the
  // render loop can drive its own ambient loop when the user presses
  // a slime carrying custom beads. Active whenever count > 0.
  const customBeadsActiveRef = useRef<boolean>(false)
  useEffect(() => {
    customBeadsActiveRef.current = customBeads.count > 0
  }, [customBeads])
  // Paper sprinkle activity — mirror React state to a ref so the render
  // loop can drive its sound scheduler each frame. Only fires while
  // paper is in FILL mode; scattered paper pieces are silent because
  // sparse confetti hitting the slime shouldn't add an ambient hiss.
  // Split into two refs so the render loop can route the ambient loop
  // to the matching sample: 종이 → paper channel (Sprink.mp3), 플라스틱
  // → plastic channel (Spang.mp3). Only one is unmuted at a time.
  const paperActiveRef = useRef<boolean>(false)
  const plasticActiveRef = useRef<boolean>(false)
  useEffect(() => {
    const active = sprinkles.paper.fill
    const kind = sprinkles.paper.kind ?? 'paper'
    paperActiveRef.current = active && kind === 'paper'
    plasticActiveRef.current = active && kind === 'plastic'
  }, [sprinkles])

  // Track the controls block's live height so the render loop can gently
  // shift the slime upward + shrink it whenever the panel expands into
  // a category. Height 0 (root panel) leaves the slime at rest position.
  useEffect(() => {
    const el = controlsRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        controlsHeightRef.current = e.contentRect.height
      }
    })
    ro.observe(el)
    // Seed with the current measurement so the first frame isn't zero.
    controlsHeightRef.current = el.getBoundingClientRect().height
    return () => ro.disconnect()
  }, [])

  // Start camera on mount — gated on `skeletonOn`. When hand tracking
  // is off the whole pipeline stays dormant: no getUserMedia call, no
  // permission prompt, no NPU/CPU cost. Toggling on/off automatically
  // reruns this effect thanks to the dep array, so cleanup safely
  // stops the previous stream when the user disables tracking.
  // Resolution capped at 480×360 @ 30fps — MediaPipe hand landmarker
  // is designed for low-res input, and the video is never rendered
  // to the user (only landmarks in normalized coords), so smaller
  // frames just reduce ISP + palm-detector cost with no visual impact.
  useEffect(() => {
    if (!skeletonOn) {
      setCameraStatus('idle')
      return
    }
    let stream: MediaStream | null = null
    let cancelled = false
    ;(async () => {
      setCameraStatus('requesting')
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'user',
            width: { ideal: 480 },
            height: { ideal: 360 },
            frameRate: { ideal: 30, max: 30 }
          },
          audio: false
        })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        const video = videoRef.current
        if (!video) return
        video.srcObject = stream
        await video.play()
        setCameraStatus('ready')
      } catch (e) {
        console.error(e)
        setCameraError(e instanceof Error ? e.message : String(e))
        setCameraStatus('error')
      }
    })()
    return () => {
      cancelled = true
      stream?.getTracks().forEach((t) => t.stop())
      const video = videoRef.current
      if (video) video.srcObject = null
    }
  }, [skeletonOn])

  // Three.js scene + render loop.
  useEffect(() => {
    const canvas = canvasRef.current
    const video = videoRef.current
    if (!canvas || !video) return

    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
      // Keep the WebGL back buffer readable after render so the
      // collection save can toDataURL() an accurate thumbnail on
      // the same frame the user hits Save. Without this, mobile
      // browsers clear the buffer post-swap and the readback is
      // an empty transparent bitmap.
      preserveDrawingBuffer: true
    })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.05

    const scene = new THREE.Scene()

    // Procedural studio environment map — dramatically improves reflections on
    // clearcoat / metallic surfaces (slime + beads) without shipping an HDR.
    const pmrem = new THREE.PMREMGenerator(renderer)
    // Blur factor 0.14 (was 0.04) softens the sharp bright rectangles
    // baked into RoomEnvironment — otherwise on the highly-transmissive
    // pearl slime they reflect as tiny "particle" specks that read as
    // stray glitter to the eye.
    const envTex = pmrem.fromScene(new RoomEnvironment(), 0.14).texture
    scene.environment = envTex

    const camera = new THREE.PerspectiveCamera(
      CAMERA_FOV,
      canvas.clientWidth / canvas.clientHeight,
      0.1,
      50
    )
    camera.position.set(0, 0, CAMERA_Z)
    camera.lookAt(0, 0, 0)

    // Lighting: soft rim + key.
    const hemi = new THREE.HemisphereLight(0xfff2f8, 0x3a2a55, 0.9)
    scene.add(hemi)
    const key = new THREE.DirectionalLight(0xffe6ef, 1.6)
    key.position.set(2.5, 3, 3.5)
    scene.add(key)
    const rim = new THREE.DirectionalLight(0x88bfff, 0.7)
    rim.position.set(-3, -1, 2)
    scene.add(rim)

    // Background glow orb behind sphere for depth. Colour is set from
    // the current theme (dark → #1a1130 purple; light → #e5deec pale
    // lavender) and re-tinted whenever the user flips the theme via the
    // drawer switch, so the WebGL scene stops flashing dark inside a
    // light-mode UI.
    const bgMaterial = new THREE.MeshBasicMaterial({
      color: theme === 'light' ? 0xe5deec : 0x000000,
      side: THREE.BackSide
    })
    const bg = new THREE.Mesh(new THREE.SphereGeometry(4, 32, 32), bgMaterial)
    scene.add(bg)

    const slime = new SlimeSphere()
    scene.add(slime.mesh)

    const beadsLayer = new BeadsLayer()
    slime.mesh.add(beadsLayer.group)
    // Share slime's ink uniforms with the bead wrap-shell so ink marble
    // swirls also render ON TOP of every bead — otherwise beads occlude the
    // slime beneath and you'd see swirls only in the gaps. One slime.setInk()
    // call updates both layers because the wrap holds the same uniform refs.
    const inkUniforms = slime.getInkUniforms()
    beadsLayer.setInkUniforms(
      inkUniforms.colorUniform,
      inkUniforms.amountUniform
    )
    // Same trick for the slime's multi-colour gradient — the wrap-shell
    // covers most of the slime under compact-fill beads, so without
    // sharing the gradient uniforms the wrap would flat-tint with only
    // colours[0] and the whole layer would read monotone.
    const gradientUniforms = slime.getGradientUniforms()
    beadsLayer.setSlimeGradientUniforms(
      gradientUniforms.useUniform,
      gradientUniforms.texUniform,
      gradientUniforms.radiusUniform
    )
    // Share the matte-material flag so bead wrap shells render the
    // same darker-tone foam pattern the slime body does. Otherwise
    // compact-fill layers on a matte slime hide the foam behind
    // opaque wrap shells and the aerated look disappears.
    beadsLayer.setMatteFoamUniform(slime.getMatteFoamUniform())

    // Second BeadsLayer instance dedicated to 속슬라임 — mirrors the
    // main bead layer's slime-uniform wiring so its wrap shell picks
    // up the same ink / gradient / matte foam. Its per-frame update
    // additionally runs a soft compress-on-press pass so the inner
    // chunk visibly squishes when the slime is pressed.
    // useSlimeMaterials → resolve config.material against the slime
    // MATERIALS palette (crystal / glossy / matte / metal) instead of the
    // bead-specific presets, so 슬라임볼 shares the outer slime's material
    // picker. Regular bead layers stay on the plastic / crystal presets.
    const innerBeadsLayer = new BeadsLayer({ useSlimeMaterials: true })
    slime.mesh.add(innerBeadsLayer.group)
    innerBeadsLayer.setInkUniforms(
      inkUniforms.colorUniform,
      inkUniforms.amountUniform
    )
    innerBeadsLayer.setSlimeGradientUniforms(
      gradientUniforms.useUniform,
      gradientUniforms.texUniform,
      gradientUniforms.radiusUniform
    )
    innerBeadsLayer.setMatteFoamUniform(slime.getMatteFoamUniform())

    // Two independent SprinklesLayers so paper + powder can render together.
    // Each takes a type-specific slice of SprinklesConfig. Ink is a shader
    // effect, not a layer — routed straight to slime.setInk.
    const paperLayer = new SprinklesLayer()
    const powderLayer = new SprinklesLayer()
    slime.mesh.add(paperLayer.group)
    slime.mesh.add(powderLayer.group)

    const emojiBeadsLayer = new EmojiBeadsLayer()
    slime.mesh.add(emojiBeadsLayer.group)

    // 커스텀비즈 — additive layer of coloured 3D bead meshes placed on
    // the front hemisphere. Physics is a simple snap-to-nearest-vertex
    // (like emoji beads) so beads follow slime deformation without
    // touching the main bead layer's InstancedMesh state.
    const customBeadsLayer = new CustomBeadsLayer()
    slime.mesh.add(customBeadsLayer.group)

    // Prime the ghost + bead-lift to match the initial React state — the
    // state-tracking useEffect above fires BEFORE this scene effect on
    // first mount (applyRef.current is still null), so without priming a
    // fresh crystal-slime mount would keep both off and buried emojis
    // wouldn't be visible until the user touched a picker.
    {
      const beadsActive =
        beads.combo !== 'none' && (beads.fill || beads.count > 0)
      const slimeCrystal = material === 'crystal'
      emojiBeadsLayer.setGhostVisible(slimeCrystal)
      emojiBeadsLayer.setBeadLift(beadsActive ? beads.size + 0.05 : 0)
    }

    // Push the slime's current surface look onto the bead wrap-shell so it
    // always matches (matte slime → matte wrap; crystal → transparent wrap;
    // wax → clearcoat + accent sheen). Called after any slime setter.
    const syncBeadWrap = () => {
      const params = slime.getSurfaceParams()
      beadsLayer.syncWrapToSlime(params)
      // Inner-slime layer's wrap also needs the slime-surface params —
      // otherwise its wrap material stays on the MeshPhysicalMaterial
      // defaults (opaque white) and a crystal 슬라임볼's wrap reads
      // as a solid white ball instead of a transparent slime jacket.
      innerBeadsLayer.syncWrapToSlime(params)
    }

    // Expose imperative setters so React effects can push customization changes
    // without tearing down the scene.
    applyRef.current = {
      setColors: (v) => {
        slime.setColors(v)
        syncBeadWrap()
      },
      setMaterial: (v) => {
        slime.setMaterial(v)
        syncBeadWrap()
      },
      // Coating internally toggles crack rendering for wax and wipes damage
      // when switching to `none`, so no external branching needed here.
      // 왁스비즈: SlimeSphere handles the shell body + rim-darkening
      // depth fake in the shader; no external layer wiring needed.
      setCoating: (v) => {
        slime.setCoating(v)
        syncBeadWrap()
      },
      setWaxThicknessAlpha: (a) => {
        slime.setWaxThicknessAlpha(a)
      },
      setCrunchOn: (on) => {
        slime.setCrunchOn(on)
      },
      setCoatingColors: (hexes) => {
        // Hexes are pre-resolved at the state layer from the correct
        // palette (COLORS for wax / ice, COATING_COLORS for foil). One
        // hex → flat tint; 2+ → gradient across the coating.
        slime.setCoatingColors(hexes)
        syncBeadWrap()
      },
      setShape: (v) => {
        slime.setShape(v)
        beadsLayer.reseat(
          slime.unitDirsArray,
          slime.restPositionArray,
          slime.shape
        )
        innerBeadsLayer.reseat(
          slime.unitDirsArray,
          slime.restPositionArray,
          slime.shape
        )
        const shapeInfluence = beadsLayer.computeBeadInfluence(
          slime.unitDirsArray
        )
        slime.setBeadInfluence(
          shapeInfluence,
          beadsLayer.currentConfig.size,
          shapeInfluence !== null && beadsLayer.currentConfig.combo === 'chunk'
        )
        paperLayer.reseat(
          slime.unitDirsArray,
          slime.restPositionArray,
          slime.indexArray,
          currentBeadInfo()
        )
        powderLayer.reseat(
          slime.unitDirsArray,
          slime.restPositionArray,
          slime.indexArray,
          currentBeadInfo()
        )
        emojiBeadsLayer.reseat(slime.unitDirsArray)
        customBeadsLayer.reseat(slime.unitDirsArray)
      },
      setBeads: (v) => {
        beadsLayer.setConfig(
          v,
          slime.unitDirsArray,
          slime.restPositionArray,
          slime.shape
        )
        // Custom beads read their outward-offset boost from this flag
        // so they only rise ABOVE a full-fill compact shell when one
        // actually exists — naked-slime custom beads stay flush.
        customBeadsLayer.setFillLayerActive(
          v.combo === 'compact' &&
            v.fill &&
            v.colors.length > 0 &&
            v.shapes.length > 0
        )
        // Push per-vertex nearest-bead directions into the slime so its
        // vertex shader taffy-stretches around each bead — turns the
        // hard bead-through-flat-surface intersection into a wrapped
        // slime bulge that follows the bead outline.
        // Taffy bulge is gated on the CHUNK combo — big-few beads sunk
        // into the slime look right with the metaball wrap, while the
        // compact combo (small beads packed everywhere) would get
        // redundant bumps across an already-covered sphere.
        const beadInfluence = beadsLayer.computeBeadInfluence(
          slime.unitDirsArray
        )
        // Taffy wrap is a chunk-only effect, but the single-bead 속비즈
        // preset (chunk + count 1) skips it too — that bead is placed
        // at the slime ORIGIN (fully embedded), so wrapping the slime
        // around it would just bulge the whole surface outward instead
        // of accenting a surface bead.
        const wrapActive =
          beadInfluence !== null &&
          v.combo === 'chunk' &&
          !(v.combo === 'chunk' && v.count === 1)
        slime.setBeadInfluence(beadInfluence, v.size, wrapActive)
        // Chunk combo always fades the slime body to ~85% opacity
        // (15% fade) — a subtle knock-back so beads read cleaner
        // without being buried in the soft slime body, while the
        // slime stays visible enough to still frame the cluster.
        // Independent of bead size / count.
        slime.setBodyOpacity(v.combo === 'chunk' ? 0.85 : 1)
        // Bead layout changed → rebuild sprinkle bead-lift so freshly placed
        // sprinkles ride on top of the new bead positions.
        paperLayer.reseat(
          slime.unitDirsArray,
          slime.restPositionArray,
          slime.indexArray,
          currentBeadInfo()
        )
        powderLayer.reseat(
          slime.unitDirsArray,
          slime.restPositionArray,
          slime.indexArray,
          currentBeadInfo()
        )
        // 슬라임 안 — bead cores drop deep (compact scale) while their
        // wrap-shells hang closer to the surface (compactWrap scale) so
        // the slime keeps a soft bead-textured skin AND the actual bead
        // cores sit clearly separated behind that skin. Chunk stays
        // surface-anchored (its whole vibe is big beads sitting on the
        // slime), so the guard keeps the toggle scoped to the compact
        // primary chip that owns the button.
        const insideOn = v.combo === 'compact' && v.inside
        beadsLayer.setInsideScale(
          insideOn ? INSIDE_SCALE.compact : 1,
          insideOn ? INSIDE_SCALE.compactWrap : 1
        )
      },
      setSprinkles: (v) => {
        // Paper + powder feed independent SprinklesLayers so both render
        // simultaneously when the user activates them together. Each layer
        // takes a flat SprinklesLayerConfig — powder's paper-only fields
        // (size / shape / fill) are stubbed with defaults since the powder
        // renderer ignores them, but they still need to satisfy the type.
        paperLayer.setConfig(
          {
            type: 'paper',
            colors: v.paper.colors,
            count: v.paper.count,
            size: v.paper.size,
            shape: v.paper.shape,
            material: v.paper.material,
            fill: v.paper.fill,
            kind: v.paper.kind
          },
          slime.unitDirsArray,
          slime.restPositionArray,
          slime.indexArray,
          currentBeadInfo()
        )
        powderLayer.setConfig(
          {
            type: 'powder',
            colors: v.powder.colors,
            count: v.powder.count,
            size: 0.006,
            shape: 'dot',
            material: v.powder.material,
            fill: v.powder.fill
          },
          slime.unitDirsArray,
          slime.restPositionArray,
          slime.indexArray,
          currentBeadInfo()
        )
        // Ink stays a slime-shader effect (marble swirls). Zero it out when
        // the user hasn't picked any ink so switching between types leaves
        // no stale swirl behind. Amount uses the fixed inkAmountDivisor
        // so ink counts past 400 push amount ABOVE 1.0, widening the ink
        // area in the shader progressively.
        if (v.ink.count > 0) {
          // Map every picked colour id → hex so setInk can build a
          // multi-colour LUT. Single-colour ink still flat-tints;
          // 2+ colours paint distinct hues across the marble ribbon.
          const hexes = v.ink.colors
            .map(
              (cid) =>
                SPRINKLE_COLORS.find((c) => c.id === cid)?.hex ?? 0xffffff
            )
          const amount = Math.max(
            0,
            v.ink.count / SPRINKLES_LIMITS.inkAmountDivisor
          )
          slime.setInk(hexes.length > 0 ? hexes : [0xffffff], amount)
        } else {
          slime.setInk([0xffffff], 0)
        }
        // 슬라임 안 — same treatment as compact beads: shrink the spangle
        // group toward the slime origin so the pieces read as embedded.
        // Plastic spangles are much thicker than paper, so they need a
        // smaller factor to stay tucked behind the slime surface. Powder
        // stays surface-anchored (it's a dust coating, not an inclusion)
        // so we only touch the paperLayer group here.
        const spangleInsideScale =
          v.paper.kind === 'plastic'
            ? INSIDE_SCALE.spanglePlastic
            : INSIDE_SCALE.spangleFlat
        paperLayer.group.scale.setScalar(
          v.paper.inside ? spangleInsideScale : 1
        )
      },
      setEmojiBeads: (v) => {
        emojiBeadsLayer.setConfig(
          { emojis: v.emojis, size: v.size, count: v.count },
          slime.unitDirsArray
        )
        emojiBeadsLayer.group.scale.setScalar(
          v.inside ? INSIDE_SCALE.emoji : 1
        )
      },
      setEmojiGhost: (v) => emojiBeadsLayer.setGhostVisible(v),
      setEmojiBeadLift: (h) => emojiBeadsLayer.setBeadLift(h),
      setSceneBackground: (hex) => bgMaterial.color.setHex(hex),
      setEdgeTheme: (t) => slime.setEdgeTheme(t),
      setColorAdjustments: (adj) => {
        slime.setColorAdjustments(adj)
        beadsLayer.setColorAdjustments(adj)
        innerBeadsLayer.setColorAdjustments(adj)
        customBeadsLayer.setColorAdjustments(adj)
        paperLayer.setColorAdjustments(adj)
        powderLayer.setColorAdjustments(adj)
      },
      setPhotoDecal: (texture) => slime.setPhotoDecal(texture),
      setTextDecal: (texture) => slime.setTextDecal(texture),
      setTextColor: (hex) => slime.setTextColor(hex),
      setTextAxis: (ax, ay, az) => slime.setTextAxis(ax, ay, az),
      setTextAboveCoating: (above) => slime.setTextAboveCoating(above),
      hasTextDecal: () => slime.hasTextDecal(),
      setPhotoBeads: (textures) => beadsLayer.setPhotos(textures),
      setInnerSlime: (v) => {
        innerBeadsLayer.setConfig(
          v,
          slime.unitDirsArray,
          slime.restPositionArray,
          slime.shape
        )
        // Taffy wrap only for count >= 2 inner slime — mirrors main
        // chunk 비즈볼 behaviour where each surface bead gets its own
        // local bulge and the overall slime stays the same size. The
        // single-ball preset places its ball at the slime ORIGIN and
        // is visible through the translucent slime body, so no wrap
        // is needed (a uniform radial wrap would inflate the whole
        // slime with the ball's size, which the user didn't want).
        const outerActive =
          beadsLayer.currentConfig.combo === 'chunk' &&
          beadsLayer.currentConfig.count > 0
        if (!outerActive) {
          const enableWrap =
            v.combo === 'chunk' && v.count >= 2
          const inf = enableWrap
            ? innerBeadsLayer.computeBeadInfluence(slime.unitDirsArray)
            : null
          slime.setBeadInfluence(inf, v.size, inf !== null)
        }
      },
      setCustomBeads: (v) => {
        customBeadsLayer.setConfig(v, slime.unitDirsArray)
        customBeadsLayer.group.scale.setScalar(
          v.inside ? INSIDE_SCALE.customBeads : 1
        )
      },
      setCustomBeadsPhoto: (texture) => customBeadsLayer.setPhoto(texture),
      reset: () => {
        slime.reset()
        // Snap the slime back to its default orientation on any reset
        // (press-reset button or unified-tag reset) so the slime
        // returns to the same pose as a fresh mount, not whatever
        // rotation the user had spun it into. Kill any active
        // auto-spin timer too so the reset feels clean.
        slime.mesh.quaternion.identity()
        autoSpinUntilRef.current = 0
        // Wipe any accumulated per-bead crack damage — otherwise a
        // reset restores the slime shape but leaves coated chunk
        // beads visibly cracked from the previous press pass, which
        // reads as broken (user expects reset to fully un-crack the
        // coating too).
        beadsLayer.resetDamage()
        beadsLayer.reseat(
          slime.unitDirsArray,
          slime.restPositionArray,
          slime.shape
        )
        innerBeadsLayer.resetDamage()
        innerBeadsLayer.reseat(
          slime.unitDirsArray,
          slime.restPositionArray,
          slime.shape
        )
        paperLayer.reseat(
          slime.unitDirsArray,
          slime.restPositionArray,
          slime.indexArray,
          currentBeadInfo()
        )
        powderLayer.reseat(
          slime.unitDirsArray,
          slime.restPositionArray,
          slime.indexArray,
          currentBeadInfo()
        )
        emojiBeadsLayer.reseat(slime.unitDirsArray)
        customBeadsLayer.reseat(slime.unitDirsArray)
        // Restore the buried 슬라임볼 back to a round shape — dents are
        // monotonic during normal use (clay model), so the reset path
        // is the only place stored dents are wiped.
        clearBallDents()
      },
      captureCanonicalThumbnail: () => {
        // Snapshot mesh transform + all mutable physics/damage state
        // so we can reset to the "options-applied" baseline for the
        // capture, then restore whatever the user was actually doing
        // (mid-squish, rotated, etc.) without disturbing the live view.
        const savedScale = slime.mesh.scale.clone()
        const savedQuat = slime.mesh.quaternion.clone()
        const savedPos = slime.mesh.position.clone()
        const stateSnap = slime.snapshotMutableState()
        // 슬라임볼 dents live in the render-loop closure, not on the
        // BeadsLayer instance — snapshot & restore them locally so the
        // capture renders a round ball while the user's actual dents
        // survive after the shot. Same for the bulge accumulator.
        const savedBallDentDirs = ballDentDirs.map((v) => v.clone())
        const savedBallDentStrengths = new Float32Array(ballDentStrengths)
        const savedBallBulgeTime = ballBulgeTime
        // Hide the environment-tint background sphere for the capture
        // frame so the thumbnail is a true slime cutout on transparent
        // pixels — otherwise the sphere fills every non-slime pixel
        // with the theme's page tone and each thumbnail reads as a
        // painted rectangle behind the slime.
        const savedBgVisible = bg.visible
        bg.visible = false
        // Capture scale is chosen so every configuration fits inside
        // the thumbnail viewport regardless of whether the slime is
        // naked, packed with compact beads, or sprouting large chunk
        // 비즈볼 / 슬라임볼 chunks that extend past the slime surface.
        // Effective outer radius (in slime-local units):
        //   naked           → 1.15 (specular bloom bias)
        //   full compact    → 1 + compact bead size
        //   chunk beads     → 1 + 2 · chunk size (bead sits ON surface)
        //   inner slime     → 1 + 2 · inner size
        const beadsCfg = beadsLayer.currentConfig
        const innerCfg = innerBeadsLayer.currentConfig
        const hasFullBeadShell =
          beadsCfg.fill &&
          beadsCfg.shapes.length > 0 &&
          beadsCfg.colors.length > 0
        // Visible outer radius per configuration:
        //   full-fill compact → 1 + 2.2 · bead size (bead radius sits
        //       ON the surface so extends fully outward, plus specular
        //       halo). Earlier 1.4× estimate under-shot for larger
        //       bead sizes and the packed shell clipped in the
        //       thumbnail — bumped to 2.2× so 꽉비즈 saves stay inside
        //       the frame even at max size.
        //   chunk beads on surface (count ≥ 2) → 1 + 2 · bead size.
        //   inner slime count = 1 (centred inside) → contributes
        //       nothing to the silhouette; the slime itself is the
        //       outer bound, so we let effectiveOuter stay at 1.15.
        //   inner slime count ≥ 2 (surface layout) → 1 + 2 · bead size.
        const compactOuter = hasFullBeadShell ? 1 + 2.2 * beadsCfg.size : 0
        const chunkOuter =
          beadsCfg.combo === 'chunk' && beadsCfg.count >= 2
            ? 1 + 2 * beadsCfg.size
            : 0
        const innerOuter =
          innerCfg.combo === 'chunk' && innerCfg.count >= 2
            ? 1 + 2 * innerCfg.size
            : 0
        const effectiveOuter = Math.max(
          1.15,
          compactOuter,
          chunkOuter,
          innerOuter
        )
        // Target visible radius in the 200-px thumbnail. 0.68 gives
        // firm margins so even under-estimated silhouettes have room.
        const TARGET_VISIBLE = 0.68
        const captureScale = Math.min(0.7, TARGET_VISIBLE / effectiveOuter)
        slime.mesh.scale.setScalar(captureScale)
        slime.mesh.quaternion.identity()
        slime.mesh.position.set(0, 0, 0)
        // Undeformed rest shape — no crack, no squish — so the
        // saved thumbnail reads as the finished slime configuration.
        slime.reset()
        // Clear the buried-ball dents + bulge so a 슬라임볼 renders
        // round in the thumbnail (user press state is restored in
        // finally). Bead layers cache their instance matrices from
        // the LAST update() call — slime.reset() alone leaves them at
        // their pressed positions.
        clearBallDents()
        // Fully re-seat every bead / sprinkle layer against the reset
        // slime so 꽉비즈 (fill-mode + grid-mode compact beads) and
        // sprinkles snap to their pre-press layout, then run update()
        // with restPositionArray to guarantee bead matrices are baked
        // from rest coords — plain update(positionArray) alone left
        // some fill/grid caches carrying deformed anchors from the
        // last live frame.
        beadsLayer.reseat(
          slime.unitDirsArray,
          slime.restPositionArray,
          slime.shape
        )
        innerBeadsLayer.reseat(
          slime.unitDirsArray,
          slime.restPositionArray,
          slime.shape
        )
        paperLayer.reseat(
          slime.unitDirsArray,
          slime.restPositionArray,
          slime.indexArray,
          currentBeadInfo()
        )
        powderLayer.reseat(
          slime.unitDirsArray,
          slime.restPositionArray,
          slime.indexArray,
          currentBeadInfo()
        )
        emojiBeadsLayer.reseat(slime.unitDirsArray)
        customBeadsLayer.reseat(slime.unitDirsArray)
        beadsLayer.update(slime.restPositionArray, 0, null)
        innerBeadsLayer.update(slime.restPositionArray, 0, null)
        paperLayer.update(slime.restPositionArray, slime.normalArray)
        powderLayer.update(slime.restPositionArray, slime.normalArray)
        emojiBeadsLayer.update(slime.restPositionArray, slime.restPositionArray)
        customBeadsLayer.update(slime.restPositionArray)
        try {
          renderer.render(scene, camera)
          const src = canvas
          const SIZE = 200
          const off = document.createElement('canvas')
          off.width = SIZE
          off.height = SIZE
          const ctx = off.getContext('2d')
          if (!ctx) return undefined
          const side = Math.min(src.width, src.height)
          const sx = (src.width - side) * 0.5
          const sy = (src.height - side) * 0.5
          ctx.drawImage(src, sx, sy, side, side, 0, 0, SIZE, SIZE)
          // Chroma-key the near-black envelope that WebGL's
          // premultiplied-alpha compositing bleeds around the slime
          // silhouette. Any pixel that's essentially black AND semi-
          // or fully transparent gets pushed to fully transparent so
          // the exported PNG really is a background-less cutout.
          const px = ctx.getImageData(0, 0, SIZE, SIZE)
          const d = px.data
          for (let i = 0; i < d.length; i += 4) {
            const r = d[i]
            const g = d[i + 1]
            const b = d[i + 2]
            const a = d[i + 3]
            if (a < 250 && r < 24 && g < 24 && b < 24) {
              d[i + 3] = 0
            }
          }
          ctx.putImageData(px, 0, 0)
          return off.toDataURL('image/png')
        } catch {
          return undefined
        } finally {
          slime.mesh.scale.copy(savedScale)
          slime.mesh.quaternion.copy(savedQuat)
          slime.mesh.position.copy(savedPos)
          slime.restoreMutableState(stateSnap)
          bg.visible = savedBgVisible
          // Restore the buried-ball dent + bulge state we cleared for
          // the capture so the live view keeps whatever the user was
          // pressing. Push everything back to the shader uniforms in
          // one shot; the RAF loop will keep re-pushing on subsequent
          // frames anyway, but this keeps the immediate render below
          // consistent instead of flashing a round ball for one frame.
          for (let i = 0; i < ballDentCap; i++) {
            ballDentDirs[i].copy(savedBallDentDirs[i])
            ballDentStrengths[i] = savedBallDentStrengths[i]
          }
          ballBulgeTime = savedBallBulgeTime
          pushBallDentsToShader()
          let _anyDent = 0
          for (let i = 0; i < ballDentCap; i++) {
            if (ballDentStrengths[i] > _anyDent) _anyDent = ballDentStrengths[i]
          }
          innerBeadsLayer.setBallDentEnabled(_anyDent > 0)
          innerBeadsLayer.setBallBulgeAmount(ballBulgeTime)
          // Re-seat bead / sprinkle layers to the restored slime
          // positions so they resume tracking whatever squish the
          // user is holding, rather than staying frozen at rest.
          beadsLayer.update(slime.positionArray, 0, null)
          innerBeadsLayer.update(slime.positionArray, 0, null)
          paperLayer.update(slime.positionArray, slime.normalArray)
          powderLayer.update(slime.positionArray, slime.normalArray)
          emojiBeadsLayer.update(slime.positionArray, slime.restPositionArray)
          customBeadsLayer.update(slime.positionArray)
          // Render again with restored transform so the next frame
          // draws from the correct state (the RAF loop would do this
          // anyway but a manual render keeps the display seamless).
          renderer.render(scene, camera)
        }
      }
    }
    // Prime the wrap cache with the initial slime look so the very first
    // bead set-up already spawns wraps matching the slime — without this,
    // wraps briefly render with hardcoded defaults until the user changes
    // a slime setting.
    syncBeadWrap()
    // Prime text tint from current state so first frame renders the
    // correct colour before React fires its re-render for the
    // always-on `setTextColor` effect above.
    slime.setTextColor(
      resolveColorHex(slimeTextRef.current.color, colorAdjustments)
    )

    function currentBeadInfo() {
      const cfg = beadsLayer.currentConfig
      const active = cfg.fill || cfg.count > 0
      if (!active) return null
      const positions = beadsLayer.getBeadRestPositions(
        slime.unitDirsArray,
        slime.restPositionArray
      )
      if (positions.length === 0) return null
      // Ship per-bead outer radii so sprinkles / powder attach to the
      // ACTUAL bead silhouette on non-sphere shapes (torus / star /
      // cube) — otherwise the ray-sphere approximation returns a
      // contact inside the visible envelope and sprinkles float free.
      const radii = beadsLayer.getBeadShapeRadii()
      return { positions, size: cfg.size, radii }
    }

    const overlay = overlayRef.current
    const overlayCtx = overlay?.getContext('2d') ?? null

    const resize = () => {
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      const dpr = Math.min(window.devicePixelRatio, 2)
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      if (overlay) {
        overlay.width = Math.round(w * dpr)
        overlay.height = Math.round(h * dpr)
      }
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)

    let raf = 0
    let lastTime = performance.now()
    let lastDetectMs = 0
    // Single-centered 슬라임볼 press-dent state. The buried ball can't
    // inherit the outer slime's per-vertex dent (it lives at slime
    // origin, which the physics never moves), so we mirror the slime's
    // local indentation via up to N shader dents — each dent is a
    // (direction, strength) pair that pushes the ball's vertex-shader
    // radius inward inside a soft cone. Persistent (clay model), reset
    // only by the reset button (see reset() closure).
    const ballDentCap = innerBeadsLayer.ballDentCapacity
    const ballDentDirs: THREE.Vector3[] = []
    for (let i = 0; i < ballDentCap; i++) {
      ballDentDirs.push(new THREE.Vector3(1, 0, 0))
    }
    const ballDentStrengths = new Float32Array(ballDentCap)
    // Coated 슬라임볼 gate — a coating turns the ball into a "hard
    // shell" that ignores idle finger contact. The user has to either
    // long-press the ball for ~0.5 s of continuous contact OR tap the
    // ball three separate times before the coating starts cracking and
    // the ball starts bulging. Uncoated balls skip the gate entirely
    // (any ball-touching tip immediately dents them, matching prior
    // behaviour). Every state below persists across frames within the
    // effect's closure and is wiped by clearBallDents() on reset.
    // Ball visual bulge accumulator — grows whenever ANY press is on
    // the slime (independent of the touch-through filter used for
    // dent + coating gating). Ensures the buried ball puffs immediately
    // when the outer slime starts deforming so it never appears to
    // shrink relative to the growing slime silhouette. Monotonic (clay
    // model) — only cleared by the reset button.
    let ballBulgeTime = 0
    const pushBallDentsToShader = () => {
      for (let i = 0; i < ballDentCap; i++) {
        innerBeadsLayer.setBallDent(
          i,
          ballDentDirs[i].x,
          ballDentDirs[i].y,
          ballDentDirs[i].z,
          ballDentStrengths[i]
        )
      }
    }
    const clearBallDents = () => {
      for (let i = 0; i < ballDentCap; i++) {
        ballDentStrengths[i] = 0
        ballDentDirs[i].set(1, 0, 0)
      }
      pushBallDentsToShader()
      innerBeadsLayer.setBallDentEnabled(false)
      ballBulgeTime = 0
      innerBeadsLayer.setBallBulgeAmount(0)
      ballCoatSoundHoldMs = 0
    }
    // Scratch buffer for tips that actually engage the ball this frame.
    // Reused across frames — the coating-damage call and the dent-
    // accumulation loop both consume it after gating.
    const innerTouchTips: WeightedTip[] = []
    // Frame-scoped flag: is the buried ball currently reacting to press?
    // Set inside the isBuriedBall block based on ANY tip on the slime
    // (or a recent ball touch — see ballCoatSoundHoldMs). Sound routing
    // reads this so the coating hiss doesn't stutter when the strict
    // touch-through filter drops tips mid-press, and stays audible
    // for the natural fall-off after a brief tap.
    let ballSoundActiveThisFrame = false
    // Hold timer for the ball's coating sound — sustains the crack
    // channel for a short tail after the last touching tip disappears
    // so brief taps produce audible sound instead of a millisecond
    // blip that gets swallowed by the sample's fade-in / fade-out.
    let ballCoatSoundHoldMs = 0
    const BALL_COAT_SOUND_HOLD = 700
    const localTips: WeightedTip[] = []
    const inv = new THREE.Matrix4()
    const raycaster = new THREE.Raycaster()
    const _ndc = new THREE.Vector2()
    const _worldPos = new THREE.Vector3()
    const _closest = new THREE.Vector3()
    const _center = new THREE.Vector3()
    const _restSphere = new THREE.Sphere()
    let latestHands: readonly Landmark[][] = []

    // Gesture state (persists across frames).
    let rotVelX = 0
    let rotVelY = 0
    let currentScale = sizeRef.current
    // Live-eased slime offset + shrink driven by the controls block's
    // height. Written each frame from controlsHeightRef so the sphere
    // glides up and slightly shrinks when a category opens, avoiding
    // overlap with the panel below without a hard jump.
    let currentPanelShiftY = 0
    let currentPanelScale = 1

    // Emoji-selection state. Clicking an emoji SELECTS it (blue glow on
    // + drag mode active); clicking the same emoji AGAIN deselects it.
    // Selection PERSISTS across pointerup — the glow only clears when
    // the user explicitly re-clicks the sprite. Drag runs while a
    // pointer is held on the selected emoji: pointer moves reposition
    // the sprite; releasing the pointer just ends the current drag but
    // keeps the selection lit.
    let selectedEmojiIndex = -1
    // Custom-bead drag — reuses emojiMoveOn as its enter/exit mode.
    // -1 means no bead is currently being dragged this pointer session.
    let selectedCustomBeadIndex = -1
    let dragPointerId = -1
    const ndc = new THREE.Vector2()
    const localHit = new THREE.Vector3()

    // Sound trigger state.
    let smoothedPressure = 0
    // Minimum-hold window for tap sounds. After the smoothed pressure
    // peaks (rising-edge tap), hold that peak level for a short window
    // so a brief tap has enough sustained playback to be audible —
    // otherwise the fade-in envelope + immediate release would cut a
    // 100 ms tap off before Wak.mp3 / etc. finish attacking.
    let soundHoldTimer = 0
    let soundHoldLevel = 0
    // Long enough for one full iteration of the wax / matte / metal /
    // paper loops to be heard end-to-end on a single tap — otherwise
    // a 100 ms tap only played a small slice and sounded nothing like
    // the sustained long-press version.
    const SOUND_HOLD_MS = 1100

    const ROT_SENS = 5.5 // radians per full-screen normalized delta
    const clamp = (v: number, a: number, b: number) =>
      v < a ? a : v > b ? b : v

    // Screen-touch gestures:
    //   1 finger  → PRESS (long-press supported — every frame the pointer
    //               is down adds a fingertip contact via the render loop).
    //   2 fingers → ROTATE (movement of the two-finger midpoint spins
    //               the slime) + ZOOM (pinch distance change scales it).
    // Both two-finger actions run simultaneously so a natural pinch-and-
    // twist gesture does both at once.
    const activePointers = new Map<
      number,
      {
        x: number
        y: number
        prevX: number
        prevY: number
        /** ms timestamp of the pointerdown that created this entry.
         *  Combined with drag distance in the render loop to ramp the
         *  press force — a quick tap stays light, a long-press or drag
         *  builds up pressure like squeezing harder. */
        startTime: number
        /** Accumulated pixel travel since pointerdown. Grows every
         *  move event; contributes to press strength alongside time. */
        dragDist: number
        /** True if this pointer was part of a two-finger pinch gesture
         *  at some point. Marked when a second pointer joins; stays
         *  true until this pointer is released. Press physics skip
         *  pointers with this flag so lifting one finger after a
         *  pinch doesn't smoosh the slime with the remaining finger. */
        pinchTouched: boolean
      }
    >()
    let pinchStartDist = 0
    let pinchStartScale = 1
    let twoFingerCenterX = 0
    let twoFingerCenterY = 0
    const container = canvas.parentElement as HTMLElement | null

    const pinchDistance = () => {
      const pts = Array.from(activePointers.values())
      const dx = pts[0].x - pts[1].x
      const dy = pts[0].y - pts[1].y
      return Math.hypot(dx, dy)
    }
    const pinchCenter = () => {
      const pts = Array.from(activePointers.values())
      return {
        x: (pts[0].x + pts[1].x) / 2,
        y: (pts[0].y + pts[1].y) / 2
      }
    }
    // Map a PointerEvent's client coords into normalised device coords
    // for the raycaster.
    const pointerToNDC = (e: PointerEvent) => {
      const r = container?.getBoundingClientRect()
      if (!r) return false
      ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1
      ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1
      return true
    }
    // Pick an emoji sprite under this pointer, if any. Used on
    // pointerdown to decide between select-toggle and normal gesture.
    const pickEmojiSprite = (e: PointerEvent): number => {
      if (!pointerToNDC(e)) return -1
      raycaster.setFromCamera(ndc, camera)
      const sprites = emojiBeadsLayer.getSprites()
      if (sprites.length === 0) return -1
      const hits = raycaster.intersectObjects(sprites as THREE.Sprite[])
      if (hits.length === 0) return -1
      const hit = hits[0].object as THREE.Sprite
      return sprites.indexOf(hit)
    }
    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return
      // First user gesture unlocks the AudioContext on Safari/iOS. Samples
      // themselves are fetched at component mount (see the useEffect that
      // calls loadSquishSamples), so they're ready by the time we resume.
      soundRef.current?.resume()
      // Ignore touches that start on the HUD (slider, toggle) — otherwise
      // dragging them would trigger sphere rotation / pinch anchor.
      const target = e.target as HTMLElement | null
      if (target?.closest('[data-hud]')) return
      // Emoji click handling — only in emoji-move mode. Outside the
      // mode, taps on the slime should always be presses, never
      // accidentally selecting an emoji sprite. Behaviour when the
      // mode is on:
      //  • clicking a NOT-selected emoji  → select it (glow ON) + start
      //    drag on this pointer,
      //  • clicking the ALREADY-selected  → deselect (glow OFF), no drag.
      if (emojiMoveOnRef.current && activePointers.size === 0) {
        const spriteIdx = pickEmojiSprite(e)
        if (spriteIdx >= 0) {
          if (spriteIdx === selectedEmojiIndex) {
            selectedEmojiIndex = -1
            dragPointerId = -1
            emojiBeadsLayer.setSelected(null)
          } else {
            selectedEmojiIndex = spriteIdx
            dragPointerId = e.pointerId
            emojiBeadsLayer.setSelected(spriteIdx)
          }
          return
        }
        // No emoji hit — try picking a custom bead. Same "move mode"
        // enables dragging both accessory types with one toggle so
        // the UI doesn't need a separate custom-bead move switch.
        if (pointerToNDC(e)) {
          raycaster.setFromCamera(ndc, camera)
          const beadIdx = customBeadsLayer.pickBead(raycaster)
          if (beadIdx >= 0) {
            selectedCustomBeadIndex = beadIdx
            dragPointerId = e.pointerId
            return
          }
        }
      }
      activePointers.set(e.pointerId, {
        x: e.clientX,
        y: e.clientY,
        prevX: e.clientX,
        prevY: e.clientY,
        startTime: performance.now(),
        dragDist: 0,
        pinchTouched: false
      })
      if (activePointers.size === 2) {
        // Entering two-finger mode — anchor both pinch scale and rotate
        // center. Subsequent moves compute deltas against these anchors.
        pinchStartDist = pinchDistance()
        pinchStartScale = sizeRef.current
        const c = pinchCenter()
        twoFingerCenterX = c.x
        twoFingerCenterY = c.y
        // Two-finger pinch overrides any in-flight single-finger press.
        // Snap sound + smoothed pressure to 0 immediately so the user
        // doesn't hear leftover Wak/foil while pinching, and zero the
        // slime's per-vertex velocity so the current dent stops
        // deepening (existing dent stays — kneading persists).
        smoothedPressure = 0
        soundHoldLevel = 0
        soundHoldTimer = 0
        slime.stopMotion()
        // Mark BOTH active pointers as pinch-touched so lifting one
        // finger (returning to size 1) doesn't let the remaining
        // finger's press physics kick in — a "pinch release" should
        // never turn into a slime press mid-gesture.
        for (const p of activePointers.values()) {
          p.pinchTouched = true
        }
      }
    }
    const onPointerMove = (e: PointerEvent) => {
      // Emoji-drag path — while a selected emoji's pointer is being
      // held, every move re-anchors that sprite onto the vertex under
      // the pointer. Other gesture handling is skipped for this event.
      if (
        selectedEmojiIndex >= 0 &&
        e.pointerId === dragPointerId
      ) {
        if (pointerToNDC(e)) {
          raycaster.setFromCamera(ndc, camera)
          const hits = raycaster.intersectObject(slime.mesh, false)
          if (hits.length > 0) {
            localHit.copy(hits[0].point)
            slime.mesh.worldToLocal(localHit)
            const vi = emojiBeadsLayer.findClosestVertex(
              localHit.x,
              localHit.y,
              localHit.z,
              slime.unitDirsArray
            )
            emojiBeadsLayer.moveSprite(selectedEmojiIndex, vi)
          }
        }
        return
      }
      // Custom-bead drag — same shape as emoji drag but re-seats the
      // bead's anchor direction on the slime surface via CustomBeads
      // Layer.setBeadDir instead of moving a sprite.
      if (
        selectedCustomBeadIndex >= 0 &&
        e.pointerId === dragPointerId
      ) {
        if (pointerToNDC(e)) {
          raycaster.setFromCamera(ndc, camera)
          const hits = raycaster.intersectObject(slime.mesh, false)
          if (hits.length > 0) {
            localHit.copy(hits[0].point)
            slime.mesh.worldToLocal(localHit)
            const len = localHit.length() || 1
            localHit.multiplyScalar(1 / len)
            customBeadsLayer.setBeadDir(
              selectedCustomBeadIndex,
              localHit,
              slime.unitDirsArray
            )
          }
        }
        return
      }

      const p = activePointers.get(e.pointerId)
      if (!p) return
      p.prevX = p.x
      p.prevY = p.y
      p.x = e.clientX
      p.y = e.clientY
      // Accumulate pixel travel for the press-strength ramp. Only useful
      // in single-pointer mode (two-finger gestures are rotate/zoom), but
      // the small cost is worth avoiding an extra branch.
      p.dragDist += Math.hypot(p.x - p.prevX, p.y - p.prevY)

      if (activePointers.size === 2 && pinchStartDist > 0) {
        // Zoom from distance change (pinch open/close).
        const d = pinchDistance()
        sizeRef.current = clamp(
          pinchStartScale * (d / pinchStartDist),
          SCALE_MIN,
          SCALE_MAX
        )
        // Rotate from midpoint drift (both fingers moving together).
        // Delta is measured against the previous frame's centre and
        // fed into the same rotation-velocity accumulator that hand
        // tracking uses, so the spin feels identical.
        const c = pinchCenter()
        const w = container?.clientWidth || window.innerWidth
        const h = container?.clientHeight || window.innerHeight
        const ref = Math.min(w, h) || 1
        const dx = (c.x - twoFingerCenterX) / ref
        const dy = (c.y - twoFingerCenterY) / ref
        rotVelY += dx * ROT_SENS
        rotVelX += dy * ROT_SENS
        twoFingerCenterX = c.x
        twoFingerCenterY = c.y
      }
      // Single-pointer moves do NOT rotate — pressing while dragging just
      // keeps adding fingertip contacts at the new position. Rotation is
      // exclusively the two-finger midpoint drift.
    }
    const onPointerUp = (e: PointerEvent) => {
      // End the current drag but KEEP the emoji selected — the glow
      // stays lit until the user explicitly re-clicks the sprite. That
      // way a released drag can be reviewed visually before deselecting.
      if (e.pointerId === dragPointerId) {
        dragPointerId = -1
        // Custom-bead drag doesn't have a persistent selection state
        // (no visual glow), so releasing the pointer fully drops the
        // handle. Emoji sprite selection is managed separately above.
        selectedCustomBeadIndex = -1
        return
      }
      activePointers.delete(e.pointerId)
      if (activePointers.size < 2) {
        pinchStartDist = 0
      }
    }

    container?.addEventListener('pointerdown', onPointerDown)
    container?.addEventListener('pointermove', onPointerMove)
    container?.addEventListener('pointerup', onPointerUp)
    container?.addEventListener('pointercancel', onPointerUp)
    container?.addEventListener('pointerleave', onPointerUp)

    // Desktop zoom: mouse wheel scrolls, macOS/Chrome trackpad pinch fires
    // wheel events with ctrlKey === true. Handle both in one place. We
    // preventDefault to stop the browser from scaling the whole page.
    const onWheel = (e: WheelEvent) => {
      const target = e.target as HTMLElement | null
      if (target?.closest('[data-hud]')) return
      e.preventDefault()
      // Trackpad pinch (macOS) and Ctrl+wheel (Windows) both fire wheel
      // events with ctrlKey=true — use those for ZOOM. All other wheel
      // events (touchpad two-finger drag, mouse-wheel scroll) become
      // ROTATION so trackpad users get the same two-finger-rotate as
      // touchscreen users. Mouse-wheel users can hold Ctrl to zoom.
      if (e.ctrlKey || e.metaKey) {
        // Trackpad pinch reports much finer deltaY — bump the factor so
        // it still feels responsive.
        sizeRef.current = clamp(
          sizeRef.current * Math.exp(-e.deltaY * 0.014),
          SCALE_MIN,
          SCALE_MAX
        )
      } else {
        // Two-finger drag on a trackpad → rotation. Uses the same
        // sensitivity model as pointer-drag on touchscreens so the feel
        // matches: delta measured as fraction of the smaller viewport
        // dimension, scaled by ROT_SENS.
        const w = container?.clientWidth || window.innerWidth
        const h = container?.clientHeight || window.innerHeight
        const ref = Math.min(w, h) || 1
        rotVelY += (e.deltaX / ref) * ROT_SENS
        rotVelX += (e.deltaY / ref) * ROT_SENS
      }
    }
    container?.addEventListener('wheel', onWheel, { passive: false })

    // Map a landmark's normalized VIDEO coordinate (its natural aspect
    // ratio) to a normalized SCREEN coordinate that preserves the hand's
    // true aspect ratio without letting it fill the whole canvas (cover)
    // or shrink into a tiny letterbox strip (contain). Uses `contain`
    // semantics + a uniform scale factor around center — the hand stays
    // aspect-correct AND at a comfortable visible size.
    const HAND_SCALE = 1.8
    const mapVidToScreen = (
      lx: number,
      ly: number
    ): [number, number] => {
      const vw = video.videoWidth
      const vh = video.videoHeight
      if (!vw || !vh) return [lx, ly]
      const canvasAspect = (canvas.clientWidth || 1) / (canvas.clientHeight || 1)
      const videoAspect = vw / vh
      let sx: number
      let sy: number
      if (videoAspect > canvasAspect) {
        const displayH = canvasAspect / videoAspect
        sx = lx
        sy = (ly - 0.5) * displayH + 0.5
      } else {
        const displayW = videoAspect / canvasAspect
        sx = (lx - 0.5) * displayW + 0.5
        sy = ly
      }
      return [
        (sx - 0.5) * HAND_SCALE + 0.5,
        (sy - 0.5) * HAND_SCALE + 0.5
      ]
    }

    const drawSkeleton = () => {
      if (!overlay || !overlayCtx) return
      overlayCtx.clearRect(0, 0, overlay.width, overlay.height)
      if (!skeletonOnRef.current || latestHands.length === 0) return

      const w = overlay.width
      const h = overlay.height
      // Mirror horizontally so the overlay lines up with the mirrored video.
      overlayCtx.save()
      overlayCtx.translate(w, 0)
      overlayCtx.scale(-1, 1)

      const lineWidth = Math.max(2, Math.round(w / 320))
      const jointR = Math.max(3, Math.round(w / 260))
      overlayCtx.lineCap = 'round'
      overlayCtx.lineJoin = 'round'

      for (const hand of latestHands) {
        overlayCtx.strokeStyle = 'rgba(255, 255, 255, 0.95)'
        overlayCtx.lineWidth = lineWidth
        overlayCtx.beginPath()
        for (const [a, b] of HAND_CONNECTIONS) {
          const la = hand[a]
          const lb = hand[b]
          if (!la || !lb) continue
          const [ax, ay] = mapVidToScreen(la.x, la.y)
          const [bx, by] = mapVidToScreen(lb.x, lb.y)
          overlayCtx.moveTo(ax * w, ay * h)
          overlayCtx.lineTo(bx * w, by * h)
        }
        overlayCtx.stroke()

        overlayCtx.fillStyle = 'rgba(255, 255, 255, 0.95)'
        for (const lm of hand) {
          if (!lm) continue
          const [x, y] = mapVidToScreen(lm.x, lm.y)
          overlayCtx.beginPath()
          overlayCtx.arc(x * w, y * h, jointR, 0, Math.PI * 2)
          overlayCtx.fill()
        }
      }

      overlayCtx.restore()
    }

    // Background pause — while the app is hidden (screen off, home
    // screen, another app on top) we stop scheduling RAFs, pause the
    // video, and mute every looping sound so the phone doesn't burn
    // battery / build heat with an invisible slime. Restarting is
    // free: on visible again we reset lastTime (so dt doesn't spike
    // from the pause interval) and re-arm the loop.
    let paused = false
    const soundMuteAll = () => {
      const s = soundRef.current
      if (!s) return
      s.setSquishLevel(0)
      s.setLoopingSampleLevel('matte', 0)
      s.setLoopingSampleLevel('metal', 0)
      s.setLoopingSampleLevel('soft', 0)
      s.setLoopingSampleLevel('iceMat', 0)
      s.setLoopingSampleLevel('wax', 0)
      s.setLoopingSampleLevel('waxLayer', 0)
      s.setLoopingSampleLevel('thinwax', 0)
      s.setLoopingSampleLevel('foil', 0)
      s.setLoopingSampleLevel('ice', 0)
      s.setLoopingSampleLevel('tube', 0)
      s.setLoopingSampleLevel('paper', 0)
      s.setLoopingSampleLevel('plastic', 0)
      s.setLoopingSampleLevel('plasticLayer', 0)
      s.setLoopingSampleLevel('beads', 0)
      s.setLoopingSampleLevel('emoji', 0)
      s.setLoopingSampleLevel('customBeads', 0)
      s.setLoopingSampleLevel('slimeTap', 0)
    }
    const handleHide = () => {
      if (paused) return
      paused = true
      cancelAnimationFrame(raf)
      try {
        video.pause()
      } catch {
        // already paused / no source
      }
      soundMuteAll()
    }
    const handleShow = () => {
      if (!paused) return
      paused = false
      lastTime = performance.now()
      // Only resume the camera if hand tracking is on; otherwise the
      // stream itself is gone and there's nothing to restart.
      if (skeletonOnRef.current) {
        video.play().catch(() => {})
      }
      raf = requestAnimationFrame(loop)
    }
    const onVis = () => {
      if (document.hidden) handleHide()
      else handleShow()
    }
    document.addEventListener('visibilitychange', onVis)
    // Android WebView sometimes skips visibilitychange when the app is
    // sent to background — window blur/focus is a reliable fallback.
    window.addEventListener('blur', handleHide)
    window.addEventListener('focus', handleShow)

    const loop = () => {
      if (paused) return
      raf = requestAnimationFrame(loop)
      const now = performance.now()
      const rawDt = (now - lastTime) / 1000
      lastTime = now
      const dt = Math.min(rawDt, 1 / 30) // clamp for stability

      localTips.length = 0
      slime.mesh.updateMatrixWorld()
      inv.copy(slime.mesh.matrixWorld).invert()
      _center.setFromMatrixPosition(slime.mesh.matrixWorld)
      const worldRadius =
        slime.params.radius * Math.max(slime.mesh.scale.x, 1e-6)

      if (!skeletonOnRef.current) {
        // Hand tracking off — make sure no stale hands linger and keep
        // pressing the slime after the toggle flips.
        if (latestHands.length > 0) latestHands = []
      } else if (video.readyState >= 2 && video.videoWidth > 0) {
        // MediaPipe requires strictly increasing timestamps.
        const ts = Math.max(Math.floor(now), lastDetectMs + 1)
        lastDetectMs = ts
        const res = detect(video, ts)
        const count = res?.landmarks?.length ?? 0
        if (res && count > 0) {
          latestHands = res.landmarks

          // Local helper: convert a mirrored screen point (0..1) to a contact
          // tip on the *rest* sphere. We deliberately ignore the currently
          // deformed mesh — if we raycast against it, an already-dented front
          // makes the ray hit a surrounding bulge first, so the depression's
          // center vertex never gets any force and volume preservation inflates
          // it into a lone bump. Anchoring contacts to the rest sphere keeps
          // every screen position mapped to a canonical local point.
          _restSphere.set(_center, worldRadius)
          const addTipFromScreen = (
            sx: number,
            sy: number,
            weight: number,
            radius: number
          ) => {
            _ndc.set(-(sx * 2 - 1), -(sy * 2 - 1))
            raycaster.setFromCamera(_ndc, camera)
            const hit = raycaster.ray.intersectSphere(_restSphere, _worldPos)
            if (hit === null) {
              // Ray missed the rest sphere; forgive fingers just past the
              // silhouette by projecting the closest ray point onto it.
              raycaster.ray.closestPointToPoint(_center, _closest)
              if (_closest.distanceTo(_center) > worldRadius * 1.35) return
              _worldPos
                .copy(_closest)
                .sub(_center)
                .normalize()
                .multiplyScalar(worldRadius)
                .add(_center)
            }
            const pos = _worldPos.clone().applyMatrix4(inv)
            const dir = pos.clone().negate().normalize()
            localTips.push({ pos, dir, weight, radius })
          }

          for (const hand of res.landmarks) {
            // Score each finger's extension so we can (a) push per fingertip
            // and (b) decide whether the palm is open enough to also press
            // with its center.
            const fingerWeights: number[] = []
            for (const finger of FINGERS) {
              fingerWeights.push(extensionToWeight(fingerCurl(hand, finger)))
            }

            // Fingertip contacts get a narrow influence — a single poke
            // should only depress its own finger-width, not a whole cap.
            const FINGERTIP_RADIUS = 0.32
            for (let fi = 0; fi < FINGERS.length; fi++) {
              const weight = fingerWeights[fi]
              if (weight <= 0.01) continue
              const lm = hand[FINGERS[fi].tip]
              if (!lm) continue
              const [sx, sy] = mapVidToScreen(lm.x, lm.y)
              addTipFromScreen(sx, sy, weight, FINGERTIP_RADIUS)
            }

            // Palm-center contact: when the hand is open, the middle of the
            // palm has no fingertip sitting on it. Without a contact there,
            // volume preservation would push that spot outward while the
            // surrounding fingertip zones are being pressed in — leaving a
            // rounded bump in the center of an otherwise flat press.
            // Adding a synthetic press point at the palm centroid fills it.
            let extendedCount = 0
            for (const w of fingerWeights) if (w > 0.5) extendedCount++
            if (extendedCount >= 3) {
              // Palm centroid = average of wrist + four MCPs (5, 9, 13, 17).
              const palmIdx = [0, 5, 9, 13, 17]
              let sx = 0
              let sy = 0
              let valid = 0
              for (const i of palmIdx) {
                const lm = hand[i]
                if (!lm) continue
                sx += lm.x
                sy += lm.y
                valid++
              }
              if (valid > 0) {
                const avg =
                  fingerWeights.reduce((a, b) => a + b, 0) / fingerWeights.length
                // Palm covers a wide area — larger radius so its push blends
                // seamlessly with the surrounding fingertip contacts.
                const [psx, psy] = mapVidToScreen(sx / valid, sy / valid)
                addTipFromScreen(psx, psy, avg, 0.85)
              }
            }
          }
        } else {
          latestHands = []
        }
      }

      // Direct pointer press — ONLY when exactly one pointer is down.
      // Two-pointer state is reserved for rotate + zoom, so no fingertip
      // contact is added then (otherwise pinching would smoosh the
      // slime unintentionally). Every frame a single pointer is held
      // it re-emits the contact, which naturally implements long-press
      // pressure without a separate timer.
      if (activePointers.size === 1 && container) {
        const rect = container.getBoundingClientRect()
        const rw = rect.width || 1
        const rh = rect.height || 1
        _restSphere.set(_center, worldRadius)
        const pt = activePointers.values().next().value
        // Pinch grace window — defer press physics for the first N ms
        // after the initial pointer down. If a second finger arrives
        // within the window it becomes a pinch (no press ever fires
        // for the first finger). If the window expires with only one
        // pointer still down, press physics kicks in normally.
        // 70 ms catches most human two-finger placement gaps while
        // keeping deliberate quick taps responsive.
        const PINCH_GRACE_MS = 70
        if (
          pt &&
          (pt.pinchTouched ||
            performance.now() - pt.startTime < PINCH_GRACE_MS)
        ) {
          // Skip the tip-add path this frame:
          //   • pinchTouched: this pointer was part of a pinch —
          //     stays gated until the user fully releases (avoids
          //     the "release one finger of the pinch, slime gets
          //     pressed" bug).
          //   • within grace window: waiting to see if a second
          //     pointer arrives for a pinch.
        } else if (pt) {
          const sx = (pt.x - rect.left) / rw
          const sy = (pt.y - rect.top) / rh
          // Non-mirrored NDC — unlike the video/hand path which mirrors
          // X for the selfie-camera feed, pointer coords are already
          // in canvas orientation.
          _ndc.set(sx * 2 - 1, -(sy * 2 - 1))
          raycaster.setFromCamera(_ndc, camera)
          const hit = raycaster.ray.intersectSphere(_restSphere, _worldPos)
          let inRange = true
          if (hit === null) {
            raycaster.ray.closestPointToPoint(_center, _closest)
            if (_closest.distanceTo(_center) > worldRadius * 1.35) {
              inRange = false
            } else {
              _worldPos
                .copy(_closest)
                .sub(_center)
                .normalize()
                .multiplyScalar(worldRadius)
                .add(_center)
            }
          }
          if (inRange) {
            const pos = _worldPos.clone().applyMatrix4(inv)
            const dir = pos.clone().negate().normalize()
            // Press strength — cranked up for the press-machine
            // physics. Base weight 6.0 makes a single tap already
            // read as a firm two-plate squish; sustained hold ramps
            // up to ~14 for heavy kneading. Widened radius (0.7) so
            // the pancake flattening covers a satisfying area.
            const heldSec = (performance.now() - pt.startTime) / 1000
            const timeBoost = Math.min(5.0, heldSec / 0.15)
            const dragBoost = Math.min(3.0, pt.dragDist / 200)
            const weight = 6.0 + Math.min(8.0, timeBoost + dragBoost)
            localTips.push({ pos, dir, weight, radius: 0.7 })
          }
        }
      }

      // Screen-as-wall press physics — a tip pressing STRAIGHT INTO
      // Suppress ALL press tips (hand + pointer) when:
      //   • emoji move mode is on — tapping/dragging the slime is
      //     reserved for repositioning emojis, not squishing.
      //   • two or more pointers are down — a pinch gesture is in
      //     progress for zoom, and any lingering press activity from
      //     the first-finger frames should NOT deform the slime.
      //   • collection browse mode is active AND preview-mode is
      //     OFF — the whole screen is used for swipe navigation
      //     between saved slimes, so no press physics runs. Toggling
      //     preview-mode ON re-enables all interactions.
      if (
        emojiMoveOnRef.current ||
        activePointers.size >= 2 ||
        (browseIdxRef.current !== null && !previewModeRef.current)
      ) {
        localTips.length = 0
      }
      // Screen-as-wall press physics — a tip pressing STRAIGHT INTO
      // the screen (aimed at the camera-facing pole of the slime) gets
      // a matching antipode tip so the slime pancakes between the
      // finger and the "wall" behind it. Tips grazing the SILHOUETTE
      // edge (tangent to the camera) get no antipode — they just poke
      // one side like ordinary pinch input. The blend is smooth via
      // dot(tipOutward, cameraDir): 1 = dead centre facing camera → full
      // symmetric press, 0 = at the equator → no antipode.
      // Beads themselves still see only the original tips so their
      // damage/crack routing isn't double-hit by the phantom antipode.
      _closest.copy(camera.position).applyMatrix4(inv)
      const camDist = _closest.length() || 1
      const camDirLocalX = _closest.x / camDist
      const camDirLocalY = _closest.y / camDist
      const camDirLocalZ = _closest.z / camDist
      // Auto-press scheduler — event-driven for organic irregularity.
      // Each press has randomized duration/peak-strength/radius/envelope
      // and lands at a random point sampled uniformly on the projected
      // disk of the front hemisphere. Spawn timing picks between three
      // bands (flurry / normal / long pause) so the rhythm never
      // resolves into a heartbeat cadence. In-flight presses tail out
      // naturally even after the spawn window closes.
      {
        const autoActive = autoPressActivesRef.current
        const canSpawn =
          autoPressEndAtRef.current > now &&
          !emojiMoveOnRef.current &&
          (browseIdxRef.current === null || previewModeRef.current)
        if (canSpawn && now >= autoPressNextAtRef.current) {
          const duration = 180 + Math.random() * 650
          const peak = 0.7 + Math.random() * 0.9
          const radius = 0.45 + Math.random() * 0.5
          const env = Math.floor(Math.random() * 3)
          // Basis (u, v) perpendicular to the camera-facing local dir
          // so offsets stay tangent to the visible front face.
          let ux: number, uy: number, uz: number
          if (Math.abs(camDirLocalZ) < 0.9) {
            ux = -camDirLocalY
            uy = camDirLocalX
            uz = 0
          } else {
            ux = 1
            uy = 0
            uz = 0
          }
          const ulen = Math.hypot(ux, uy, uz) || 1
          ux /= ulen
          uy /= ulen
          uz /= ulen
          const vx = camDirLocalY * uz - camDirLocalZ * uy
          const vy = camDirLocalZ * ux - camDirLocalX * uz
          const vz = camDirLocalX * uy - camDirLocalY * ux
          // Uniform-ish sampling on the projected disk (sqrt weighting
          // so the distribution isn't pole-biased) inside r=0.85 so
          // hits stay away from the exact silhouette edge.
          const rSample = Math.sqrt(Math.random()) * 0.85
          const theta = Math.random() * Math.PI * 2
          const uOff = rSample * Math.cos(theta)
          const vOff = rSample * Math.sin(theta)
          const dx = camDirLocalX + uOff * ux + vOff * vx
          const dy = camDirLocalY + uOff * uy + vOff * vy
          const dz = camDirLocalZ + uOff * uz + vOff * vz
          const dlen = Math.hypot(dx, dy, dz) || 1
          const restRadius = slime.params.radius
          autoActive.push({
            startedAt: now,
            duration,
            posX: (dx / dlen) * restRadius,
            posY: (dy / dlen) * restRadius,
            posZ: (dz / dlen) * restRadius,
            peak,
            radius,
            env
          })
          // Next spawn window — three bands so cadence stays
          // unpredictable: rapid burst (overlaps current press),
          // conversational tap-tap, or a long breather.
          const pattern = Math.random()
          const nextGap =
            pattern < 0.3
              ? 80 + Math.random() * 200
              : pattern < 0.8
                ? 260 + Math.random() * 520
                : 750 + Math.random() * 1100
          autoPressNextAtRef.current = now + nextGap
        }
        // Emit tips for every in-flight press; prune finished entries.
        for (let i = autoActive.length - 1; i >= 0; i--) {
          const p = autoActive[i]
          const t = (now - p.startedAt) / p.duration
          if (t >= 1) {
            autoActive.splice(i, 1)
            continue
          }
          if (t < 0) continue
          let s: number
          if (p.env === 0) {
            // Quick poke — sharp attack, exponential decay.
            s =
              t < 0.22
                ? t / 0.22
                : Math.pow(1 - (t - 0.22) / 0.78, 1.6)
          } else if (p.env === 1) {
            // Sustained squeeze — plateau in the middle.
            s = t < 0.2 ? t / 0.2 : t > 0.78 ? (1 - t) / 0.22 : 1
          } else {
            // Slow knead — smooth sine hump.
            s = Math.sin(t * Math.PI)
          }
          if (s < 0.02) continue
          const weight = 3.5 + s * p.peak * 8
          localTips.push({
            pos: new THREE.Vector3(p.posX, p.posY, p.posZ),
            dir: new THREE.Vector3(-p.posX, -p.posY, -p.posZ).normalize(),
            weight,
            radius: p.radius
          })
        }
      }
      const slimeTips: WeightedTip[] = []
      for (const t of localTips) {
        slimeTips.push(t)
        const tipLen = t.pos.length() || 1
        const tipDot =
          (t.pos.x * camDirLocalX +
            t.pos.y * camDirLocalY +
            t.pos.z * camDirLocalZ) /
          tipLen
        // Smoothly ramp antipode weight: below 0.35 dot (past ~70°
        // from front) no antipode; above 0.8 (within ~37° of front)
        // full symmetric press.
        const symStrength = Math.max(0, Math.min(1, (tipDot - 0.35) / 0.45))
        if (symStrength > 0.02) {
          slimeTips.push({
            pos: t.pos.clone().multiplyScalar(-1),
            dir: t.dir.clone().multiplyScalar(-1),
            weight: t.weight * symStrength,
            radius: t.radius
          })
        }
      }
      const symmetricSlime = slimeTips.length > localTips.length
      slime.update(slimeTips, dt)
      // 슬라임볼 rigid-core collision — when the ball is a single centred
      // preset (count === 1), any slime vertex that pressed INSIDE the
      // ball's radius gets DISPLACED. Two behaviours:
      //  1) Vertex is on the SAME side as the press (front-hemisphere
      //     relative to the average press direction) → move it around
      //     the ball to the OPPOSITE hemisphere. Effect: the slime that
      //     was covering the ball's front slides away, exposing the ball.
      //  2) Vertex is on the far side → just clamp to the ball's surface
      //     (rigid-core behaviour: slime can't sink further in).
      // Ball never moves; only slime deforms. Fake-physics: the outer
      // slime doesn't preserve volume here so a hard press "unwraps" the
      // ball as if the slime were sliding OFF the finger's press point.
      {
        const innerCfg = innerBeadsLayer.currentConfig
        if (innerCfg.combo === 'chunk' && innerCfg.count === 1) {
          const ballR = innerCfg.size
          const positions = slime.positionArray
          // Average press direction (weighted by tip weight) — points
          // FROM the origin TOWARD where the user is pressing.
          let pdx = 0
          let pdy = 0
          let pdz = 0
          let tipWeightSum = 0
          for (const t of slimeTips) {
            const tl = Math.hypot(t.pos.x, t.pos.y, t.pos.z) || 1
            const w = t.weight
            pdx += (t.pos.x / tl) * w
            pdy += (t.pos.y / tl) * w
            pdz += (t.pos.z / tl) * w
            tipWeightSum += w
          }
          const pdLen = Math.hypot(pdx, pdy, pdz)
          const pressActive = tipWeightSum > 0.05 && pdLen > 0.05
          if (pressActive) {
            pdx /= pdLen
            pdy /= pdLen
            pdz /= pdLen
          }
          let clamped = false
          for (let i = 0; i < positions.length; i += 3) {
            const x = positions[i]
            const y = positions[i + 1]
            const z = positions[i + 2]
            const len = Math.hypot(x, y, z)
            if (len < ballR && len > 1e-4) {
              // Vertex is inside the ball's radius. Default: clamp to
              // the ball surface at the same direction (rigid-core stop).
              let ox = x
              let oy = y
              let oz = z
              const s = ballR / len
              ox = x * s
              oy = y * s
              oz = z * s
              if (pressActive) {
                // Where is this vertex relative to the press direction?
                // cos > 0 → on the pressed side (front). Slide it around
                // the ball to sit on the OPPOSITE hemisphere so the
                // ball's front becomes exposed to the viewer.
                const cosA = (ox * pdx + oy * pdy + oz * pdz) / ballR
                if (cosA > 0.0) {
                  // Reflect the direction through the plane orthogonal
                  // to press: newDir = dir - 2 * (dir·press) * press
                  // (mirror through the "waist" plane of the ball),
                  // keeping the same ball-surface distance.
                  const nx = ox / ballR - 2 * cosA * pdx
                  const ny = oy / ballR - 2 * cosA * pdy
                  const nz = oz / ballR - 2 * cosA * pdz
                  const nLen = Math.hypot(nx, ny, nz) || 1
                  ox = (nx / nLen) * ballR
                  oy = (ny / nLen) * ballR
                  oz = (nz / nLen) * ballR
                }
              }
              positions[i] = ox
              positions[i + 1] = oy
              positions[i + 2] = oz
              clamped = true
            }
          }
          if (clamped) {
            slime.mesh.geometry.attributes.position.needsUpdate = true
          }
        }
      }
      // Camera position transformed into slime-local frame — BeadsLayer
      // uses this to orient squished coated beads so their flat face
      // points at the viewer. Only computed when coated chunk beads
      // are actually present; otherwise the bead layer keeps its
      // outward-aligned rotation.
      const slimeLocalCameraPos = symmetricSlime
        ? _closest
            .copy(camera.position)
            .applyMatrix4(inv)
        : null
      beadsLayer.update(
        slime.positionArray,
        slime.pressureThisFrame,
        slimeLocalCameraPos
      )
      // Coated chunk beads accumulate their own per-instance damage
      // from the ORIGINAL press tips only (no antipode) — must run
      // AFTER beadsLayer.update so this.colPos holds each bead's
      // resolved position for tip-distance testing. Uncoated beads /
      // non-chunk combos early-exit inside the method.
      beadsLayer.applyPressDamage(localTips, dt)
      // 속슬라임 uses the SAME update path — its BeadsLayer is another
      // independent instance rendering into slime.mesh. Squish-on-press
      // is applied inside SlimeApp (post-update pos shim) so we don't
      // touch BeadsLayer internals for a single-tab behavior tweak.
      innerBeadsLayer.update(
        slime.positionArray,
        slime.pressureThisFrame,
        slimeLocalCameraPos
      )
      // 슬라임볼 (single-centered inner ball) press-dent — vertex shader
      // pushes the ball's surface inward at every stored dent slot,
      // giving a real concave depression where the finger landed instead
      // of a uniform oblate spheroid. Persists after release (clay model)
      // and only clears on the reset button.
      //
      // Multi-count 슬라임볼 sits on the surface and already deforms via
      // the taffy-wrap mechanism, so dent gating is off for anything but
      // the buried single ball.
      const innerCfgForBall = innerBeadsLayer.currentConfig
      const isBuriedBall =
        innerCfgForBall.combo === 'chunk' && innerCfgForBall.count === 1
      innerTouchTips.length = 0
      if (isBuriedBall) {
        innerBeadsLayer.setBallDentEnabled(true)
        // Grow the DECOUPLED bulge whenever any press is on the slime
        // — regardless of whether the touch-through filter below admits
        // the tip for dent accumulation. Sum of tip weights × dt gives
        // a natural "press intensity × time" accumulator that the
        // shader curves through its exponential asymptote. Bulge starts
        // the frame a finger touches slime, so the ball never lags the
        // outer slime's own bulge → no perceived shrink.
        if (localTips.length > 0) {
          let anyPress = 0
          for (const t of localTips) anyPress += t.weight
          ballBulgeTime += anyPress * dt
        }
        innerBeadsLayer.setBallBulgeAmount(ballBulgeTime)
        const MAX_DENT_STRENGTH = 3.0
        const DENT_GROWTH_RATE = 1.5
        const SAME_SLOT_COS = 0.9
        // Ball is "touched" when the slime surface at the tip's radial
        // direction has been physically pushed close to the ball's outer
        // skin. A press on empty slime that only dimples the surface
        // without reaching the ball's location leaves the ball
        // untouched no matter how firm the press is. Small margin
        // (0.12) makes the check pass consistently frame-to-frame once
        // the finger has actually engaged the ball — with a strict
        // zero-margin check, slime physics jitter would drop the tip
        // in and out of the touch zone across frames and the coating
        // hiss would stutter / cut out during real crack events.
        const ballRadius = innerCfgForBall.size
        const touchThreshold = ballRadius + 0.12
        const slimeUnitDirs = slime.unitDirsArray
        const slimePositions = slime.positionArray
        const slimeVertCount = slimeUnitDirs.length / 3
        // Camera axis in slime-local space — used to reject "가장자리"
        // (peripheral / silhouette-edge) presses. A ball sitting at
        // slime origin has a fixed screen-space silhouette: any tip
        // whose perpendicular distance from the camera-to-origin axis
        // exceeds the ball's radius is grazing the slime edge, NOT
        // touching the ball, and should never register regardless of
        // how deep the slime surface deforms there. Slime physics can
        // still push a lateral vertex inward past the touch threshold,
        // so the radial-depth check alone doesn't isolate edge presses.
        _center.copy(_worldPos).set(0, 0, 0)
        const _camLocal = _closest
          .copy(camera.position)
          .applyMatrix4(inv)
        const camAxisLen = _camLocal.length() || 1
        const cax = _camLocal.x / camAxisLen
        const cay = _camLocal.y / camAxisLen
        const caz = _camLocal.z / camAxisLen
        for (const t of localTips) {
          // (a) Silhouette test — tip must lie within the ball's
          // projected circle from the camera view. Front-hemisphere
          // gate + perpendicular-distance check together isolate the
          // "on the visible ball" region.
          const alongCam =
            t.pos.x * cax + t.pos.y * cay + t.pos.z * caz
          if (alongCam <= 0) continue
          const perpX = t.pos.x - alongCam * cax
          const perpY = t.pos.y - alongCam * cay
          const perpZ = t.pos.z - alongCam * caz
          const perpDist = Math.hypot(perpX, perpY, perpZ)
          if (perpDist > ballRadius) continue
          // (b) Depth test — the deformed slime surface along the
          // tip's radial direction must have reached the ball's rest
          // skin. Filters out light touches that dimple the front but
          // don't push far enough to contact the ball.
          const tipLen =
            Math.hypot(t.pos.x, t.pos.y, t.pos.z) || 1
          const tdx = t.pos.x / tipLen
          const tdy = t.pos.y / tipLen
          const tdz = t.pos.z / tipLen
          let closestVi = 0
          let closestDot = -Infinity
          for (let j = 0; j < slimeVertCount; j++) {
            const j3 = j * 3
            const cd =
              tdx * slimeUnitDirs[j3] +
              tdy * slimeUnitDirs[j3 + 1] +
              tdz * slimeUnitDirs[j3 + 2]
            if (cd > closestDot) {
              closestDot = cd
              closestVi = j
            }
          }
          const cv3 = closestVi * 3
          const cvx = slimePositions[cv3]
          const cvy = slimePositions[cv3 + 1]
          const cvz = slimePositions[cv3 + 2]
          const cvLen = Math.hypot(cvx, cvy, cvz)
          if (cvLen > touchThreshold) continue
          innerTouchTips.push(t)
        }
        // Any tip that passed the touch-through filter cracks the
        // coating + dents the ball immediately, matching the slime
        // option's coating (both taps and long-press progressively
        // add damage — no unlock gate). The touch filter still
        // keeps peripheral / shallow slime-only presses from
        // reaching the ball.
        //
        // Sound gate carries a short hold tail so a brief tap that
        // touches the ball still produces audible crack sound instead
        // of a blip cut off by the sample's own fade-in / fade-out.
        if (innerTouchTips.length > 0) {
          ballCoatSoundHoldMs = BALL_COAT_SOUND_HOLD
        } else if (ballCoatSoundHoldMs > 0) {
          ballCoatSoundHoldMs = Math.max(0, ballCoatSoundHoldMs - dt * 1000)
        }
        ballSoundActiveThisFrame = ballCoatSoundHoldMs > 0
        innerBeadsLayer.applyPressDamage(innerTouchTips, dt)
        for (const t of innerTouchTips) {
          const tipLen =
            Math.hypot(t.pos.x, t.pos.y, t.pos.z) || 1
          const tdx = t.pos.x / tipLen
          const tdy = t.pos.y / tipLen
          const tdz = t.pos.z / tipLen
          let bestSlot = -1
          let bestDot = SAME_SLOT_COS
          let weakestSlot = 0
          let minStrength = Infinity
          for (let s = 0; s < ballDentCap; s++) {
            if (ballDentStrengths[s] > 0.001) {
              const d =
                tdx * ballDentDirs[s].x +
                tdy * ballDentDirs[s].y +
                tdz * ballDentDirs[s].z
              if (d > bestDot) {
                bestDot = d
                bestSlot = s
              }
            }
            if (ballDentStrengths[s] < minStrength) {
              minStrength = ballDentStrengths[s]
              weakestSlot = s
            }
          }
          const growth = t.weight * dt * DENT_GROWTH_RATE
          if (bestSlot >= 0) {
            const dir = ballDentDirs[bestSlot]
            dir.x = dir.x * 0.94 + tdx * 0.06
            dir.y = dir.y * 0.94 + tdy * 0.06
            dir.z = dir.z * 0.94 + tdz * 0.06
            dir.normalize()
            const cur = ballDentStrengths[bestSlot]
            const remaining = Math.max(0, MAX_DENT_STRENGTH - cur)
            ballDentStrengths[bestSlot] =
              cur + growth * (remaining / MAX_DENT_STRENGTH)
          } else {
            ballDentDirs[weakestSlot].set(tdx, tdy, tdz)
            ballDentStrengths[weakestSlot] = growth
          }
        }
        pushBallDentsToShader()
      } else {
        // Non-buried inner-slime layouts (multi-count on surface) —
        // disable the dent pass so the surface beads render round.
        // Still pass tips to applyPressDamage so surface beads with a
        // coating crack under press normally. Sound gate falls back to
        // the layer's own press force since there's no touch-through
        // gate to fight against for surface-anchored beads.
        innerBeadsLayer.setBallDentEnabled(false)
        innerBeadsLayer.applyPressDamage(localTips, dt)
        ballSoundActiveThisFrame =
          innerBeadsLayer.pressForceThisFrame > 0.001
      }
      paperLayer.update(slime.positionArray, slime.normalArray)
      powderLayer.update(slime.positionArray, slime.normalArray)
      emojiBeadsLayer.update(slime.positionArray, slime.restPositionArray)
      customBeadsLayer.update(slime.positionArray)

      // Sound: continuous squish tied to how much force is currently being
      // applied, plus a crack whenever damage crosses the next fracture step
      // (only under wax coating — other coatings don't render damage).
      // Browse-mode "reset needed" detection — first frame of real
      // pressure while previewing flips the flag so the top-centre
      // reset button appears. Runs before the sound block so both
      // paths see the same pressure signal.
      if (
        browseIdxRef.current !== null &&
        !browsePressedRef.current &&
        slime.pressureThisFrame > 3
      ) {
        browsePressedRef.current = true
        setBrowsePressed(true)
      }

      const sound = soundRef.current
      if (sound) {
        const rawPressure = slime.pressureThisFrame
        // Normalize very roughly; pushStrength * ~6 tips ~= 84 at max hard press.
        const target = Math.min(1, rawPressure / 55)
        // Rising-edge snap — on the very frame a press starts, jump
        // smoothedPressure straight to the target so the FIRST tap
        // produces immediate audible sound instead of easing in
        // silently over several frames. Ongoing / trailing press
        // still eases so tips flickering on/off don't stutter.
        if (smoothedPressure < 0.05 && target > 0.05) {
          smoothedPressure = target
        } else {
          smoothedPressure += (target - smoothedPressure) * 0.25
        }
        // Minimum sustain hold — a brief tap that releases immediately
        // would otherwise decay to silence before Wak.mp3 / other loop
        // samples finish their attack. Latch the recent peak level
        // for SOUND_HOLD_MS after any activity so tap sounds have
        // enough dwell time to be clearly audible.
        if (smoothedPressure > soundHoldLevel * 0.98) {
          soundHoldLevel = smoothedPressure
          soundHoldTimer = SOUND_HOLD_MS
        } else if (soundHoldTimer > 0) {
          soundHoldTimer -= dt * 1000
          if (soundHoldTimer < 0) soundHoldTimer = 0
        } else {
          soundHoldLevel = smoothedPressure
        }
        const soundLevel = Math.max(smoothedPressure, soundHoldLevel)
        // Matte and metal materials each replace the procedural squish
        // samples with their own looped sample (Sprinkle.mp3 for matte,
        // Popp.mp3 for metal). Both mute setSquishLevel so the default
        // squish stays silent while the material-specific ambient plays.
        //
        // Ice coating (아이스) plays a continuous Iced.mp3 loop that
        // reads as the squish signature on its own — the procedural
        // squish sound would double up over it, so we mute it too
        // when ANY of slime / bead / inner-slime is coated with ice.
        const currentMaterial = materialRef.current
        const ballMaterial = innerSlimeMaterialRef.current
        const isMatte = currentMaterial === 'matte'
        const isMetal = currentMaterial === 'metal'
        const isSoft = currentMaterial === 'soft'
        const isIceMat = currentMaterial === 'ice'
        // Ball's own material sounds — only fire when the finger actually
        // lands on the ball (innerPressActive gate below reused from the
        // coating-sound path). Ball inherits the same MATERIALS palette
        // as the outer slime so we route matte / metal / soft / ice
        // identically.
        const innerBallPressActive =
          innerBeadsLayer.pressForceThisFrame > 0.001 ? 1 : 0
        const ballIsMatte = ballMaterial === 'matte'
        const ballIsMetal = ballMaterial === 'metal'
        const ballIsSoft = ballMaterial === 'soft'
        const ballIsIceMat = ballMaterial === 'ice'
        const iceCoatingActive =
          coatingRef.current === 'ice' ||
          beadCoatingRef.current === 'ice' ||
          innerSlimeCoatingRef.current === 'ice'
        // When the outer slime is coated, the slime's own material sound
        // (matte foam Sprinkle.mp3 / metal Popp.mp3) reads as if muffled
        // through the coating. Dim it to 30% so the coating's ambient
        // takes the acoustic foreground while the material still faintly
        // hums underneath.
        const slimeCoatingActive = coatingRef.current !== 'none'
        const materialAtten = slimeCoatingActive ? 0.3 : 1.0
        const innerCoatingActive = innerSlimeCoatingRef.current !== 'none'
        const ballMaterialAtten = innerCoatingActive ? 0.3 : 1.0
        // Squish base level + parallel Slimetapping layer share the
        // same mute gate: iceMat/matte/metal/soft materials and ice
        // coating all silence both, so a specialised material/coating
        // ambient (Sprinkle / Popp / Softslime / Smoothie / Iced) is
        // the sole slime-body sound in those states rather than
        // doubling with Slime.mp3 + Slimetapping.mp3.
        // When either emoji or 추가비즈 stickers are on the slime,
        // that channel takes the acoustic foreground — dim the slime
        // body sound to 30 % so Imoji.mp3 can breathe on top without
        // needing to shout.
        const emojiOrCustomActive =
          emojiActiveRef.current || customBeadsActiveRef.current
        const emojiAtten = emojiOrCustomActive ? 0.3 : 1.0
        const slimeBaseLevel =
          isMatte || isMetal || isSoft || isIceMat || iceCoatingActive
            ? 0
            : soundLevel * materialAtten * emojiAtten
        sound.setSquishLevel(slimeBaseLevel)
        sound.setLoopingSampleLevel('slimeTap', slimeBaseLevel)
        // Union outer-slime + ball material sounds so a matte ball inside
        // a crystal slime plays its foam sound when pressed, and a putty
        // ball plays its Hoil sample. Whichever surface is being pressed
        // drives the level — max() picks the loudest source per channel.
        const slimeMatteLevel = isMatte ? soundLevel * materialAtten : 0
        const ballMatteLevel = ballIsMatte
          ? soundLevel * innerBallPressActive * ballMaterialAtten
          : 0
        const slimeMetalLevel = isMetal ? soundLevel * materialAtten : 0
        const ballMetalLevel = ballIsMetal
          ? soundLevel * innerBallPressActive * ballMaterialAtten
          : 0
        const slimeSoftLevel = isSoft ? soundLevel * materialAtten : 0
        const ballSoftLevel = ballIsSoft
          ? soundLevel * innerBallPressActive * ballMaterialAtten
          : 0
        const slimeIceMatLevel = isIceMat ? soundLevel * materialAtten : 0
        const ballIceMatLevel = ballIsIceMat
          ? soundLevel * innerBallPressActive * ballMaterialAtten
          : 0
        sound.setLoopingSampleLevel(
          'matte',
          Math.max(slimeMatteLevel, ballMatteLevel)
        )
        sound.setLoopingSampleLevel(
          'metal',
          Math.max(slimeMetalLevel, ballMetalLevel)
        )
        sound.setLoopingSampleLevel(
          'soft',
          Math.max(slimeSoftLevel, ballSoftLevel)
        )
        sound.setLoopingSampleLevel(
          'iceMat',
          Math.max(slimeIceMatLevel, ballIceMatLevel)
        )

        // Wax / foil / tube are CONTINUOUS ambient recordings ("치이이이익"
        // style), so they use setLoopingSampleLevel — a single looping
        // AudioBufferSourceNode with gain following press pressure —
        // instead of the discrete-pop scheduler used for procedural crack
        // sounds. The scheduler path chops the sample into short windows
        // and plays them one after another, which turns a continuous hiss
        // into "칙칙칙".
        //
        // Slime AND a coated chunk bead can each request a crack sound
        // this frame — they share smoothedPressure (whichever surface
        // is being pressed drives it), and we pick the max level per
        // named sample so whichever coating is present triggers its
        // sound. Tube (젤) has its OWN wet-jelly sample (Jell.mp3) —
        // although the visual shader collapses tube→foil for its damage
        // pattern, the AUDIO channel is separate so gel and foil sound
        // distinct on press.
        const coatingId = coatingRef.current
        const beadCoatingId = beadCoatingRef.current
        const innerCoatingId = innerSlimeCoatingRef.current
        const slimeCracks = slime.damageRenderingEnabled
        // Coating audio routing by coating id (no more per-thickness
        // sub-branch — the coating id itself carries the thickness):
        //   thinwax → Thinwax.mp3 via 'thinwax' channel (own loop)
        //   wax     → Waxwax.mp3  via 'wax' channel (attack + loop)
        //   ice     → Iced.mp3    via 'ice' channel (glaze crackle)
        //   foil    → Popp.mp3    via 'foil' channel
        //   tube    → Jell.mp3    via 'tube' channel
        const slimeThinWaxLevel =
          slimeCracks && coatingId === 'thinwax' ? soundLevel : 0
        const slimeWaxLevel =
          slimeCracks && coatingId === 'wax' ? soundLevel : 0
        const slimeFoilLevel =
          slimeCracks && coatingId === 'foil' ? soundLevel : 0
        const slimeTubeLevel =
          slimeCracks && coatingId === 'tube' ? soundLevel : 0
        const slimeIsIce = slimeCracks && coatingId === 'ice'
        // Only play the bead/inner coating sound when the user's press
        // actually landed on THIS bead layer — pressing the outer slime
        // silhouette away from an inner ball, for example, shouldn't
        // trigger the ball's coating hiss.
        const beadPressActive =
          beadsLayer.pressForceThisFrame > 0.001 ? 1 : 0
        // Audible floor for the ball's coating channel. Without this,
        // a low / gentle press produced innerWaxLevel = soundLevel ×
        // 1 = ~0.1 which is nearly inaudible until the user pressed
        // harder — cracks would visibly progress silently for the
        // first several frames until pressure rose enough. Floor of
        // 0.45 whenever the sound gate is on means every crack tick
        // during a coated-ball press has audible sound from frame 1.
        const innerCoatSoundLevel = ballSoundActiveThisFrame
          ? Math.max(0.45, soundLevel)
          : 0
        const beadWaxLevel =
          beadCoatingId === 'wax' ? soundLevel * beadPressActive : 0
        const beadThinWaxLevel =
          beadCoatingId === 'thinwax'
            ? soundLevel * beadPressActive
            : 0
        const beadFoilLevel =
          beadCoatingId === 'foil' ? soundLevel * beadPressActive : 0
        const beadTubeLevel =
          beadCoatingId === 'tube' ? soundLevel * beadPressActive : 0
        const beadIsIce = beadCoatingId === 'ice'
        const innerWaxLevel =
          innerCoatingId === 'wax' ? innerCoatSoundLevel : 0
        const innerThinWaxLevel =
          innerCoatingId === 'thinwax' ? innerCoatSoundLevel : 0
        const innerFoilLevel =
          innerCoatingId === 'foil' ? innerCoatSoundLevel : 0
        const innerTubeLevel =
          innerCoatingId === 'tube' ? innerCoatSoundLevel : 0
        const innerIsIce = innerCoatingId === 'ice'

        // Wax coating is now a single Waxwax.mp3 file whose buffer
        // holds the Wax4 attack in [0, 5] and the WaxCrunch sustain
        // in [5, 13]. `NAMED_SAMPLE_RANGES.wax = [5, 13]` sets those
        // seconds as the buffer's loopStart / loopEnd, and the
        // startOffset arg tells the engine WHERE to begin reading:
        //   • pending (first press after reset / auto-press start /
        //     coating switch to wax) → offset 0, so [0, 5] plays
        //     once as the attack before the loop kicks in.
        //   • not pending → offset = loopStart, so the sustain plays
        //     immediately with no re-attack.
        // The flag is consumed on the first frame that actually
        // starts a voice (level clears the 0.02 threshold), so a
        // rising-edge dip can't accidentally re-trigger the attack.
        const waxCombined = Math.max(
          slimeWaxLevel,
          beadWaxLevel,
          innerWaxLevel
        )
        // Wakcom.mp3 has a quiet lead-in in [0, ~2.4] — start the
        // attack at t=2.4 so the audible crack lands the moment the
        // user presses instead of a beat later. (Same value pre- and
        // post-splice since the excised [6, 8] region is past this
        // offset.)
        const waxStartOffset = waxAttackPendingRef.current ? 2.4 : undefined
        sound.setLoopingSampleLevel(
          'wax',
          waxCombined,
          0.008,
          waxStartOffset
        )
        // Parallel Thinwax.mp3 layer stacked on top of the wax loop —
        // driven by the same combined wax level so it fades in / out
        // with the primary channel and disappears entirely when the
        // wax coating isn't active.
        sound.setLoopingSampleLevel('waxLayer', waxCombined)
        if (waxCombined > 0.02 && waxAttackPendingRef.current) {
          waxAttackPendingRef.current = false
        }
        sound.setLoopingSampleLevel(
          'foil',
          Math.max(slimeFoilLevel, beadFoilLevel, innerFoilLevel)
        )
        sound.setLoopingSampleLevel(
          'tube',
          Math.max(slimeTubeLevel, beadTubeLevel, innerTubeLevel)
        )
        // Ice (아이스): continuous ambient loop of Iced.mp3, same
        // pressure-follows-gain pattern as wax / foil. Any of slime /
        // bead / inner-slime having the ice coating drives the level.
        const slimeIceLevel = slimeIsIce ? soundLevel : 0
        const beadIceLevel = beadIsIce
          ? soundLevel * beadPressActive
          : 0
        const innerIceLevel = innerIsIce ? innerCoatSoundLevel : 0
        sound.setLoopingSampleLevel(
          'ice',
          Math.max(slimeIceLevel, beadIceLevel, innerIceLevel)
        )
        // 씬왁스 — Thinwax.mp3의 [3, 7] 구간 loop. 수동/자동 모두
        // 동일하게 press 압력을 gain으로 매핑, 손 뗄 때 fade out.
        sound.setLoopingSampleLevel(
          'thinwax',
          Math.max(
            slimeThinWaxLevel,
            beadThinWaxLevel,
            innerThinWaxLevel
          )
        )

        // Paper / beads sounds are CONTINUOUS ambient recordings
        // ("치이이이익" style), so they use setLoopingSampleLevel — a
        // single looping source with gain following the smoothed
        // pressure — instead of the discrete-pop scheduler used for
        // crack sounds. Otherwise short windows chopped by silence
        // make a continuous recording sound like "치익 치익 치익".
        sound.setLoopingSampleLevel(
          'paper',
          paperActiveRef.current ? soundLevel : 0
        )
        sound.setLoopingSampleLevel(
          'plastic',
          plasticActiveRef.current ? soundLevel : 0
        )
        // Parallel Crunchier.mp3 layer under the plastic tick — same
        // gate + level as the primary plastic channel.
        sound.setLoopingSampleLevel(
          'plasticLayer',
          plasticActiveRef.current ? soundLevel : 0
        )
        sound.setLoopingSampleLevel(
          'beads',
          beadsActiveRef.current ? soundLevel : 0
        )
        sound.setLoopingSampleLevel(
          'emoji',
          emojiActiveRef.current ? soundLevel : 0
        )
        sound.setLoopingSampleLevel(
          'customBeads',
          customBeadsActiveRef.current ? soundLevel : 0
        )
      }

      // Quaternion-based rotation avoids the gimbal-lock the previous
      // Euler-only approach hit: after yawing 90°+ around Y the local X
      // axis was aligned with world Z, so vertical drags could no longer
      // pitch the ball back to face-on. Applying each frame's rot-vel as
      // WORLD-axis quaternion premultiplies makes horizontal/vertical
      // drags always feel like they orbit the ball around the screen's
      // X / Y axes, regardless of current orientation.
      if (Math.abs(rotVelX) > 1e-5 || Math.abs(rotVelY) > 1e-5) {
        const qY = new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(0, 1, 0),
          rotVelY
        )
        const qX = new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(1, 0, 0),
          rotVelX
        )
        slime.mesh.quaternion.premultiply(qY).premultiply(qX)
      }
      rotVelY *= 0.88
      rotVelX *= 0.88

      // Browse-mode auto-spin — every time the user switches to a
      // different saved slime, spin one full turn around world-Y
      // over 1 s so they see the piece from every angle before it
      // settles. Kicked by autoSpinUntilRef.
      const nowMs = performance.now()
      if (autoSpinUntilRef.current > nowMs) {
        const remaining = autoSpinUntilRef.current - nowMs
        const spinSpeed = Math.PI * 2 // radians per second (full turn / 1s)
        const spinDt = Math.min(dt, remaining / 1000)
        const qSpin = new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(0, 1, 0),
          spinSpeed * spinDt
        )
        slime.mesh.quaternion.premultiply(qSpin)
      }

      // Smoothly ease toward the target scale (slider or pinch → sizeRef).
      currentScale += (sizeRef.current - currentScale) * 0.18

      // Panel-driven shift + shrink. Compare the CURRENT controls block
      // height against the height of the compact "root" state (just the
      // toggle row — ~60px, plus panel padding). Anything taller than the
      // root baseline is treated as an expanded panel; the slime glides
      // up by (delta / canvasH) mapped into world units at the camera's
      // Z = 0 plane, and shrinks up to 15% at max expansion. Both channels
      // ease toward the target at 0.15 so the motion feels like the panel
      // "pushes" the sphere rather than snapping to a new position.
      const canvasH = canvas.clientHeight || 1
      const rootBaselinePx = 60
      const expandedPx = Math.max(
        0,
        controlsHeightRef.current - rootBaselinePx
      )
      const frac = Math.min(1, expandedPx / canvasH)
      // Convert to world Y: viewport world height at Z=0 ≈
      // 2 · camera.z · tan(fov/2). Move slime up by frac × that × 0.6
      // so a fully expanded panel lifts the sphere well clear of it.
      const viewportWorldHeight =
        2 * CAMERA_Z * Math.tan((camera.fov * Math.PI) / 360)
      // Collection carousel view: the bottom carousel (240px tall)
      // now doubles as a live-preview surface — the top of the screen
      // renders the currently-selected slime for touch interaction.
      // Lift the slime by roughly half the carousel height so its
      // silhouette sits centred in the AVAILABLE space above the
      // carousel instead of overlapping it, and shrink modestly so
      // the whole ball stays clear of the carousel top edge even on
      // shorter screens.
      const inCollectionCarousel =
        bottomModeRef.current === 'collection' &&
        browseIdxRef.current === null
      const targetShiftY = inCollectionCarousel
        ? viewportWorldHeight * 0.14
        : frac * viewportWorldHeight * 0.5
      const targetPanelScale = inCollectionCarousel
        ? 0.95
        : 1 - frac * 0.22
      currentPanelShiftY += (targetShiftY - currentPanelShiftY) * 0.15
      currentPanelScale += (targetPanelScale - currentPanelScale) * 0.15
      slime.mesh.position.y = currentPanelShiftY

      // Text decal is baked to a FIXED slime-local axis (+Z at the
      // moment of application) — no per-frame camera-facing update.
      // Rotating the slime carries the text around with the mesh,
      // eventually to the back, matching a physical sticker on the
      // ball's surface. The axis is initialised to (0,0,1) in the
      // uniform declaration; nothing to push here per frame.
      // Browse mode gets a modest extra scale boost so the previewed
      // slime reads slightly larger — the customization panel is
      // hidden, so the extra room can be filled by the slime itself.
      // During auto-spin, an additional "shrink" factor eases from a
      // larger start down to the browse baseline over the spin
      // window so each transition zooms out while spinning.
      const inBrowse = browseIdxRef.current !== null
      const browseScale = inBrowse ? 1.2 : 1
      let spinShrink = 1
      if (inBrowse && autoSpinUntilRef.current > nowMs) {
        const t = (autoSpinUntilRef.current - nowMs) / 600
        spinShrink = 1 + 0.35 * Math.max(0, Math.min(1, t))
      }
      slime.mesh.scale.setScalar(
        currentScale * currentPanelScale * browseScale * spinShrink
      )

      // Carousel slide — offset mesh.position.x during the browse
      // swipe transition. Old slime slides OUT in direction, midway
      // through we swap state (offscreen), new slime slides IN from
      // the opposite side back to centre.
      const carousel = carouselRef.current
      if (carousel) {
        const elapsed = nowMs - carousel.startTime
        const t = Math.min(1, elapsed / carousel.duration)
        // World-Y-visible width at Z=0 = 2·CAMERA_Z·tan(fov/2).
        // Use 1.4× the slime radius (radius ~ 1 in local × mesh
        // scale) so the slime fully leaves the visible viewport.
        const worldSideOffset =
          Math.max(2.4, slime.mesh.scale.x * 2.6) * (t < 0.5 ? 1 : 1)
        if (t < 0.5) {
          // Slide OUT: 0 → direction * offset (eased-in).
          const p = t / 0.5
          const eased = p * p
          slime.mesh.position.x = carousel.direction * worldSideOffset * eased
        } else {
          // Swap at midpoint (once), then slide IN from opposite side.
          if (carousel.swap) {
            carousel.swap()
            carousel.swap = null
          }
          const p = (t - 0.5) / 0.5
          const eased = 1 - (1 - p) * (1 - p)
          slime.mesh.position.x =
            -carousel.direction * worldSideOffset * (1 - eased)
        }
        if (t >= 1) {
          slime.mesh.position.x = 0
          carouselRef.current = null
        }
      } else {
        slime.mesh.position.x = 0
      }

      renderer.render(scene, camera)
      drawSkeleton()
    }
    raf = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('blur', handleHide)
      window.removeEventListener('focus', handleShow)
      ro.disconnect()
      container?.removeEventListener('pointerdown', onPointerDown)
      container?.removeEventListener('pointermove', onPointerMove)
      container?.removeEventListener('pointerup', onPointerUp)
      container?.removeEventListener('pointercancel', onPointerUp)
      container?.removeEventListener('pointerleave', onPointerUp)
      container?.removeEventListener('wheel', onWheel)
      applyRef.current = null
      beadsLayer.dispose()
      innerBeadsLayer.dispose()
      customBeadsLayer.dispose()
      paperLayer.dispose()
      powderLayer.dispose()
      emojiBeadsLayer.dispose()
      slime.dispose()
      envTex.dispose()
      pmrem.dispose()
      renderer.dispose()
    }
  }, [detect])

  // Hand tracking off ⇒ camera/model state is irrelevant, the app is
  // ready for touch-only interaction. Without this gate, toggling off
  // flips cameraStatus 'ready' → 'idle' which would flash the loading
  // overlay ("준비 중…") every time the user disables hand detection.
  const busy = skeletonOn
    ? cameraStatus !== 'ready' || handStatus !== 'ready'
    : false
  const busyLabel = !skeletonOn
    ? ''
    : cameraStatus === 'requesting'
      ? '카메라 권한 요청 중…'
      : handStatus === 'loading'
        ? '손 인식 모델 로딩 중…'
        : cameraStatus === 'error'
          ? `카메라 오류: ${cameraError ?? ''}`
          : handStatus === 'error'
            ? `모델 오류: ${handError ?? ''}`
            : ''

  // Collection mode with zero saved slimes — hide the 3D scene so the
  // last-previewed slime doesn't linger, leaving only the centered
  // "저장된 슬라임이 없습니다" message + the top-right close button.
  const isEmptyCollection =
    bottomMode === 'collection' &&
    collection.filter((c) => c.thumb).length === 0

  return (
    <div className={styles.root}>
      <video
        ref={videoRef}
        className={styles.video}
        playsInline
        muted
        autoPlay
        style={isEmptyCollection ? { visibility: 'hidden' } : undefined}
      />
      <canvas
        ref={canvasRef}
        className={styles.canvas}
        style={isEmptyCollection ? { visibility: 'hidden' } : undefined}
      />
      <canvas
        ref={overlayRef}
        className={styles.overlayCanvas}
        style={isEmptyCollection ? { visibility: 'hidden' } : undefined}
      />


      {/* Top-LEFT cluster hosts the hamburger menu (moved from the
          top-right); paired with the top-right 공유 button, this puts
          the primary navigation on the left and the outbound share on
          the right for a more familiar mobile layout. */}
      <div
        className={styles.topLeftBar}
        data-hud
        style={
          browseIdx !== null ||
          collectionPreview ||
          bottomMode === 'collection'
            ? { display: 'none' }
            : undefined
        }
      >
        <button
          type="button"
          className={styles.iconButton}
          onClick={() => setMenuOpen(true)}
          aria-label="메뉴"
          aria-expanded={menuOpen}
        >
          <svg
            width="26"
            height="26"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="4" y1="9" x2="20" y2="9" />
            <line x1="4" y1="15" x2="20" y2="15" />
          </svg>
        </button>
      </div>

      <div
        className={styles.topBar}
        data-hud
        style={
          browseIdx !== null ||
          collectionPreview ||
          bottomMode === 'collection'
            ? { display: 'none' }
            : undefined
        }
      >
        {((emojiBeads.emojis.length > 0 && emojiBeads.count > 0) ||
          customBeads.count > 0) && (
          <button
            type="button"
            className={styles.iconButton}
            data-active={emojiMoveOn}
            onClick={() => setEmojiMoveOn((v) => !v)}
            aria-label="이모지 / 비즈 위치 변경"
            aria-pressed={emojiMoveOn}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M5 9l-3 3 3 3" />
              <path d="M9 5l3 -3 3 3" />
              <path d="M15 19l-3 3 -3 -3" />
              <path d="M19 9l3 3 -3 3" />
              <line x1="2" y1="12" x2="22" y2="12" />
              <line x1="12" y1="2" x2="12" y2="22" />
            </svg>
          </button>
        )}
        <button
          type="button"
          className={styles.iconButton}
          onClick={handleShare}
          aria-label="공유"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {/* Classic 3-node share glyph — two nodes on the right
                connected to one on the left by diagonal links. */}
            <circle cx="18" cy="5" r="3" />
            <circle cx="6" cy="12" r="3" />
            <circle cx="18" cy="19" r="3" />
            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
            <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
          </svg>
        </button>
      </div>

      {/* Left drawer — slides in from the left when the menu button is
          tapped. Backdrop dims the app and closes the drawer on outside
          tap; the drawer itself catches clicks so tapping inside doesn't
          bubble up and dismiss the whole thing. */}
      {menuOpen && (
        <>
          <div
            className={styles.drawerBackdrop}
            onClick={() => setMenuOpen(false)}
          />
          <aside
            className={styles.drawer}
            data-hud
            role="dialog"
            aria-label="메뉴"
          >
            <div className={styles.drawerHeader}>
              <button
                type="button"
                className={styles.drawerClose}
                onClick={() => setMenuOpen(false)}
                aria-label="닫기"
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="6" y1="6" x2="18" y2="18" />
                  <line x1="18" y1="6" x2="6" y2="18" />
                </svg>
              </button>
            </div>
            <nav className={styles.drawerNav} role="menu">
              <AccountDrawerTop onCloseDrawer={() => setMenuOpen(false)} />
              <div className={styles.drawerItem} role="none">
                <span>테마</span>
                <div className={styles.themeSwitch} role="radiogroup" aria-label="테마">
                  <button
                    type="button"
                    className={styles.themeSwitchOption}
                    data-active={theme === 'light'}
                    role="radio"
                    aria-checked={theme === 'light'}
                    onClick={() => setTheme('light')}
                  >
                    라이트
                  </button>
                  <button
                    type="button"
                    className={styles.themeSwitchOption}
                    data-active={theme === 'dark'}
                    role="radio"
                    aria-checked={theme === 'dark'}
                    onClick={() => setTheme('dark')}
                  >
                    다크
                  </button>
                </div>
              </div>
            </nav>
            <div className={styles.drawerFooter}>
              <AccountDrawerFooter onCloseDrawer={() => setMenuOpen(false)} />
            </div>
          </aside>
        </>
      )}

      {browseIdx !== null && (() => {
        const visible = collection.filter((c) => c.thumb)
        if (visible.length === 0) return null
        const idx = Math.max(0, Math.min(visible.length - 1, browseIdx))
        const current = visible[idx]
        return (
          // Preview mode OFF ⇒ overlay eats touches for swipe-nav.
          // Preview mode ON ⇒ overlay lets touches through so the
          // slime can be pressed / rotated / pinched normally
          // (only chrome buttons keep pointer-events on).
          <div
            className={
              previewMode
                ? `${styles.browseOverlay} ${styles.browseOverlayPreview}`
                : styles.browseOverlay
            }
            data-hud
            onPointerDown={
              previewMode
                ? undefined
                : (e) => {
                    ;(e.currentTarget as HTMLElement).dataset.swipeStartX =
                      String(e.clientX)
                  }
            }
            onPointerUp={
              previewMode
                ? undefined
                : (e) => {
                    const el = e.currentTarget as HTMLElement
                    const startStr = el.dataset.swipeStartX
                    delete el.dataset.swipeStartX
                    if (!startStr) return
                    const dx = e.clientX - parseFloat(startStr)
                    if (Math.abs(dx) < 40) return
                    if (dx < 0) setBrowsedIndex(idx + 1)
                    else setBrowsedIndex(idx - 1)
                  }
            }
            onPointerCancel={(e) => {
              delete (e.currentTarget as HTMLElement).dataset.swipeStartX
            }}
          >
            {/* Top-LEFT: share (reuses the app-wide handleShare on
                the currently-loaded browsed slime) + delete icon. */}
            <div className={styles.browseTopLeftBar}>
              <button
                type="button"
                className={styles.iconButton}
                onClick={(e) => {
                  e.stopPropagation()
                  void handleShare()
                }}
                aria-label={`${current.name} 공유`}
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7" />
                  <polyline points="16 6 12 2 8 6" />
                  <line x1="12" y1="2" x2="12" y2="15" />
                </svg>
              </button>
              <button
                type="button"
                className={styles.iconButton}
                onClick={(e) => {
                  e.stopPropagation()
                  const nextVisible = collection
                    .filter((c) => c.thumb && c.id !== current.id)
                  deleteFromCollection(current.id)
                  if (nextVisible.length === 0) {
                    setBrowseIdx(null)
                  } else {
                    setBrowsedIndex(Math.min(idx, nextVisible.length - 1))
                  }
                }}
                aria-label={`${current.name} 삭제`}
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  <path d="M10 11v6M14 11v6" />
                  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                </svg>
              </button>
            </div>
            {/* Top-RIGHT: 모두보기 button (grid view). */}
            <div className={styles.browseTopBar}>
              <button
                type="button"
                className={styles.browseAllBtn}
                onClick={(e) => {
                  e.stopPropagation()
                  setCollectionOpen(true)
                }}
              >
                모두보기
              </button>
            </div>
            {/* Name (renameable) + 프리뷰 (+ 리셋 while pressed)
                stacked centrally BELOW the slime. Reset sits to
                the right of the preview toggle, only visible after
                the user has actually pressed the previewed slime. */}
            <div className={styles.browseFooter}>
              <button
                type="button"
                className={styles.browseTitle}
                onClick={(e) => {
                  e.stopPropagation()
                  beginRename(current.id)
                }}
                aria-label={`${current.name} 이름 수정`}
              >
                {current.name} · {idx + 1}/{visible.length}
              </button>
              <div className={styles.browseFooterActions}>
                <button
                  type="button"
                  className={styles.browseActionBtn}
                  data-preview-active={previewMode}
                  onClick={(e) => {
                    e.stopPropagation()
                    setPreviewMode((v) => {
                      if (v) setBrowsePressed(false)
                      return !v
                    })
                  }}
                  aria-pressed={previewMode}
                >
                  프리뷰
                </button>
                {previewMode && browsePressed && (
                  <button
                    type="button"
                    className={styles.browseActionBtn}
                    onClick={(e) => {
                      e.stopPropagation()
                      applyStateSnapshot(current.state)
                      applyPressReset()
                      setBrowsePressed(false)
                    }}
                  >
                    ↻ 리셋
                  </button>
                )}
              </div>
            </div>
            {/* Bottom-LEFT check icon — commits the browsed slime
                as the active editing state and leaves browse. */}
            <button
              type="button"
              className={styles.browseUseBtn}
              onClick={(e) => {
                e.stopPropagation()
                loadFromCollection(current.id)
              }}
              aria-label={`${current.name} 사용하기`}
            >
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </button>
            {/* Bottom-right × — exit browse and RESTORE the state
                the user had before opening the collection. */}
            <button
              type="button"
              className={styles.browseCloseIconBtn}
              onClick={(e) => {
                e.stopPropagation()
                if (preBrowseStateRef.current) {
                  applyStateSnapshot(preBrowseStateRef.current)
                }
                applyPressReset()
                setBrowseIdx(null)
              }}
              aria-label="닫기"
            >
              ×
            </button>
          </div>
        )
      })()}

      {collectionOpen && (
        <div
          className={styles.modalBackdrop}
          onClick={() => setCollectionOpen(false)}
        >
          <div
            className={styles.modal}
            data-hud
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.modalTitle}>컬렉션</div>
            {(() => {
              // Only entries with a captured thumbnail render — legacy
              // saves made before the thumbnail feature (no `thumb`
              // field) would otherwise show as a blank grey card with
              // just the name, which the user flagged as noise.
              const visibleItems = collection.filter((c) => c.thumb)
              if (visibleItems.length === 0) {
                return (
                  <p className={styles.collectionEmpty}>
                    저장된 슬라임이 아직 없어요
                  </p>
                )
              }
              const colCount = Math.ceil(visibleItems.length / 2)
              return (
                <div className={styles.collectionGridWrap}>
                  <div
                    className={styles.collectionGrid}
                    style={{
                      // Explicit column count with row-first flow so
                      // items fill LEFT → RIGHT across the top row
                      // first, then wrap into the bottom row
                      // (top-left, top-right, bottom-left, bottom-right).
                      gridTemplateColumns: `repeat(${colCount}, 133px)`
                    }}
                  >
                    {visibleItems.map((item) => (
                      <div key={item.id} className={styles.collectionCard}>
                        <div
                          className={styles.collectionCardBody}
                          role="button"
                          tabIndex={0}
                          onClick={() => loadFromCollection(item.id)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              loadFromCollection(item.id)
                            }
                          }}
                          aria-label={`${item.name} 불러오기`}
                        >
                          <img
                            src={item.thumb}
                            alt={item.name}
                            className={styles.collectionThumb}
                            draggable={false}
                          />
                          <button
                            type="button"
                            className={styles.collectionShareBtn}
                            onClick={(e) => {
                              e.stopPropagation()
                              shareCollectionItem(item.id)
                            }}
                            aria-label={`${item.name} 공유`}
                          >
                            <svg
                              width="12"
                              height="12"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7" />
                              <polyline points="16 6 12 2 8 6" />
                              <line x1="12" y1="2" x2="12" y2="15" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            className={styles.collectionDeleteBtn}
                            onClick={(e) => {
                              e.stopPropagation()
                              deleteFromCollection(item.id)
                            }}
                            aria-label={`${item.name} 삭제`}
                          >
                            ×
                          </button>
                        </div>
                        <button
                          type="button"
                          className={styles.collectionNameLabel}
                          onClick={() => beginRename(item.id)}
                          aria-label={`${item.name} 이름 수정`}
                        >
                          {item.name}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })()}
            <button
              type="button"
              className={styles.modalClose}
              onClick={() => setCollectionOpen(false)}
            >
              닫기
            </button>
          </div>
        </div>
      )}

      {nameDialog && (
        <div
          className={styles.modalBackdrop}
          onClick={() => setNameDialog(null)}
        >
          <div
            className={styles.modal}
            data-hud
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.modalTitle}>
              {nameDialog.mode === 'save' ? '슬라임 이름' : '이름 수정'}
            </div>
            <input
              type="text"
              value={nameDialog.input}
              autoFocus
              onChange={(e) =>
                setNameDialog(
                  nameDialog
                    ? { ...nameDialog, input: e.currentTarget.value }
                    : null
                )
              }
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  commitNameDialog()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  setNameDialog(null)
                }
              }}
              className={styles.nameDialogInput}
              maxLength={30}
              placeholder="슬라임 이름"
            />
            <div className={styles.nameDialogActions}>
              <button
                type="button"
                className={styles.modalClose}
                onClick={() => setNameDialog(null)}
              >
                취소
              </button>
              <button
                type="button"
                className={styles.nameDialogSaveBtn}
                onClick={commitNameDialog}
              >
                저장
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className={styles.toast}>{toast}</div>}

      {/* Collection-mode close button — pinned top-right. Restores
          the WIP slime state that was captured on entry so the user's
          in-progress design isn't clobbered by the carousel preview. */}
      {bottomMode === 'collection' && (
        <button
          type="button"
          className={styles.collectionCloseBtn}
          data-hud
          onClick={() => {
            const snap = preCollectionPreviewStateRef.current
            preCollectionPreviewStateRef.current = null
            if (snap) applyStateSnapshot(snap)
            setBottomMode('options')
          }}
          aria-label="컬렉션 닫기"
        >
          ×
        </button>
      )}

      {isEmptyCollection && (
        <div className={styles.collectionEmptyOverlay} data-hud>
          저장된 슬라임이 없습니다
        </div>
      )}

      {autoPressOn && (() => {
        const totalSec = Math.max(0, Math.ceil(autoPressRemainingMs / 1000))
        const mm = String(Math.floor(totalSec / 60)).padStart(2, '0')
        const ss = String(totalSec % 60).padStart(2, '0')
        return (
          <button
            type="button"
            className={styles.autoCountdown}
            data-hud
            onClick={() => {
              const remaining = Math.max(
                0,
                autoPressEndAtRef.current - performance.now()
              )
              const secTotal =
                remaining > 0
                  ? Math.max(1, Math.round(remaining / 1000))
                  : Math.max(1, Math.round(autoPressDefaultMs / 1000))
              setAutoTimeEditMin(Math.floor(secTotal / 60))
              setAutoTimeEditSec(secTotal % 60)
              setAutoSaveAsDefault(false)
              setAutoTimeOpen(true)
            }}
            aria-label="자동 압박 남은 시간 (탭하여 조정)"
          >
            {mm}:{ss}
          </button>
        )
      })()}

      {autoTimeOpen && (
        <div
          className={styles.modalBackdrop}
          onClick={() => setAutoTimeOpen(false)}
        >
          <div
            className={styles.modal}
            data-hud
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.modalTitle}>자동 압박 시간</div>
            <div className={styles.autoTimeRow}>
              <div className={styles.autoTimeStepper}>
                <button
                  type="button"
                  className={styles.autoTimeBtn}
                  onClick={() =>
                    setAutoTimeEditMin((v) => Math.max(0, v - 1))
                  }
                  aria-label="분 감소"
                >
                  −
                </button>
                <span className={styles.autoTimeValue}>
                  {String(autoTimeEditMin).padStart(2, '0')}
                </span>
                <button
                  type="button"
                  className={styles.autoTimeBtn}
                  onClick={() =>
                    setAutoTimeEditMin((v) => Math.min(59, v + 1))
                  }
                  aria-label="분 증가"
                >
                  +
                </button>
                <div className={styles.autoTimeUnit}>분</div>
              </div>
              <div className={styles.autoTimeStepper}>
                <button
                  type="button"
                  className={styles.autoTimeBtn}
                  onClick={() =>
                    setAutoTimeEditSec((v) => Math.max(0, v - 1))
                  }
                  aria-label="초 감소"
                >
                  −
                </button>
                <span className={styles.autoTimeValue}>
                  {String(autoTimeEditSec).padStart(2, '0')}
                </span>
                <button
                  type="button"
                  className={styles.autoTimeBtn}
                  onClick={() =>
                    setAutoTimeEditSec((v) => Math.min(59, v + 1))
                  }
                  aria-label="초 증가"
                >
                  +
                </button>
                <div className={styles.autoTimeUnit}>초</div>
              </div>
            </div>
            <label className={styles.autoTimeSaveRow}>
              <input
                type="checkbox"
                checked={autoSaveAsDefault}
                onChange={(e) => setAutoSaveAsDefault(e.target.checked)}
              />
              <span>기본값으로 저장</span>
            </label>
            <div className={styles.nameDialogActions}>
              <button
                type="button"
                className={styles.modalClose}
                onClick={() => setAutoTimeOpen(false)}
              >
                취소
              </button>
              <button
                type="button"
                className={styles.nameDialogSaveBtn}
                onClick={() => {
                  const totalMs =
                    (autoTimeEditMin * 60 + autoTimeEditSec) * 1000
                  if (totalMs <= 0) {
                    setAutoTimeOpen(false)
                    return
                  }
                  if (autoSaveAsDefault) {
                    setAutoPressDefaultMs(totalMs)
                  }
                  // Retarget the current session's deadline so the
                  // countdown pill immediately reflects the new value.
                  autoPressEndAtRef.current = performance.now() + totalMs
                  setAutoPressRemainingMs(totalMs)
                  setAutoTimeOpen(false)
                }}
              >
                확인
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 수정하기 save-confirm dialog. */}
      {handDetectPending && (
        <div
          className={styles.modalBackdrop}
          onClick={() => setHandDetectPending(false)}
        >
          <div
            className={styles.modal}
            data-hud
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.modalTitle}>손 감지를 켤까요?</div>
            <p className={styles.modalList}>
              카메라와 손 인식 모델이 계속 돌아가면서 배터리 소모와
              발열이 늘어날 수 있어요.
            </p>
            <div className={styles.nameDialogActions}>
              <button
                type="button"
                className={styles.modalClose}
                onClick={() => setHandDetectPending(false)}
              >
                취소
              </button>
              <button
                type="button"
                className={styles.nameDialogSaveBtn}
                onClick={() => {
                  setHandDetectPending(false)
                  setSkeletonOn(true)
                }}
              >
                켜기
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingCollectionEdit && (
        <div
          className={styles.modalBackdrop}
          onClick={() => setPendingCollectionEdit(null)}
        >
          <div
            className={styles.modal}
            data-hud
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.modalTitle}>
              제작 중인 슬라임을 저장할까요?
            </div>
            <p className={styles.modalList}>
              저장하지 않으면 지금까지의 변경 사항이 사라져요.
            </p>
            <div className={styles.nameDialogActions}>
              <button
                type="button"
                className={styles.modalClose}
                onClick={() => setPendingCollectionEdit(null)}
              >
                취소
              </button>
              <button
                type="button"
                className={styles.modalClose}
                onClick={() => {
                  const target = pendingCollectionEdit
                  setPendingCollectionEdit(null)
                  applyStateSnapshot(target.state)
                  setBottomMode('options')
                }}
              >
                저장 안 함
              </button>
              <button
                type="button"
                className={styles.nameDialogSaveBtn}
                onClick={() => {
                  const target = pendingCollectionEdit
                  const pendingThumb =
                    applyRef.current?.captureCanonicalThumbnail()
                  const pendingState = buildStateSnapshot()
                  const name = `슬라임 ${collection.length + 1}`
                  const id = `${Date.now().toString(36)}-${Math.random()
                    .toString(36)
                    .slice(2, 8)}`
                  setCollection((prev) => [
                    ...prev,
                    {
                      id,
                      name,
                      createdAt: Date.now(),
                      state: pendingState,
                      thumb: pendingThumb
                    }
                  ])
                  hasUnsavedChangesRef.current = false
                  setPendingCollectionEdit(null)
                  applyStateSnapshot(target.state)
                  setBottomMode('options')
                  setToast(`${name} 저장됨`)
                  window.setTimeout(() => setToast(null), 2000)
                }}
              >
                저장하고 수정
              </button>
            </div>
          </div>
        </div>
      )}

      <div
        ref={controlsRef}
        className={styles.controls}
        data-hud
        // Hide the customization panel + bottom toolbar entirely
        // while browsing a saved collection OR in the touch-only
        // collection preview — the user is picking / playing with a
        // slime, not editing. Also hide when collection mode is
        // entered with zero saved slimes so only the centered empty
        // message remains visible.
        style={
          browseIdx !== null || collectionPreview || isEmptyCollection
            ? { display: 'none' }
            : undefined
        }
      >
        {/* Top-of-controls action row — sits directly above the
            options panel. Hand toggle pinned left, shape reset in
            the centre, collection opener pinned right. Hidden while
            in collection mode so the layout belongs to the carousel
            + its own above-carousel action bar. */}
        <div
          className={styles.topButtonRow}
          style={bottomMode === 'collection' ? { display: 'none' } : undefined}
        >
          <button
            type="button"
            className={styles.sideBtn}
            data-active={skeletonOn}
            onClick={() => {
              if (skeletonOn) {
                setSkeletonOn(false)
              } else {
                // Enabling hand detect kicks the front camera + a heavy
                // MediaPipe inference loop on every frame. Warn the
                // user so they can opt in with awareness rather than
                // discovering the impact after the phone heats up.
                setHandDetectPending(true)
              }
            }}
            aria-label={skeletonOn ? '손 감지 끄기' : '손 감지 켜기'}
            aria-pressed={skeletonOn}
          >
            <svg
              width="24"
              height="24"
              viewBox="0 0 56 56"
              fill="currentColor"
            >
              <path d="M 2.1952 36.8945 C 3.0156 36.8711 3.6015 36.2383 3.6250 35.3945 C 3.8828 25.1992 9.1328 17.6523 17.1015 14.6992 L 22.5625 29.6992 C 22.6093 29.8164 22.5859 29.9101 22.4687 29.9570 C 22.3749 30.0039 22.3046 29.9570 22.2343 29.8867 L 19.4687 26.8867 C 17.6640 24.9414 15.3671 24.8008 13.5859 26.3008 C 11.5703 28.0117 11.5468 30.5664 13.5156 32.9805 L 21.3671 42.4727 C 27.2968 49.6445 34.2578 51.8711 42.0390 49.0352 C 51.3438 45.6602 55.3047 37.1289 51.5545 26.8164 L 49.7967 22.0117 C 47.9689 16.9258 44.4765 14.8398 40.3749 16.2695 C 39.2734 14.8398 37.5859 14.3477 35.7578 15.0039 C 35.1250 15.2383 34.5156 15.5899 33.9296 16.0352 C 32.7343 14.4883 30.8828 13.9258 28.9609 14.6055 C 28.4452 14.7930 27.9530 15.0742 27.4843 15.4023 L 24.8125 8.0899 C 23.8046 5.3008 21.2734 4.1289 18.6718 5.0664 C 16.0468 6.0274 14.8749 8.5352 15.8828 11.3242 L 16.0703 11.8398 C 6.9999 15.2383 .6953 23.9805 .6953 35.3477 C .6953 36.1914 1.3984 36.9179 2.1952 36.8945 Z M 41.0312 45.9648 C 34.8906 48.2148 29.1250 47.0664 23.7109 40.5274 L 15.8593 31.0820 C 15.0156 30.0977 15.0156 29.1367 15.7656 28.4805 C 16.4687 27.8477 17.4296 28.0586 18.2030 28.8555 L 23.6171 34.4570 C 24.5312 35.3945 25.3281 35.4883 26.1015 35.2070 C 27.0156 34.8789 27.4140 33.8945 27.0390 32.8867 L 18.7421 10.0586 C 18.3906 9.1211 18.8125 8.2305 19.7030 7.9023 C 20.6171 7.5742 21.4609 8.0195 21.8125 8.9570 L 27.7421 25.2461 C 28.0234 26.0195 28.8906 26.3711 29.6640 26.0899 C 30.4140 25.8086 30.8125 24.9883 30.5312 24.2383 L 28.3984 18.3555 C 28.7265 18.0508 29.1718 17.7461 29.6171 17.5820 C 30.7187 17.1836 31.6328 17.6758 32.0546 18.8242 L 33.9296 23.9570 C 34.2109 24.7539 35.0781 25.0586 35.8281 24.7774 C 36.5546 24.5195 37.0234 23.7461 36.7187 22.9258 L 35.1952 18.7774 C 35.5234 18.4492 35.9687 18.1445 36.4140 17.9805 C 37.5156 17.5820 38.4296 18.0742 38.8515 19.2227 L 40.0937 22.6445 C 40.3984 23.4648 41.2656 23.7695 42.0156 23.4883 C 42.7421 23.2305 43.1874 22.4336 42.9062 21.6367 L 41.9687 19.1055 C 43.9374 18.4023 45.7892 19.9961 47.0545 23.5117 L 48.5310 27.5195 C 51.7422 36.3789 48.8123 43.1289 41.0312 45.9648 Z" />
            </svg>
          </button>
          <button
            type="button"
            className={styles.sideBtn}
            data-active={autoPressOn}
            onClick={() => {
              // Re-click during a session = immediate cancel. Stop
              // spawning and drop any in-flight presses; the badge
              // is cleared by the countdown effect on next tick.
              if (autoPressOn) {
                autoPressEndAtRef.current = 0
                autoPressNextAtRef.current = Number.POSITIVE_INFINITY
                autoPressActivesRef.current = []
                setAutoPressOn(false)
                setAutoPressRemainingMs(0)
                return
              }
              const now = performance.now()
              autoPressStartRef.current = now
              // Fresh session opens at the user-persisted default
              // duration; the countdown pill lets them retune on the
              // fly (and optionally save the new value as default).
              autoPressEndAtRef.current = now + autoPressDefaultMs
              setAutoPressRemainingMs(autoPressDefaultMs)
              // Fresh session: clear any stragglers from a prior run
              // and fire the first press immediately.
              autoPressActivesRef.current = []
              autoPressNextAtRef.current = now
              // Auto-play counts as a "fresh press" for the wax two-
              // stage envelope, so re-arm the Wax4 attack; it'll fire
              // on the first synthetic press this session lands.
              waxAttackPendingRef.current = true
              setAutoPressOn(true)
            }}
            aria-label={autoPressOn ? '자동 압박 중' : '자동 압박 시작'}
            aria-pressed={autoPressOn}
            title="자동 압박"
          >
            {/* Concentric ripples — reads as "auto tapping / press
                waves". Center dot is the tap, rings are the pulse. */}
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />
              <circle cx="12" cy="12" r="6" opacity="0.6" />
              <circle cx="12" cy="12" r="10" opacity="0.3" />
            </svg>
          </button>
          <button
            type="button"
            className={styles.sideBtn}
            onClick={() => {
              applyPressReset()
              // Press-reset also snaps the text back to the front face
              // so the "text center direction" the user aimed at during
              // the previous session doesn't linger into the fresh
              // undeformed slime after a reset.
              setSlimeText((t) => ({ ...t, face: 'front' }))
            }}
            aria-label="슬라임 리셋"
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 512 512"
              fill="currentColor"
            >
              <path d="M64,256H34A222,222,0,0,1,430,118.15V85h30V190H355V160h67.27A192.21,192.21,0,0,0,256,64C150.13,64,64,150.13,64,256Zm384,0c0,105.87-86.13,192-192,192A192.21,192.21,0,0,1,89.73,352H157V322H52V427H82V393.85A222,222,0,0,0,478,256Z" />
            </svg>
          </button>
          <div className={styles.sideBtnWrap}>
            <button
              type="button"
              className={styles.sideBtn}
              data-active={
                bottomMode === 'collection' || collectionMenuOpen
              }
              onClick={() => {
                if (bottomMode === 'collection') {
                  setBottomMode('options')
                  setCollectionMenuOpen(false)
                } else {
                  setCollectionMenuOpen((v) => !v)
                }
              }}
              aria-label="컬렉션"
              aria-expanded={collectionMenuOpen}
            >
              <svg
                width="22"
                height="22"
                viewBox="0 -0.5 21 21"
                fill="currentColor"
              >
                <path d="M17.85,11 L14.7,11 C12.96015,11 11.55,12.343 11.55,14 L11.55,17 C11.55,18.657 12.96015,20 14.7,20 L17.85,20 C19.58985,20 21,18.657 21,17 L21,14 C21,12.343 19.58985,11 17.85,11 M6.3,11 L3.15,11 C1.41015,11 0,12.343 0,14 L0,17 C0,18.657 1.41015,20 3.15,20 L6.3,20 C8.03985,20 9.45,18.657 9.45,17 L9.45,14 C9.45,12.343 8.03985,11 6.3,11 M17.85,0 L14.7,0 C12.96015,0 11.55,1.343 11.55,3 L11.55,6 C11.55,7.657 12.96015,9 14.7,9 L17.85,9 C19.58985,9 21,7.657 21,6 L21,3 C21,1.343 19.58985,0 17.85,0 M9.45,3 L9.45,6 C9.45,7.657 8.03985,9 6.3,9 L3.15,9 C1.41015,9 0,7.657 0,6 L0,3 C0,1.343 1.41015,0 3.15,0 L6.3,0 C8.03985,0 9.45,1.343 9.45,3" />
              </svg>
            </button>
            {collectionMenuOpen && (
              <>
                <div
                  className={styles.collectionMenuBackdrop}
                  onClick={() => setCollectionMenuOpen(false)}
                />
                <div
                  className={`${styles.collectionMenu} ${styles.collectionMenuUp}`}
                  data-hud
                >
                  <button
                    type="button"
                    className={styles.collectionMenuBtn}
                    onClick={() => {
                      beginSaveToCollection()
                      setCollectionMenuOpen(false)
                    }}
                  >
                    저장하기
                  </button>
                  <button
                    type="button"
                    className={styles.collectionMenuBtn}
                    onClick={() => {
                      // Snapshot the WIP slime BEFORE collection auto-
                      // preview clobbers it, so the top-right × can
                      // restore what the user was building if they
                      // decide not to switch.
                      preCollectionPreviewStateRef.current =
                        buildStateSnapshot()
                      setCarouselIdx(-1)
                      setBottomMode('collection')
                      setCollectionMenuOpen(false)
                    }}
                  >
                    컬렉션 보기
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
        <div className={styles.controlsInner}>
        {bottomMode === 'options' ? (
        <>
        <CustomizePanel
          colors={colors}
          material={material}
          coating={coating}
          coatingColors={coatingColors}
          foilColors={foilColors}
          onCoatingColors={setCoatingColors}
          onFoilColors={setFoilColors}
          shape={shape}
          beads={beads}
          sprinkles={sprinkles}
          emojiBeads={emojiBeads}
          onColors={setColors}
          onMaterial={setMaterial}
          onCoating={setCoating}
          onShape={setShape}
          onBeads={setBeads}
          onSprinkles={setSprinkles}
          onEmojiBeads={setEmojiBeads}
          stickerOn={stickerOn}
          onPickSticker={handlePhotoSticker}
          onClearSticker={clearSticker}
          photoBeadSlots={photoBeads.map((t) => t !== null)}
          onPickPhotoBead={(i, f) => void setPhotoBeadAt(i, f)}
          colorAdjustments={colorAdjustments}
          onColorAdjustment={(id, dh, dl) => {
            setColorAdjustments((prev) => {
              const next = { ...prev }
              if (dh === 0 && dl === 0) delete next[id]
              else next[id] = [dh, dl]
              return next
            })
          }}
          innerSlime={innerSlime}
          onInnerSlime={setInnerSlime}
          customBeads={customBeads}
          onCustomBeads={setCustomBeads}
          customBeadsPhotoOn={customBeadsPhoto !== null}
          onPickCustomBeadsPhoto={async (file) => {
            const tex = await loadPhotoTexture(file)
            if (!tex) return
            setCustomBeadsPhoto(tex)
          }}
          onClearCustomBeadsPhoto={() => setCustomBeadsPhoto(null)}
          slimeText={slimeText}
          onSlimeText={setSlimeText}
          onTextColorImmediate={(hex) =>
            applyRef.current?.setTextColor(hex)
          }
          onActiveSlimeSubChange={setActiveSlimeSub}
          onRegisterOpenCategory={(fn) => {
            openCategoryRef.current = fn
          }}
        />
        {(() => {
          // Unified selected-option tag row — aggregates every
          // active tweak across all categories into one strip
          // between the CustomizePanel and the bottom bar. Each
          // chip has its own × to drop that specific option
          // regardless of which primary category is currently open.
          const allTags: SelectionTag[] = []
          colors.forEach((cid) => {
            allTags.push({
              key: `sc-${cid}`,
              label: '슬라임',
              swatchColor: hexToCssColor(
                resolveColorHex(cid, colorAdjustments)
              ),
              onRemove: () => setColors(colors.filter((x) => x !== cid)),
              targetCategory: 'slime',
              targetSubCategory: 'color'
            })
          })
          if (material !== 'crystal') {
            const m = MATERIALS.find((x) => x.id === material)
            if (m) {
              allTags.push({
                key: `sm-${material}`,
                label: m.label,
                onRemove: () => setMaterial('crystal'),
                targetCategory: 'slime',
                targetSubCategory: 'material'
              })
            }
          }
          if (coating !== 'none') {
            const c = COATINGS.find((x) => x.id === coating)
            // Bare coating-name tag only when NO coating colour has
            // been picked yet — once the user picks colours, each
            // colour tag already carries the coating label + swatch,
            // so the bare tag would be a redundant duplicate.
            const hasCoatingColor =
              coating === 'foil'
                ? foilColors.length > 0
                : coatingColors.length > 0
            if (c && !hasCoatingColor) {
              allTags.push({
                key: `sco-${coating}`,
                label: c.label,
                onRemove: () => setCoating('none'),
                targetCategory: 'slime',
                targetSubCategory: 'coating'
              })
            }
            // Coating colour tags — user asked for the same tag +
            // remove-only-via-× UX that body colours have. Foil coating
            // reads from foilColors (metallic palette); wax / thinwax /
            // tube / ice all read from coatingColors (slime palette).
            const usesFoilPalette = coating === 'foil'
            if (usesFoilPalette) {
              foilColors.forEach((cid) => {
                allTags.push({
                  key: `sfc-${cid}`,
                  label: c?.label ?? '코팅',
                  swatchColor: hexToCssColor(
                    resolveFoilCoatingHex(cid, colorAdjustments)
                  ),
                  onRemove: () =>
                    setFoilColors(foilColors.filter((x) => x !== cid)),
                  targetCategory: 'slime',
                  targetSubCategory: 'coating'
                })
              })
            } else {
              coatingColors.forEach((cid) => {
                allTags.push({
                  key: `scc-${cid}`,
                  label: c?.label ?? '코팅',
                  swatchColor: hexToCssColor(
                    resolveWaxCoatingHex(cid, colorAdjustments)
                  ),
                  onRemove: () =>
                    setCoatingColors(
                      coatingColors.filter((x) => x !== cid)
                    ),
                  targetCategory: 'slime',
                  targetSubCategory: 'coating'
                })
              })
            }
          }
          if (shape !== 'sphere') {
            const s = SHAPES.find((x) => x.id === shape)
            if (s) {
              allTags.push({
                key: `ssh-${shape}`,
                label: s.label,
                onRemove: () => setShape('sphere'),
                targetCategory: 'slime',
                targetSubCategory: 'shape'
              })
            }
          }
          if (stickerOn) {
            allTags.push({
              key: 'sticker',
              label: '사진 슬라임',
              onRemove: clearSticker,
              targetCategory: 'slime'
            })
          }
          {
            const trimmed = slimeText.content.trim()
            if (trimmed) {
              allTags.push({
                key: 'stext',
                label: `"${trimmed}"`,
                swatchColor: hexToCssColor(
                  resolveColorHex(slimeText.color, colorAdjustments)
                ),
                onRemove: () => setSlimeText(SLIME_TEXT_DEFAULT),
                targetCategory: 'slime',
                targetSubCategory: 'text'
              })
            }
          }
          // 미니비즈 / 속비즈 (both bind to `beads`). Active-layer tag
          // (label reflects the combo) appears any time the user has
          // dragged a count or toggled fill — removing it wipes the
          // whole bead layer back to the neutral default.
          if (
            beads.combo === 'compact' &&
            (beads.fill || beads.count > 0)
          ) {
            allTags.push({
              key: 'b-compact',
              label: beads.fill
                ? '비즈 꽉'
                : `비즈 ${beads.count}개`,
              onRemove: () => setBeads(BEADS_DEFAULT),
              targetCategory: 'compact',
              targetSubCategory: 'color'
            })
          }
          if (beads.combo === 'chunk' && beads.count > 0) {
            allTags.push({
              key: 'b-chunk',
              label: `비즈볼 ${beads.count}개`,
              onRemove: () => setBeads(BEADS_DEFAULT),
              targetCategory: 'chunk',
              targetSubCategory: 'count'
            })
          }
          if (beads.combo !== 'none') {
            const beadLabel = beads.combo === 'chunk' ? '비즈볼' : '비즈'
            const beadCategory =
              beads.combo === 'chunk' ? 'chunk' : 'compact'
            beads.colors.forEach((cid) => {
              allTags.push({
                key: `bc-${cid}`,
                label: beadLabel,
                swatchColor: hexToCssColor(
                  resolveColorHex(cid, colorAdjustments)
                ),
                onRemove: () =>
                  setBeads({
                    ...beads,
                    colors: beads.colors.filter((x) => x !== cid)
                  }),
                targetCategory: beadCategory,
                targetSubCategory: 'color'
              })
            })
            beads.shapes.forEach((sid) => {
              if (beads.shapes.length <= 1) return
              const s = BEAD_SHAPES.find((x) => x.id === sid)
              if (!s) return
              allTags.push({
                key: `bs-${sid}`,
                label: `비즈 ${s.label}`,
                onRemove: () =>
                  setBeads({
                    ...beads,
                    shapes: beads.shapes.filter((x) => x !== sid)
                  }),
                targetCategory: beadCategory,
                targetSubCategory: 'shape'
              })
            })
            if (beads.material !== 'plastic') {
              const bm = BEAD_MATERIALS.find((x) => x.id === beads.material)
              if (bm) {
                allTags.push({
                  key: `bm-${beads.material}`,
                  label: `비즈 ${bm.label}`,
                  onRemove: () => setBeads({ ...beads, material: 'plastic' }),
                  targetCategory: beadCategory,
                  targetSubCategory: 'material'
                })
              }
            }
          }
          photoBeads.forEach((tex, i) => {
            if (!tex) return
            allTags.push({
              key: `pb-${i}`,
              label: `사진 비즈 ${i + 1}`,
              onRemove: () => clearPhotoBeadAt(i),
              targetCategory: 'chunk'
            })
          })
          // 속슬라임 — active-layer tag first, then any per-detail
          // tweaks (colors / coating).
          if (innerSlime.combo !== 'none' && innerSlime.count > 0) {
            allTags.push({
              key: 'is-active',
              label: `슬라임볼 ${innerSlime.count}개`,
              onRemove: () => setInnerSlime(BEADS_DEFAULT),
              targetCategory: 'inner-slime',
              targetSubCategory: 'count'
            })
          }
          if (innerSlime.combo !== 'none') {
            innerSlime.colors.forEach((cid) => {
              allTags.push({
                key: `isc-${cid}`,
                label: '슬라임볼',
                swatchColor: hexToCssColor(
                  resolveColorHex(cid, colorAdjustments)
                ),
                onRemove: () =>
                  setInnerSlime({
                    ...innerSlime,
                    colors: innerSlime.colors.filter((x) => x !== cid)
                  }),
                targetCategory: 'inner-slime',
                targetSubCategory: 'color'
              })
            })
            if (innerSlime.coating !== 'none') {
              const bc = COATINGS.find((x) => x.id === innerSlime.coating)
              const innerCoatingColors = innerSlime.coatingColors ?? []
              // Bare coating tag only when no colour has been picked
              // — otherwise each colour tag already labels the coating.
              if (bc && innerCoatingColors.length === 0) {
                allTags.push({
                  key: `isco-${innerSlime.coating}`,
                  label: `슬라임볼 ${bc.label}`,
                  onRemove: () =>
                    setInnerSlime({ ...innerSlime, coating: 'none' }),
                  targetCategory: 'inner-slime',
                  targetSubCategory: 'coating'
                })
              }
              // Slime ball coating colour tags — same UX as slime body
              // coating tags: swatch shows the applied hue, × removes.
              innerCoatingColors.forEach((cid) => {
                allTags.push({
                  key: `iscc-${cid}`,
                  label: `슬라임볼 ${bc?.label ?? '코팅'}`,
                  swatchColor: hexToCssColor(
                    resolveInnerCoatingHex(cid, colorAdjustments)
                  ),
                  onRemove: () =>
                    setInnerSlime({
                      ...innerSlime,
                      coatingColors: innerCoatingColors.filter(
                        (x) => x !== cid
                      )
                    }),
                  targetCategory: 'inner-slime',
                  targetSubCategory: 'coating'
                })
              })
            }
          }
          // 커스텀비즈 — active-layer tag when count > 0, then colours.
          if (customBeads.count > 0) {
            allTags.push({
              key: 'cb-active',
              label: `추가비즈 ${customBeads.count}개`,
              onRemove: () => setCustomBeads(CUSTOM_BEADS_DEFAULT),
              targetCategory: 'custom-beads',
              targetSubCategory: 'count'
            })
          }
          customBeads.colors.forEach((cid) => {
            allTags.push({
              key: `cbc-${cid}`,
              label: '추가비즈',
              swatchColor: hexToCssColor(
                resolveColorHex(cid, colorAdjustments)
              ),
              onRemove: () =>
                setCustomBeads({
                  ...customBeads,
                  colors: customBeads.colors.filter((x) => x !== cid)
                }),
              targetCategory: 'custom-beads',
              targetSubCategory: 'color'
            })
          })
          if (customBeadsPhoto) {
            allTags.push({
              key: 'cbp',
              label: '커스텀 사진',
              onRemove: () => setCustomBeadsPhoto(null),
              targetCategory: 'custom-beads'
            })
          }
          // 스프링클 (per type) — per-colour tags only. The active
          // (count / fill) state is implicit from the colour chips
          // present; removing every colour of a type zeros its count
          // via onRemove below.
          ;(['paper', 'powder', 'ink'] as const).forEach((typeId) => {
            const cfg = sprinkles[typeId]
            const isFilled = 'fill' in cfg && cfg.fill
            if (cfg.count === 0 && !isFilled) return
            const typeLabel =
              typeId === 'paper' ? '스팽글' : typeId === 'powder' ? '가루' : '잉크'
            cfg.colors.forEach((cid) => {
              const c = SPRINKLE_COLORS.find((x) => x.id === cid)
              if (!c) return
              allTags.push({
                key: `sp-${typeId}-${cid}`,
                label: typeLabel,
                swatchColor: hexToCssColor(c.hex),
                targetCategory: typeId,
                targetSubCategory: 'color',
                onRemove: () => {
                  const next = cfg.colors.filter((x) => x !== cid)
                  // Dropping the last colour also zeroes the count/fill
                  // so the sprinkle layer turns off entirely.
                  if (next.length === 0) {
                    if (typeId === 'ink') {
                      setSprinkles({
                        ...sprinkles,
                        ink: { ...sprinkles.ink, colors: next, count: 0 }
                      })
                    } else {
                      setSprinkles({
                        ...sprinkles,
                        [typeId]: {
                          ...sprinkles[typeId],
                          colors: next,
                          count: 0,
                          fill: false
                        }
                      })
                    }
                  } else {
                    setSprinkles({
                      ...sprinkles,
                      [typeId]: { ...cfg, colors: next }
                    })
                  }
                }
              })
            })
          })
          // 이모지
          emojiBeads.emojis.forEach((e) => {
            allTags.push({
              key: `em-${e}`,
              label: e,
              onRemove: () =>
                setEmojiBeads({
                  ...emojiBeads,
                  emojis: emojiBeads.emojis.filter((x) => x !== e)
                }),
              targetCategory: 'theme'
            })
          })
          // "슬라임 안" toggle now lives at the top-left of the 4
          // embed-capable sub-panels inside CustomizePanel itself, so
          // no per-category branching is needed here.
          if (allTags.length === 0) return null
          return (
            <div className={styles.unifiedTagWrap}>
              <button
                type="button"
                className={styles.unifiedTagResetBtn}
                onClick={resetToDefaults}
                aria-label="모든 옵션 초기화"
                title="모든 옵션 초기화"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 512 512"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M64,256H34A222,222,0,0,1,430,118.15V85h30V190H355V160h67.27A192.21,192.21,0,0,0,256,64C150.13,64,64,150.13,64,256Zm384,0c0,105.87-86.13,192-192,192A192.21,192.21,0,0,1,89.73,352H157V322H52V427H82V393.85A222,222,0,0,0,478,256Z" />
                </svg>
              </button>
              <div
                ref={setUnifiedTagRowEl}
                className={styles.unifiedTagRow}
                data-at-start={unifiedTagAtStart ? 'true' : undefined}
                data-at-end={unifiedTagAtEnd ? 'true' : undefined}
              >
              {allTags.map((t) => {
                const jump = t.targetCategory
                  ? () =>
                      openCategoryRef.current?.(
                        t.targetCategory!,
                        t.targetSubCategory
                      )
                  : undefined
                return (
                  <span
                    key={t.key}
                    className={styles.unifiedTag}
                    data-swatch={t.swatchColor ? 'true' : undefined}
                    data-clickable={jump ? 'true' : undefined}
                    role={jump ? 'button' : undefined}
                    tabIndex={jump ? 0 : undefined}
                    onClick={jump}
                    onKeyDown={
                      jump
                        ? (e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              jump()
                            }
                          }
                        : undefined
                    }
                  >
                    {t.label && (
                      <span className={styles.unifiedTagLabel}>{t.label}</span>
                    )}
                    {t.swatchColor && (
                      <span
                        className={styles.unifiedTagSwatch}
                        style={{ background: t.swatchColor }}
                        aria-hidden="true"
                      />
                    )}
                    <button
                      type="button"
                      className={styles.unifiedTagRemove}
                      onClick={(e) => {
                        e.stopPropagation()
                        t.onRemove()
                      }}
                      aria-label={`${t.label ?? '옵션'} 제거`}
                    >
                      ×
                    </button>
                  </span>
                )
              })}
              </div>
            </div>
          )
        })()}
        </>
        ) : (() => {
          const items = collection.filter((c) => c.thumb)
          // Empty state is rendered as a centered full-screen overlay
          // outside this bottom panel (the panel itself is hidden via
          // isEmptyCollection), so there's nothing to draw here.
          if (items.length === 0) return null
          // Effective selection index. carouselIdx starts at -1 on
          // entry but the auto-preview useEffect already loads the
          // FIRST card into the top slime — so the highlight has to
          // land on card 0 too, otherwise the preview looks orphaned
          // from any card in the strip. Stale idx past the current
          // items length also snaps to the last card.
          const clamped =
            carouselIdx < 0
              ? 0
              : Math.min(carouselIdx, items.length - 1)
          return (
            <>
            {/* Above-carousel action bar — hosts both normal-mode
                actions (압박리셋 / 수정하기 / 공유) and delete-mode
                actions (취소 / 삭제 / 전체선택). Same position;
                content swaps based on deleteMode. */}
            <div className={styles.collectionCarouselAboveBar}>
              {deleteMode ? (
                <>
                  <button
                    type="button"
                    className={styles.collectionCarouselAction}
                    onClick={() => {
                      setDeleteMode(false)
                      setSelectedForDelete(new Set())
                    }}
                  >
                    취소
                  </button>
                  <button
                    type="button"
                    className={styles.collectionCarouselAction}
                    data-danger="true"
                    disabled={selectedForDelete.size === 0}
                    onClick={() => {
                      setCollection((c) =>
                        c.filter((entry) => !selectedForDelete.has(entry.id))
                      )
                      setDeleteMode(false)
                      setSelectedForDelete(new Set())
                      setCarouselIdx(-1)
                    }}
                  >
                    삭제 ({selectedForDelete.size})
                  </button>
                  <button
                    type="button"
                    className={styles.collectionCarouselAction}
                    onClick={() => {
                      const allSelected =
                        selectedForDelete.size === items.length
                      setSelectedForDelete(
                        allSelected
                          ? new Set()
                          : new Set(items.map((e) => e.id))
                      )
                    }}
                  >
                    {selectedForDelete.size === items.length
                      ? '선택 해제'
                      : '전체선택'}
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className={styles.collectionCarouselAction}
                    onClick={() => applyPressReset()}
                    aria-label="압박 리셋"
                    title="압박 리셋"
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 512 512"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <path d="M64,256H34A222,222,0,0,1,430,118.15V85h30V190H355V160h67.27A192.21,192.21,0,0,0,256,64C150.13,64,64,150.13,64,256Zm384,0c0,105.87-86.13,192-192,192A192.21,192.21,0,0,1,89.73,352H157V322H52V427H82V393.85A222,222,0,0,0,478,256Z" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className={styles.collectionCarouselAction}
                    onClick={() => {
                      preCollectionPreviewStateRef.current = null
                      setBottomMode('options')
                    }}
                  >
                    수정하기
                  </button>
                  <button
                    type="button"
                    className={styles.collectionCarouselAction}
                    onClick={() => void handleShare()}
                    aria-label="공유"
                    title="공유"
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      {/* Classic 3-node share glyph — matches the
                          top-right main share button. */}
                      <circle cx="18" cy="5" r="3" />
                      <circle cx="6" cy="12" r="3" />
                      <circle cx="18" cy="19" r="3" />
                      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
                      <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
                    </svg>
                  </button>
                </>
              )}
            </div>
            <div className={styles.collectionCarousel}>
              <div className={styles.collectionCarouselScroller}>
              <div className={styles.collectionCarouselTrack}>
                {items.map((entry, i) => {
                  const isSel = i === clamped
                  // Compact-fill (꽉비즈) slimes get a shrunk thumbnail
                  // — the packed bead shell makes the saved silhouette
                  // read visually LARGER than plain slimes at the same
                  // card size, so we scale the img down inside the
                  // thumb container to match perceived scale.
                  const stateBeads = (entry.state as {
                    b?: BeadsConfig
                  } | null | undefined)?.b
                  const isCompactCard =
                    !!stateBeads &&
                    stateBeads.combo === 'compact' &&
                    (stateBeads.fill || stateBeads.count > 0)
                  return (
                    <div
                      key={entry.id}
                      className={styles.collectionCarouselCard}
                      data-selected={
                        deleteMode ? selectedForDelete.has(entry.id) : isSel
                      }
                      data-compact={isCompactCard ? 'true' : undefined}
                      onPointerDown={(e) => {
                        const el = e.currentTarget as HTMLElement
                        window.clearTimeout(
                          Number(el.dataset.longPressTimer ?? 0)
                        )
                        const id = window.setTimeout(() => {
                          setDeleteMode(true)
                          setSelectedForDelete(new Set([entry.id]))
                        }, 500)
                        el.dataset.longPressTimer = String(id)
                      }}
                      onPointerUp={(e) => {
                        const el = e.currentTarget as HTMLElement
                        window.clearTimeout(
                          Number(el.dataset.longPressTimer ?? 0)
                        )
                        delete el.dataset.longPressTimer
                      }}
                      onPointerLeave={(e) => {
                        const el = e.currentTarget as HTMLElement
                        window.clearTimeout(
                          Number(el.dataset.longPressTimer ?? 0)
                        )
                        delete el.dataset.longPressTimer
                      }}
                      onClick={() => {
                        if (deleteMode) {
                          setSelectedForDelete((prev) => {
                            const next = new Set(prev)
                            if (next.has(entry.id)) next.delete(entry.id)
                            else next.add(entry.id)
                            return next
                          })
                        } else {
                          setCarouselIdx(i)
                        }
                      }}
                    >
                      <div className={styles.collectionCarouselThumb}>
                        {entry.thumb && (
                          <img
                            src={entry.thumb}
                            alt={entry.name}
                            draggable={false}
                          />
                        )}
                      </div>
                      <div className={styles.collectionCarouselName}>
                        {entry.name}
                      </div>
                      {deleteMode && (
                        <div
                          className={styles.collectionCarouselCheckbox}
                          data-checked={selectedForDelete.has(entry.id)}
                          aria-label={
                            selectedForDelete.has(entry.id)
                              ? '삭제 선택 해제'
                              : '삭제 선택'
                          }
                        >
                          {selectedForDelete.has(entry.id) && (
                            <svg
                              width="12"
                              height="12"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.4"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              aria-hidden="true"
                            >
                              <polyline points="4 12 10 18 20 6" />
                            </svg>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
              </div>
            </div>
            </>
          )
        })()}
        </div>

      </div>

      {busy && (
        <div className={styles.overlay}>
          <div className={styles.overlayText}>{busyLabel || '준비 중…'}</div>
        </div>
      )}
    </div>
  )
}
