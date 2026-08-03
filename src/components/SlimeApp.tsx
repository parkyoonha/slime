import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { useHandLandmarker } from '../hooks/useHandLandmarker'
import { SlimeSphere, type WeightedTip } from '../slime/SlimeSphere'
import { BeadsLayer } from '../slime/BeadsLayer'
import { EmojiBeadsLayer } from '../slime/EmojiBeadsLayer'
import { SprinklesLayer } from '../slime/SprinklesLayer'
import {
  BEADS_DEFAULT,
  COLORS,
  EMOJI_BEADS_DEFAULT,
  SPRINKLE_COLORS,
  SPRINKLES_DEFAULT,
  SPRINKLES_LIMITS,
  type BeadsConfig,
  type CoatingColorId,
  type CoatingId,
  type ColorId,
  type EmojiBeadsConfig,
  type MaterialId,
  type ShapeId,
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
import CustomizePanel from './CustomizePanel'
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
function computeInitialScale(): number {
  if (typeof window === 'undefined') return 1.15
  const aspect = window.innerWidth / (window.innerHeight || 1)
  const worldHeight = 2 * CAMERA_Z * Math.tan((CAMERA_FOV * Math.PI) / 360)
  const worldWidth = worldHeight * aspect
  const narrower = Math.min(worldWidth, worldHeight)
  // Diameter = 2 × radius (=1) × scale. Target 1.15× the narrower dim so
  // the sphere sits right at the viewport edges once the panel-open
  // shrink factor applies. Cap at 1.4 so desktop also gets a healthy
  // starting size instead of being clamped to 1.0.
  const scale = (narrower * 1.15) / 2
  return Math.min(1.4, Math.max(SCALE_MIN, scale))
}

// Slime-squish sample files. Files that exist under public/sounds/ are used
// verbatim; missing ones are silently skipped. Add more clips for variety —
// the sample scheduler picks one at random per squelch tick.
const SQUISH_SAMPLE_URLS = [
  '/sounds/squish_1.mp3',
  '/sounds/squish_2.mp3',
  '/sounds/squish_3.mp3',
  '/sounds/squish_4.mp3',
  '/sounds/squish_5.mp3',
  '/sounds/squish_6.mp3',
  '/sounds/squish_7.mp3',
  '/sounds/squish_8.mp3'
]

// Coating- / beads-specific one-shot sample files. Loaded once on mount and
// triggered from the render loop when the corresponding coating is active
// and the slime is being pressed hard enough.
const NAMED_SAMPLE_URLS = {
  wax: '/sounds/Wak.mp3',
  foil: '/sounds/Hoil.mp3',
  beads: '/sounds/Biz.mp3',
  paper: '/sounds/Sprink.mp3',
  matte: '/sounds/Sprinkle.mp3',
  metal: '/sounds/Popp.mp3',
  // Ambient loop that fires when the user presses a slime that has
  // emojis on it (Play.mp3). Same continuous-loop pattern as beads /
  // paper — gain tracks pressure, silent otherwise.
  emoji: '/sounds/Play.mp3'
} as const

// Optional [startSec, endSec] source-range constraints for each named
// sample. Only random windows within these bounds are played, so a single
// mp3 containing several distinct sounds can be pointed at the desired
// segment. Set to `null` to allow the full recording. Adjust the wax
// range to pick the exact section of Wak.mp3 you want as the crack sound.
const NAMED_SAMPLE_RANGES: Record<
  'wax' | 'foil' | 'beads' | 'paper' | 'matte' | 'metal' | 'emoji',
  readonly [number, number] | null
> = {
  wax: [0.5, 1.5],
  // Skip the first 3.4s of Hoil.mp3 and loop the rest. 999 is a
  // sentinel — setLoopingSampleLevel clamps loopEnd to the buffer
  // duration, so this always resolves to "3.4s → end of file".
  foil: [3.4, 999],
  beads: null,
  paper: null,
  matte: null,
  metal: null,
  emoji: null
}

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
  const { status: handStatus, error: handError, detect } = useHandLandmarker()
  const [cameraStatus, setCameraStatus] = useState<
    'idle' | 'requesting' | 'ready' | 'error'
  >('idle')
  const [cameraError, setCameraError] = useState<string | null>(null)
  // Hand tracking toggle — now gates the entire camera + MediaPipe
  // pipeline, not just the skeleton overlay. When OFF: no camera stream,
  // no `detect()` calls, no overlay. Touch/pointer input still works
  // (that's the low-power interaction path). Persisted across sessions
  // so a user who prefers touch-only doesn't have to re-toggle each
  // launch. Default TRUE preserves the original out-of-box hand-
  // interaction feel; users who want to save battery can turn it off.
  const [skeletonOn, setSkeletonOn] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true
    const saved = window.localStorage.getItem('wakbu-hand-tracking')
    return saved === null ? true : saved === 'true'
  })
  const skeletonOnRef = useRef(skeletonOn)
  useEffect(() => {
    skeletonOnRef.current = skeletonOn
    try {
      window.localStorage.setItem('wakbu-hand-tracking', String(skeletonOn))
    } catch {
      // Private-mode storage error — toggle still works for the session.
    }
  }, [skeletonOn])

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
  const [colors, setColors] = useState<ColorId[]>(['pearl'])
  const [material, setMaterial] = useState<MaterialId>('crystal')
  const [coating, setCoating] = useState<CoatingId>('none')
  // Wax / ice coating tint — multi-select array so 2+ colours paint a
  // top-to-bottom gradient across the coating (single-pick keeps the flat
  // tint). Draws from the general COLORS palette because those coatings
  // are ordinary pigmented surfaces (waxes, frozen shells).
  const [coatingColors, setCoatingColors] = useState<ColorId[]>(['gold'])
  // Foil surface colour — same multi-select story but sourced from a
  // narrower COATING_COLORS palette of saturated metallic hues. Kept
  // separate from `coatingColors` so switching between wax and foil
  // preserves each palette's last pick independently.
  const [foilColors, setFoilColors] = useState<CoatingColorId[]>(['silver'])
  const [shape, setShape] = useState<ShapeId>('sphere')
  const [beads, setBeads] = useState<BeadsConfig>(BEADS_DEFAULT)
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
  const [guideOpen, setGuideOpen] = useState(false)
  // Collection dropdown — bookmark button top-right toggles a small
  // menu with "저장하기" and "컬렉션 보기" buttons.
  const [collectionMenuOpen, setCollectionMenuOpen] = useState(false)
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
  // Snapshot of the user's WIP slime taken the instant they entered
  // browse mode. The "×" close button restores this so previewing a
  // saved slime doesn't destroy in-progress work.
  const preBrowseStateRef = useRef<unknown | null>(null)
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
  // Emoji move mode — modal toggle. When ON, slime press is
  // disabled and any tap/drag on the slime moves emojis instead.
  // Off is the normal state (press works, emojis stay put).
  const [emojiMoveOn, setEmojiMoveOn] = useState(false)
  const emojiMoveOnRef = useRef(emojiMoveOn)
  useEffect(() => {
    emojiMoveOnRef.current = emojiMoveOn
  }, [emojiMoveOn])
  // Auto-exit emoji move mode when the emoji layer becomes empty
  // (user removed all emojis). Prevents an orphan mode where the
  // toggle button disappears but press stays disabled.
  useEffect(() => {
    const hasEmojis =
      emojiBeads.emojis.length > 0 && emojiBeads.count > 0
    if (!hasEmojis && emojiMoveOn) setEmojiMoveOn(false)
  }, [emojiBeads, emojiMoveOn])
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
      theme === 'light' ? 0xe5deec : 0x1a1130
    )
  }, [theme])

  // Imperative handles exposed by the scene effect.
  const applyRef = useRef<{
    setColors: (v: readonly ColorId[]) => void
    setMaterial: (v: MaterialId) => void
    setCoating: (v: CoatingId) => void
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
    applyRef.current?.setMaterial(material)
  }, [material])
  useEffect(() => {
    applyRef.current?.setCoating(coating)
  }, [coating])
  // Single effect that resolves the "active coating colour" — foil reads
  // from the metallic palette (COATING_COLORS) while wax / ice read from
  // the general slime palette (COLORS). Triggers on coating change too
  // so switching wax→foil (or vice versa) immediately swaps the hex
  // pushed to the material.
  useEffect(() => {
    // Coating tint now MIRRORS the slime's own colour picks — no
    // separate coating palette. Applying wax/foil/tube/ice keeps the
    // colours the user chose for the slime body so the piece stays
    // visually consistent (wax coating in the same tone as the
    // slime, foil in the same tone, etc.). Single pick → flat tint,
    // 2+ picks → gradient handled by slime.setCoatingColors.
    const hexes = colors
      .map((id) => COLORS.find((c) => c.id === id)?.hex)
      .filter((h): h is number => typeof h === 'number')
    applyRef.current?.setCoatingColors(
      hexes.length > 0 ? hexes : [0xfbf7f2]
    )
  }, [coating, colors])
  useEffect(() => {
    applyRef.current?.setShape(shape)
  }, [shape])
  useEffect(() => {
    applyRef.current?.setBeads(beads)
  }, [beads])
  useEffect(() => {
    applyRef.current?.setSprinkles(sprinkles)
  }, [sprinkles])
  useEffect(() => {
    applyRef.current?.setEmojiBeads(emojiBeads)
  }, [emojiBeads])
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
  const resetToDefaults = () => {
    setColors(['pearl'])
    setMaterial('crystal')
    setCoating('none')
    setCoatingColors(['gold'])
    setFoilColors(['silver'])
    setShape('sphere')
    setBeads(BEADS_DEFAULT)
    setSprinkles(SPRINKLES_DEFAULT)
    setEmojiBeads(EMOJI_BEADS_DEFAULT)
    applyRef.current?.reset()
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
    e: emojiBeads
  })

  // Apply a decoded snapshot to the live customisation. Missing /
  // wrong-typed fields are silently skipped so partial or old-format
  // snapshots don't break the app.
  const applyStateSnapshot = (raw: unknown) => {
    if (!raw || typeof raw !== 'object') return
    const s = raw as Record<string, unknown>
    if (Array.isArray(s.c) && s.c.length > 0) setColors(s.c as ColorId[])
    if (typeof s.m === 'string') setMaterial(s.m as MaterialId)
    if (typeof s.co === 'string') setCoating(s.co as CoatingId)
    if (Array.isArray(s.cc) && s.cc.length > 0)
      setCoatingColors(s.cc as ColorId[])
    else if (typeof s.cc === 'string')
      setCoatingColors([s.cc as ColorId])
    if (Array.isArray(s.fc) && s.fc.length > 0)
      setFoilColors(s.fc as CoatingColorId[])
    else if (typeof s.fc === 'string')
      setFoilColors([s.fc as CoatingColorId])
    if (typeof s.sh === 'string') setShape(s.sh as ShapeId)
    if (s.b && typeof s.b === 'object') setBeads(s.b as BeadsConfig)
    if (s.sp && typeof s.sp === 'object')
      setSprinkles(s.sp as SprinklesConfig)
    if (s.e && typeof s.e === 'object')
      setEmojiBeads(s.e as EmojiBeadsConfig)
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
      title: '왁부 슬라임',
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

  // Enter browse mode — load the FIRST saved slime and let the user
  // swipe horizontally through the rest.
  const startBrowsing = () => {
    const visible = collection.filter((c) => c.thumb)
    if (visible.length === 0) {
      setToast('저장된 슬라임이 없어요')
      window.setTimeout(() => setToast(null), 2000)
      return
    }
    // Snapshot the CURRENT work-in-progress state before loading a
    // saved slime so the × close button can restore it later.
    preBrowseStateRef.current = buildStateSnapshot()
    setBrowseIdx(0)
    applyStateSnapshot(visible[0].state)
    setPreviewMode(false)
    setBrowsePressed(false)
    autoSpinUntilRef.current = performance.now() + 600
    setCollectionMenuOpen(false)
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
        applyRef.current?.reset()
        autoSpinUntilRef.current = performance.now() + 600
      }
    }
  }


  const handleShare = async () => {
    const url = encodeShareUrl()
    const payload = {
      title: '왁부 슬라임',
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
    void engine?.loadNamedSample('wax', NAMED_SAMPLE_URLS.wax)
    void engine?.loadNamedSample('foil', NAMED_SAMPLE_URLS.foil)
    void engine?.loadNamedSample('beads', NAMED_SAMPLE_URLS.beads)
    void engine?.loadNamedSample('paper', NAMED_SAMPLE_URLS.paper)
    void engine?.loadNamedSample('matte', NAMED_SAMPLE_URLS.matte)
    void engine?.loadNamedSample('metal', NAMED_SAMPLE_URLS.metal)
    void engine?.loadNamedSample('emoji', NAMED_SAMPLE_URLS.emoji)
    engine?.setNamedSampleRange('wax', NAMED_SAMPLE_RANGES.wax)
    engine?.setNamedSampleRange('foil', NAMED_SAMPLE_RANGES.foil)
    engine?.setNamedSampleRange('beads', NAMED_SAMPLE_RANGES.beads)
    engine?.setNamedSampleRange('paper', NAMED_SAMPLE_RANGES.paper)
    engine?.setNamedSampleRange('matte', NAMED_SAMPLE_RANGES.matte)
    engine?.setNamedSampleRange('metal', NAMED_SAMPLE_RANGES.metal)
    engine?.setNamedSampleRange('emoji', NAMED_SAMPLE_RANGES.emoji)
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
  // Paper sprinkle activity — mirror React state to a ref so the render
  // loop can drive its sound scheduler each frame.
  const paperActiveRef = useRef<boolean>(false)
  useEffect(() => {
    paperActiveRef.current =
      sprinkles.paper.fill || sprinkles.paper.count > 0
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
    const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
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
      color: theme === 'light' ? 0xe5deec : 0x1a1130,
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

    // Two independent SprinklesLayers so paper + powder can render together.
    // Each takes a type-specific slice of SprinklesConfig. Ink is a shader
    // effect, not a layer — routed straight to slime.setInk.
    const paperLayer = new SprinklesLayer()
    const powderLayer = new SprinklesLayer()
    slime.mesh.add(paperLayer.group)
    slime.mesh.add(powderLayer.group)

    const emojiBeadsLayer = new EmojiBeadsLayer()
    slime.mesh.add(emojiBeadsLayer.group)
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
      beadsLayer.syncWrapToSlime(slime.getSurfaceParams())
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
      setCoating: (v) => {
        slime.setCoating(v)
        syncBeadWrap()
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
      },
      setBeads: (v) => {
        beadsLayer.setConfig(
          v,
          slime.unitDirsArray,
          slime.restPositionArray,
          slime.shape
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
            fill: v.paper.fill
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
          const primaryColorHex =
            SPRINKLE_COLORS.find((c) => c.id === v.ink.colors[0])?.hex ??
            0xffffff
          const amount = Math.max(
            0,
            v.ink.count / SPRINKLES_LIMITS.inkAmountDivisor
          )
          slime.setInk(primaryColorHex, amount)
        } else {
          slime.setInk(0xffffff, 0)
        }
      },
      setEmojiBeads: (v) =>
        emojiBeadsLayer.setConfig(
          { emojis: v.emojis, size: v.size, count: v.count },
          slime.unitDirsArray
        ),
      setEmojiGhost: (v) => emojiBeadsLayer.setGhostVisible(v),
      setEmojiBeadLift: (h) => emojiBeadsLayer.setBeadLift(h),
      setSceneBackground: (hex) => bgMaterial.color.setHex(hex),
      reset: () => {
        slime.reset()
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
      },
      captureCanonicalThumbnail: () => {
        // Snapshot mesh transform, force it to canonical (a modest
        // scale that keeps the slime clearly inside a portrait-
        // phone canvas, identity rotation, origin), render one
        // frame, capture, then restore so the live view isn't
        // disturbed. Scale 1 was oversized on narrow canvases and
        // cropped the slime — 0.65 leaves comfortable margin so
        // the thumbnail always shows the whole shape.
        const savedScale = slime.mesh.scale.clone()
        const savedQuat = slime.mesh.quaternion.clone()
        const savedPos = slime.mesh.position.clone()
        slime.mesh.scale.setScalar(0.5)
        slime.mesh.quaternion.identity()
        slime.mesh.position.set(0, 0, 0)
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
          return off.toDataURL('image/jpeg', 0.7)
        } catch {
          return undefined
        } finally {
          slime.mesh.scale.copy(savedScale)
          slime.mesh.quaternion.copy(savedQuat)
          slime.mesh.position.copy(savedPos)
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

    function currentBeadInfo() {
      const cfg = beadsLayer.currentConfig
      const active = cfg.fill || cfg.count > 0
      if (!active) return null
      const positions = beadsLayer.getBeadRestPositions(
        slime.unitDirsArray,
        slime.restPositionArray
      )
      if (positions.length === 0) return null
      return { positions, size: cfg.size }
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
      s.setLoopingSampleLevel('wax', 0)
      s.setLoopingSampleLevel('foil', 0)
      s.setLoopingSampleLevel('paper', 0)
      s.setLoopingSampleLevel('beads', 0)
      s.setLoopingSampleLevel('emoji', 0)
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
      paperLayer.update(slime.positionArray, slime.normalArray)
      powderLayer.update(slime.positionArray, slime.normalArray)
      emojiBeadsLayer.update(slime.positionArray, slime.restPositionArray)

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
        const currentMaterial = materialRef.current
        const isMatte = currentMaterial === 'matte'
        const isMetal = currentMaterial === 'metal'
        sound.setSquishLevel(isMatte || isMetal ? 0 : soundLevel)
        sound.setLoopingSampleLevel(
          'matte',
          isMatte ? soundLevel : 0
        )
        sound.setLoopingSampleLevel(
          'metal',
          isMetal ? soundLevel : 0
        )

        // Wax and foil (+ tube reusing foil) are CONTINUOUS ambient
        // recordings ("치이이이익" style), so they use
        // setLoopingSampleLevel — a single looping AudioBufferSourceNode
        // with gain following press pressure — instead of the discrete-
        // pop scheduler used for procedural crack sounds. The scheduler
        // path chops the sample into short windows and plays them one
        // after another, which turns a continuous hiss into "칙칙칙".
        //
        // Slime AND a coated chunk bead can each request a crack sound
        // this frame — they share smoothedPressure (whichever surface
        // is being pressed drives it), and we pick the max level per
        // named sample so whichever coating is present triggers its
        // sound. Tube reuses foil's sample, matching how SlimeSphere
        // collapses tube→foil for its damage shader.
        const coatingId = coatingRef.current
        const beadCoatingId = beadCoatingRef.current
        const slimeCracks = slime.damageRenderingEnabled
        const slimeWaxLevel =
          slimeCracks && coatingId === 'wax' ? soundLevel : 0
        const slimeFoilLevel =
          slimeCracks && (coatingId === 'foil' || coatingId === 'tube')
            ? soundLevel
            : 0
        const slimeIsIce = slimeCracks && coatingId === 'ice'
        const beadWaxLevel =
          beadCoatingId === 'wax' ? soundLevel : 0
        const beadFoilLevel =
          beadCoatingId === 'foil' || beadCoatingId === 'tube'
            ? soundLevel
            : 0
        const beadIsIce = beadCoatingId === 'ice'

        sound.setLoopingSampleLevel(
          'wax',
          Math.max(slimeWaxLevel, beadWaxLevel)
        )
        sound.setLoopingSampleLevel(
          'foil',
          Math.max(slimeFoilLevel, beadFoilLevel)
        )
        // Ice / caramel: procedural crack fires on the slime's per-frame
        // press stress crossing 0.5. Slime-ice and bead-ice trigger
        // through the same press metric — bead-specific pressure isn't
        // tracked separately.
        if ((slimeIsIce || beadIsIce) && slime.pressureThisFrame > 0.5) {
          sound.playCrack(
            Math.min(1, 0.4 + slime.pressureThisFrame / 45)
          )
        }

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
          'beads',
          beadsActiveRef.current ? soundLevel : 0
        )
        sound.setLoopingSampleLevel(
          'emoji',
          emojiActiveRef.current ? soundLevel : 0
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
      const targetShiftY = frac * viewportWorldHeight * 0.3
      const targetPanelScale = 1 - frac * 0.1
      currentPanelShiftY += (targetShiftY - currentPanelShiftY) * 0.15
      currentPanelScale += (targetPanelScale - currentPanelScale) * 0.15
      slime.mesh.position.y = currentPanelShiftY
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

  return (
    <div className={styles.root}>
      <video
        ref={videoRef}
        className={styles.video}
        playsInline
        muted
        autoPlay
      />
      <canvas ref={canvasRef} className={styles.canvas} />
      <canvas ref={overlayRef} className={styles.overlayCanvas} />

      <div
        className={styles.topBar}
        data-hud
        style={browseIdx !== null ? { display: 'none' } : undefined}
      >
        {emojiBeads.emojis.length > 0 && emojiBeads.count > 0 && (
          <button
            type="button"
            className={styles.iconButton}
            data-active={emojiMoveOn}
            onClick={() => setEmojiMoveOn((v) => !v)}
            aria-label="이모지 위치 변경"
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
        <div className={styles.collectionMenuWrap}>
          <button
            type="button"
            className={styles.iconButton}
            onClick={() => setCollectionMenuOpen((v) => !v)}
            aria-label="컬렉션"
            aria-expanded={collectionMenuOpen}
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
              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
            </svg>
          </button>
          {collectionMenuOpen && (
            <>
              <div
                className={styles.collectionMenuBackdrop}
                onClick={() => setCollectionMenuOpen(false)}
              />
              <div className={styles.collectionMenu} data-hud>
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
                  onClick={startBrowsing}
                >
                  컬렉션 보기
                </button>
              </div>
            </>
          )}
        </div>
        <button
          type="button"
          className={styles.iconButton}
          onClick={() => setGuideOpen(true)}
          aria-label="가이드"
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
            <circle cx="12" cy="12" r="9" />
            <path d="M9.5 9.5a2.5 2.5 0 0 1 5 0c0 1.5-2.5 2-2.5 3.5" />
            <line x1="12" y1="17" x2="12" y2="17.01" />
          </svg>
        </button>
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
            <path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7" />
            <polyline points="16 6 12 2 8 6" />
            <line x1="12" y1="2" x2="12" y2="15" />
          </svg>
        </button>
        <button
          type="button"
          className={styles.iconButton}
          onClick={() => setMenuOpen(true)}
          aria-label="메뉴"
          aria-expanded={menuOpen}
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
            <line x1="4" y1="9" x2="20" y2="9" />
            <line x1="4" y1="15" x2="20" y2="15" />
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
              <button
                type="button"
                className={styles.drawerItem}
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false)
                  setToast('사용자 · 준비 중')
                  window.setTimeout(() => setToast(null), 1500)
                }}
              >
                사용자
              </button>
              <button
                type="button"
                className={styles.drawerItem}
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false)
                  setToast('구독 · 준비 중')
                  window.setTimeout(() => setToast(null), 1500)
                }}
              >
                구독
              </button>
              {/* Theme picker — segmented control inline with the other
                  drawer items so the label is visible and the two options
                  live side-by-side. Clicking flips the theme immediately
                  and keeps the drawer open so the user can preview the
                  change. */}
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
          </aside>
        </>
      )}

      {guideOpen && (
        <div
          className={styles.modalBackdrop}
          onClick={() => setGuideOpen(false)}
        >
          <div
            className={styles.modal}
            data-hud
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.modalTitle}>사용 가이드</div>
            <ul className={styles.modalList}>
              <li>손 펴서 눌러 납작하게</li>
              <li>손 오므리면 힘 뺌</li>
              <li>드래그: 회전</li>
              <li>핀치: 크기</li>
            </ul>
            <button
              type="button"
              className={styles.modalClose}
              onClick={() => setGuideOpen(false)}
            >
              닫기
            </button>
          </div>
        </div>
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
                      applyRef.current?.reset()
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
                applyRef.current?.reset()
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

      <div
        ref={controlsRef}
        className={styles.controls}
        data-hud
        // Hide the customization panel + bottom toolbar entirely
        // while browsing a saved collection — the user is picking a
        // slime, not editing.
        style={browseIdx !== null ? { display: 'none' } : undefined}
      >
        <CustomizePanel
          colors={colors}
          material={material}
          coating={coating}
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
        />

        <div className={styles.compactRow}>
          <button
            type="button"
            className={styles.toggle}
            data-active={skeletonOn}
            onClick={() => setSkeletonOn((v) => !v)}
            aria-label="손 감지 토글"
            aria-pressed={skeletonOn}
          >
            {skeletonOn ? '손 감지 켬' : '손 감지 끔'}
          </button>
          <button
            type="button"
            className={styles.toggle}
            onClick={() => applyRef.current?.reset()}
            aria-label="슬라임 리셋"
          >
            ↻ 리셋
          </button>
          <button
            type="button"
            className={styles.toggle}
            onClick={resetToDefaults}
            aria-label="디폴트로 되돌리기"
          >
            ✦ 디폴트
          </button>
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
