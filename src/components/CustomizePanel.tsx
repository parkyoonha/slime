import { useEffect, useId, useRef, useState } from 'react'
import {
  BEAD_COLORS,
  BEAD_COMBOS,
  BEAD_MATERIALS,
  COMPACT_BEAD_MATERIALS,
  CHUNK_BEAD_MATERIALS,
  BEAD_SHAPES,
  BEADS_LIMITS,
  CUSTOM_BEADS_LIMITS,
  beadShapesMaxSize,
  beadShapesMinSize,
  COATING_COLORS,
  COATINGS,
  COLORS,
  resolveColorHex,
  resolveColorLabel,
  resolveCustomBeadHex,
  resolveFoilCoatingHex,
  resolveInnerCoatingHex,
  resolveWaxCoatingHex,
  EMOJI_BEADS_LIMITS,
  MATERIALS,
  SHAPES,
  SLIME_TEXT_DEFAULT,
  SPRINKLE_COLORS,
  SPRINKLE_MATERIALS,
  SPRINKLE_MATERIALS_BY_TYPE,
  SPRINKLE_SHAPES,
  SPRINKLE_SUB_CATEGORIES,
  SPRINKLE_TYPES,
  SPRINKLES_DEFAULT,
  SPRINKLES_LIMITS,
  THEMES,
  beadChunkMaxCount,
  type BeadCombo,
  type BeadShapeId,
  type BeadsConfig,
  type CoatingColorId,
  type CoatingId,
  type ColorAdjustments,
  type ColorId,
  type CustomBeadsConfig,
  type EmojiBeadsConfig,
  type MaterialId,
  type ShapeId,
  type SlimeText,
  SPANGLE_KINDS,
  type SprinkleColorId,
  type SprinkleTypeId,
  type SprinklesConfig
} from '../slime/presets'
import { useTr } from '../i18n'
import styles from './CustomizePanel.module.css'

/**
 * Navigation:
 *   root ─┬─ slime      → sub-cat chips (색상/재질/코팅/모양) + active control
 *          ├─ beads     → combo chips (미선택/컴팩트/청크), then sub-cat chips
 *          │              of the selected combo + active control
 *          ├─ sprinkles → type chips (종이/가루/잉크), then sub-cat chips of
 *          │              the selected type + active control
 *          └─ theme     → palette chips + emoji toggles + count/size sliders
 *                        (adds emoji beads to the slime; does NOT overwrite
 *                        the rest of the customisation)
 *
 * The single-view layout — sub-cat chips at TOP and the active control at
 * BOTTOM — was requested so users no longer bounce between nested picker
 * screens just to switch which knob they're tweaking within a category.
 */
/** Internal category id — one per distinct panel implementation.
 *  Powder/ink used to live under a single "스프링클" leaf; they're now
 *  first-class primary chips so users reach each without an extra tap. */
type CategoryId =
  | 'slime'
  | 'inner-slime'
  | 'compact'
  | 'chunk'
  | 'paper'
  | 'powder'
  | 'ink'
  | 'theme'
  | 'custom-beads'

/** Root-level chip row. Rendered in `primaryChipsRow` above every
 *  panel so users can freely jump between any leaf without stepping
 *  back through a group hierarchy. */
const CATEGORIES: readonly { id: CategoryId; label: string }[] = [
  { id: 'slime', label: '슬라임' },
  { id: 'inner-slime', label: '슬라임볼' },
  { id: 'compact', label: '비즈' },
  { id: 'chunk', label: '비즈볼' },
  { id: 'paper', label: '스팽글' },
  { id: 'powder', label: '가루' },
  { id: 'ink', label: '잉크' },
  { id: 'theme', label: '이모지' },
  { id: 'custom-beads', label: '추가비즈' }
]

type SlimeSub =
  | 'color'
  | 'material'
  | 'coating'
  | 'shape'
  | 'text'
const SLIME_SUBS: readonly { id: SlimeSub; label: string }[] = [
  { id: 'material', label: '재질' },
  { id: 'shape', label: '모양' },
  { id: 'coating', label: '코팅' },
  { id: 'color', label: '색상' },
  { id: 'text', label: 'T' }
]

/** Per-combo bead sub-categories. Compact drops "count" (always fill),
 *  chunk keeps count but never shows fill (always count-based). 'none'
 *  has no sub-cats — the combo picker doesn't navigate into it. */
const BEAD_SUB_CATEGORIES_BY_COMBO: Record<
  BeadCombo,
  readonly { id: string; label: string }[]
> = {
  none: [],
  compact: [
    { id: 'color', label: '색상' },
    { id: 'size', label: '크기' },
    { id: 'shape', label: '모양' },
    { id: 'flatness', label: '납작함' }
  ],
  chunk: [
    // Shared by 비즈볼 (chunk) AND 슬라임볼 (inner-slime). 비즈볼
    // filters out 'coating' at render time, so this array's order
    // — size, count, material, coating, color, shape — reads as:
    //   슬라임볼 → 크기 > 양 > 재질 > 코팅 > 색상 > 모양
    //   비즈볼   → 크기 > 양 > 재질 > 색상 > 모양 (coating removed)
    { id: 'size', label: '크기' },
    { id: 'count', label: '양' },
    { id: 'material', label: '재질' },
    { id: 'coating', label: '코팅' },
    { id: 'color', label: '색상' },
    { id: 'shape', label: '모양' }
  ]
}

interface Props {
  colors: readonly ColorId[]
  material: MaterialId
  coating: CoatingId
  /** Coating tint colour picks, independent from the slime body colour.
   *  Wax reads from the general slime palette (COLORS), foil reads from
   *  the metallic COATING_COLORS palette. Multi-select paints a top-to-
   *  bottom gradient on the coating; a single pick is a flat tint. */
  coatingColors: readonly ColorId[]
  foilColors: readonly CoatingColorId[]
  onCoatingColors: (v: ColorId[]) => void
  onFoilColors: (v: CoatingColorId[]) => void
  shape: ShapeId
  beads: BeadsConfig
  sprinkles: SprinklesConfig
  emojiBeads: EmojiBeadsConfig
  onColors: (v: ColorId[]) => void
  onMaterial: (v: MaterialId) => void
  onCoating: (v: CoatingId) => void
  onShape: (v: ShapeId) => void
  onBeads: (v: BeadsConfig) => void
  onSprinkles: (v: SprinklesConfig) => void
  onEmojiBeads: (v: EmojiBeadsConfig) => void
  /** Slime tab camera: pick / clear a photo that becomes a
   *  front-hemisphere decal on the slime body. */
  stickerOn: boolean
  onPickSticker: (file: File) => void
  onClearSticker: () => void
  /** Beads combo tabs camera: per-slot photo pickers. Length is
   *  fixed at 4 slots (each entry non-null when a photo bead is
   *  active in that slot; here we only need to know occupancy so
   *  the picker UI can show thumbnails vs empty). */
  photoBeadSlots: readonly (boolean)[]
  onPickPhotoBead: (index: number, file: File) => void
  /** Per-colour HSL deltas from the adjustment sliders. Keyed on
   *  preset ColorId so tweaks stay attached to their base colour
   *  across sessions and across surfaces (slime + beads share). */
  colorAdjustments: ColorAdjustments
  onColorAdjustment: (id: string, dh: number, dl: number) => void
  /** 속슬라임 config — same shape as beads (BeadsConfig) with combo
   *  forced to 'chunk' when active. Rendered inside the slime by a
   *  dedicated BeadsLayer instance that applies a soft squish on press. */
  innerSlime: BeadsConfig
  onInnerSlime: (v: BeadsConfig) => void
  /** 커스텀비즈 config — emoji-style additive coloured beads. */
  customBeads: CustomBeadsConfig
  onCustomBeads: (v: CustomBeadsConfig) => void
  /** 커스텀비즈 사진 인쇄 — single shared photo texture applied to
   *  every custom bead's outward face. Toggle via header camera:
   *  true = photo active, false = no photo. */
  customBeadsPhotoOn: boolean
  onPickCustomBeadsPhoto: (file: File) => void
  onClearCustomBeadsPhoto: () => void
  /** 텍스트 데칼 group — up to SLIME_TEXT_SLOT_MAX items + a shared
   *  Single text label per slime; renders on the camera-facing
   *  hemisphere with auto-above-coating when a coating is active. */
  slimeText: SlimeText
  onSlimeText: (v: SlimeText) => void
  /** Immediate text-tint push — invoked from the color-chip click
   *  handler in the text panel so the shader uniform updates on the
   *  same tick as the click, without waiting for the SlimeText state
   *  round-trip through React. */
  onTextColorImmediate?: (hex: number) => void
  /** Fires whenever the user switches between slime sub-tabs (색상 /
   *  텍스트 / …). Emits `null` when the slime category itself is
   *  closed. SlimeApp uses this to gate the cube-face click raycast to
   *  only fire while the text sub is actually visible. */
  onActiveSlimeSubChange?: (sub: string | null) => void
  /** Fires whenever the user opens/closes a primary category. Lets
   *  SlimeApp decide which per-category chrome (e.g. the 슬라임 안 toggle
   *  in the unified tag row) is currently applicable — a plain string
   *  keeps CategoryId internal to this file. */
  onActivePanelChange?: (panel: string | null) => void
  /** Registers an imperative "jump to category" handle with the parent.
   *  SlimeApp uses this so a tag click in the unified tag row can open
   *  the panel that owns the tag without lifting category state up.
   *  Passing `null` closes whatever category is currently open — used by
   *  the reset button so nuking every option also collapses the panel. */
  onRegisterOpenCategory?: (
    fn: (id: string | null, subId?: string) => void
  ) => void
}

function hexToCss(h: number): string {
  return '#' + h.toString(16).padStart(6, '0')
}

/** Render the hue / lightness sliders for the currently-active colour
 *  chip. Shifts the base preset within its own family (아쿠아 → other
 *  aquas) instead of skewing to arbitrary hues, so tweaks stay
 *  intuitive per colour. */
function ColorAdjustSliders({
  colorId,
  adjustments,
  onChange
}: {
  // Accepts either the slime/beads ColorId or a namespaced sprinkle
  // id (e.g. `sp:gold`), keyed into the shared colorAdjustments map.
  colorId: string
  adjustments: ColorAdjustments
  onChange: (id: string, dh: number, dl: number) => void
}) {
  const tr = useTr()
  const cur = (adjustments as Record<string, readonly [number, number]>)[
    colorId
  ] ?? [0, 0]
  const dh = cur[0]
  const dl = cur[1]
  return (
    <div className={styles.adjustRows}>
      <div className={styles.sliderRow}>
        <span className={styles.subLabel}>색조</span>
        <input
          type="range"
          min={-30}
          max={30}
          step={1}
          value={dh}
          onChange={(e) => onChange(colorId, parseFloat(e.currentTarget.value), dl)}
          className={styles.slider}
          aria-label={tr('색조 조절')}
        />
        <span className={styles.sliderValue}>
          {dh > 0 ? `+${dh}` : dh}
        </span>
      </div>
      <div className={styles.sliderRow}>
        <span className={styles.subLabel}>명도</span>
        <input
          type="range"
          min={-25}
          max={25}
          step={1}
          value={dl}
          onChange={(e) => onChange(colorId, dh, parseFloat(e.currentTarget.value))}
          className={styles.slider}
          aria-label={tr('명도 조절')}
        />
        <span className={styles.sliderValue}>
          {dl > 0 ? `+${dl}` : dl}
        </span>
      </div>
    </div>
  )
}

/** Small diagonal gradient bar icon — used by the mini-beads colour
 *  panel toggle chip. Solid → hatched split for the OFF (band) state,
 *  smooth stroke for the ON state via currentColor. */
function GradientIcon() {
  // useId gives each instance a stable, unique gradient-def ID so multiple
  // GradientIcon buttons on the same page don't collide on `url(#...)`.
  const gid = useId().replace(/:/g, '')
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
    >
      <defs>
        <linearGradient id={`grad-${gid}`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="currentColor" stopOpacity="1" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0.15" />
        </linearGradient>
      </defs>
      <circle
        cx="12"
        cy="12"
        r="8.5"
        fill={`url(#grad-${gid})`}
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  )
}

/** Circular camera button that sits at the front of a sub-cat tab
 *  strip. Clicking it toggles a sub-options row below the strip that
 *  hosts the actual "+" add-photo buttons — one per available slot.
 *  Visually always a dashed circle with a camera glyph; the outline
 *  flips to solid blue when at least one photo is applied so users
 *  see the on-state at a glance. */

/** Camera chip used in the sub-tab row of the slime and 추가비즈
 *  panels. Clicking it opens the OS photo picker directly — no
 *  intermediate tray / + button. The active state paints solid blue
 *  when a photo is currently applied so users see the on-state at a
 *  glance. */
function CameraTriggerChip({
  ariaLabel,
  active,
  onClick
}: {
  ariaLabel: string
  active?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={styles.addPhotoChip}
      data-active={active ? 'true' : undefined}
      onClick={onClick}
      aria-label={ariaLabel}
      aria-pressed={active}
    >
      <CameraIcon />
    </button>
  )
}

/** Shared camera icon SVG used by the slime tab (사진 슬라임 trigger)
 *  and the beads combo tabs (사진 비즈 slot pickers). Renders inline so
 *  currentColor inherits from the wrapping button state. */
function CameraIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  )
}

/** Horizontally-scrolling primary category row. Watches its own scroll
 *  position so the leading / trailing edge fade only appears when
 *  there's actually more content in that direction — the first chip
 *  and last chip stay crisp when they're pinned to the visible edge. */
/** Per-category outline icons rendered above the label inside each
 *  PrimaryChipsRow chip. All icons share a 24×24 viewBox and use
 *  `stroke="currentColor"` so their tint inherits from the chip's
 *  text colour (dim when inactive, full-contrast when active). Only
 *  outlines — no fills — per the user's spec.
 *
 *  Icon designs, in `CATEGORIES` order:
 *    slime         → single circle
 *    inner-slime   → circle within circle
 *    compact       → 7 small circles arranged as a ring (1 centre + 6)
 *    chunk         → outer circle with 2 diagonal small circles inside
 *    paper         → 11 diagonal hatches arranged as a ring
 *    powder        → 11 dots arranged as a ring
 *    ink           → single wavy path traced as a closed circular loop
 *    theme         → star + square + triangle arranged as a triangle
 *    custom-beads  → "+" and circle side by side (horizontal)
 */
function CategoryIcon({ id }: { id: CategoryId }) {
  const svgProps = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    width: 26,
    height: 26
  }
  if (id === 'slime') {
    return (
      <svg {...svgProps}>
        <circle cx="12" cy="12" r="8" />
      </svg>
    )
  }
  if (id === 'inner-slime') {
    // Outer ring stays as an outline (matching the plain 슬라임 icon),
    // ONLY the inner ball fills solid so the icon reads as "a smaller
    // ball tucked inside a slime shell".
    return (
      <svg {...svgProps}>
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />
      </svg>
    )
  }
  if (id === 'compact') {
    // Ring at distance 6 with radius-2 dots pushes the outer cluster
    // extent to ~8 units — matching the 슬라임 icon's r=8 circle so
    // the packed beads read at the same visual size as the plain
    // slime chip alongside it. Dots filled solid (currentColor) so
    // the cluster reads as densely packed rather than hollow rings.
    const dots: JSX.Element[] = []
    dots.push(
      <circle key="c" cx={12} cy={12} r={2} fill="currentColor" stroke="none" />
    )
    for (let i = 0; i < 6; i++) {
      const a = (i * Math.PI) / 3
      dots.push(
        <circle
          key={i}
          cx={+(12 + 6 * Math.cos(a)).toFixed(2)}
          cy={+(12 + 6 * Math.sin(a)).toFixed(2)}
          r={2}
          fill="currentColor"
          stroke="none"
        />
      )
    }
    return <svg {...svgProps}>{dots}</svg>
  }
  if (id === 'chunk') {
    // Outer ring outlined (matches 슬라임/슬라임볼 boundary treatment),
    // 2 inner beads solid-filled and bumped a touch bigger so they
    // read as chunky beads rather than pin-sized dots.
    return (
      <svg {...svgProps}>
        <circle cx="12" cy="12" r="9" />
        <circle cx="9" cy="9" r="2.6" fill="currentColor" stroke="none" />
        <circle cx="15" cy="15" r="2.6" fill="currentColor" stroke="none" />
      </svg>
    )
  }
  if (id === 'paper') {
    // Sparser sparkle: 1 centre + 6 (r=5.5) = 7 slashes (down from
    // 13 → roughly halved). Slightly thicker (0.7 → 0.95) so each
    // remaining mark carries more visual weight now that they're
    // more spread out.
    const items: readonly { r: number; count: number }[] = [
      { r: 0, count: 1 },
      { r: 5.5, count: 6 }
    ]
    const rects: JSX.Element[] = []
    let key = 0
    for (const { r, count } of items) {
      for (let i = 0; i < count; i++) {
        const a = count === 1 ? 0 : (i * 2 * Math.PI) / count
        const cx = +(12 + r * Math.cos(a)).toFixed(2)
        const cy = +(12 + r * Math.sin(a)).toFixed(2)
        rects.push(
          <rect
            key={key++}
            x={+(cx - 1.6).toFixed(2)}
            y={+(cy - 0.475).toFixed(2)}
            width={3.2}
            height={0.95}
            rx={0.4}
            fill="currentColor"
            stroke="none"
            transform={`rotate(45 ${cx} ${cy})`}
          />
        )
      }
    }
    return <svg {...svgProps}>{rects}</svg>
  }
  if (id === 'powder') {
    // Concentric rings — uniform spacing (~2.5 both radially and
    // circumferentially): 1 centre + 6 (r=2.5) + 12 (r=5) + 18
    // (r=7.5) = 37 filled dots. Filled (fill="currentColor",
    // no stroke) so each grain reads as a solid speck instead of
    // a hollow ring outline.
    const items: readonly { r: number; count: number }[] = [
      { r: 0, count: 1 },
      { r: 2.5, count: 6 },
      { r: 5, count: 12 },
      { r: 7.5, count: 18 }
    ]
    const dots: JSX.Element[] = []
    let key = 0
    for (const { r, count } of items) {
      for (let i = 0; i < count; i++) {
        const a = count === 1 ? 0 : (i * 2 * Math.PI) / count
        dots.push(
          <circle
            key={key++}
            cx={+(12 + r * Math.cos(a)).toFixed(2)}
            cy={+(12 + r * Math.sin(a)).toFixed(2)}
            r={0.55}
            fill="currentColor"
            stroke="none"
          />
        )
      }
    }
    return <svg {...svgProps}>{dots}</svg>
  }
  if (id === 'ink') {
    // Diagonal squiggle with VARIABLE amplitude — outer humps stay
    // shallow (amp 4) while the middle two humps swing deep (amp 8)
    // so after the -45° rotation those middle peaks land on the
    // imaginary r=8 rim instead of hugging the centreline. Explicit
    // Q commands (not T) let each hump pick its own amplitude.
    return (
      <svg {...svgProps}>
        <path
          d="M4 12 Q6 8 8 12 Q10 20 12 12 Q14 4 16 12 Q18 16 20 12"
          transform="rotate(-45 12 12)"
        />
      </svg>
    )
  }
  if (id === 'theme') {
    // Star at top, square bottom-left, triangle bottom-right —
    // three points of an equilateral-ish arrangement.
    const starPts: string[] = []
    const scx = 12
    const scy = 6.5
    const outer = 2.6
    const inner = outer * 0.42
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? outer : inner
      const a = -Math.PI / 2 + (i * Math.PI) / 5
      starPts.push(
        `${(scx + r * Math.cos(a)).toFixed(2)},${(scy + r * Math.sin(a)).toFixed(2)}`
      )
    }
    return (
      <svg {...svgProps}>
        <polygon points={starPts.join(' ')} />
        <rect x="4.5" y="14.5" width="5" height="5" />
        <polygon points="19,14 22,19.5 16,19.5" />
      </svg>
    )
  }
  if (id === 'custom-beads') {
    // Circle enlarged to r=6 so the bead reads at a size comparable
    // to the other outlined-boundary icons; "+" nudged left to keep
    // it clear of the widened circle.
    return (
      <svg {...svgProps}>
        <line x1="4.5" y1="8" x2="4.5" y2="16" />
        <line x1="0.5" y1="12" x2="8.5" y2="12" />
        <circle cx="16" cy="12" r="6" />
      </svg>
    )
  }
  return null
}

function PrimaryChipsRow({
  category,
  openCategory,
  closeCategory,
  scrollLeftRef
}: {
  category: CategoryId | null
  openCategory: (id: CategoryId) => void
  closeCategory: () => void
  /** Persistent scroll offset owned by the parent — restored on
   *  every mount so the horizontally-scrolled chip strip doesn't
   *  snap back to 0 whenever a category change tears the sub-panel
   *  down and remounts this component. Kept as a ref (not state)
   *  since the value never needs to trigger a re-render. */
  scrollLeftRef: React.MutableRefObject<number>
}) {
  const tr = useTr()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [atStart, setAtStart] = useState(true)
  const [atEnd, setAtEnd] = useState(false)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    // Restore previous scroll position first (before wiring up the
    // listener so the restoration itself doesn't overwrite the ref).
    if (scrollLeftRef.current > 0) {
      el.scrollLeft = scrollLeftRef.current
    }
    const update = () => {
      const max = el.scrollWidth - el.clientWidth
      scrollLeftRef.current = el.scrollLeft
      setAtStart(el.scrollLeft <= 1)
      setAtEnd(el.scrollLeft >= max - 1)
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', update)
      ro.disconnect()
    }
  }, [scrollLeftRef])

  return (
    <div
      ref={scrollRef}
      className={styles.primaryChips}
      data-at-start={atStart}
      data-at-end={atEnd}
    >
      {CATEGORIES.map((c) => {
        const isActive = c.id === category
        return (
          <button
            key={c.id}
            className={styles.primaryChip}
            data-active={isActive}
            data-dim={!isActive}
            type="button"
            onClick={() =>
              isActive ? closeCategory() : openCategory(c.id)
            }
          >
            <span className={styles.primaryChipIcon}>
              <CategoryIcon id={c.id} />
            </span>
            <span className={styles.primaryChipLabel}>{tr(c.label)}</span>
          </button>
        )
      })}
    </div>
  )
}

export default function CustomizePanel({
  colors,
  material,
  coating,
  coatingColors,
  foilColors,
  onCoatingColors,
  onFoilColors,
  shape,
  beads,
  sprinkles,
  emojiBeads,
  onColors,
  onMaterial,
  onCoating,
  onShape,
  onBeads,
  onSprinkles,
  onEmojiBeads,
  stickerOn,
  onPickSticker,
  onClearSticker,
  photoBeadSlots,
  onPickPhotoBead,
  colorAdjustments,
  onColorAdjustment,
  innerSlime,
  onInnerSlime,
  customBeads,
  onCustomBeads,
  customBeadsPhotoOn,
  onPickCustomBeadsPhoto,
  onClearCustomBeadsPhoto,
  slimeText,
  onSlimeText,
  onTextColorImmediate,
  onActiveSlimeSubChange,
  onActivePanelChange,
  onRegisterOpenCategory
}: Props) {
  const tr = useTr()
  const [category, setCategory] = useState<CategoryId | null>(null)
  // Persistent horizontal scroll offset for the primary chip strip.
  // Each category switch tears the sub-panel down and remounts
  // PrimaryChipsRow with it — without this shared ref the row's
  // scrollLeft would reset to 0 every time, snapping the strip back
  // to the leading chips whenever the user picked one near the end.
  const primaryChipsScrollLeftRef = useRef(0)
  useEffect(() => {
    // Mirror the panel's active category out to the parent so the unified
    // tag row can render per-category chrome (currently only the 슬라임 안
    // toggle for the four embed-capable leaves).
    onActivePanelChange?.(category)
  }, [category, onActivePanelChange])
  // Per-category active sub-category. Each category remembers the last
  // sub-cat the user was on so re-entering the category feels continuous.
  const [slimeSub, setSlimeSub] = useState<SlimeSub>('color')
  useEffect(() => {
    // Only report a slime sub while the slime category is actually open.
    // Any other category collapsing to root also collapses the sub so the
    // parent's cube-face raycast gate doesn't fire on stale state.
    onActiveSlimeSubChange?.(category === 'slime' ? slimeSub : null)
  }, [category, slimeSub, onActiveSlimeSubChange])

  const [beadsSub, setBeadsSub] = useState<string>('color')
  // Sub-cat inside a sprinkle type — defaults to 'count' so drilling into
  // paper / powder / ink lands the user on the amount slider first (the
  // most common tweak) instead of the colour picker.
  const [sprinkleSub, setSprinkleSub] = useState<string>('count')
  // The colour chip whose hue / lightness sliders are currently visible
  // under the chip row. Shared across slime + beads panels because
  // colour adjustments themselves are shared — clicking a chip in
  // either surface opens its sliders for tuning within-family.
  // Accepts any adjustment key (ColorId for slime/beads, `sp:<id>` for
   // sprinkle types) since sprinkle-colour adjustments share the same
   // colorAdjustments map under a namespaced key.
  const [activeAdjustColor, setActiveAdjustColor] =
    useState<string | null>(null)

  // Attach scroll-edge detection to every `.options` row currently in
  // the panel — mirrors PrimaryChipsRow's behaviour so the mask fade
  // only appears on the side that actually has more content, keeping
  // the first / last chip fully crisp when the row is scrolled to
  // that extreme. Runs on every render because .options divs mount
  // and unmount as the user drills between categories.
  useEffect(() => {
    // Same edge-fade detection now covers both `.options` (chip rows)
    // AND `.tabs` (sub-category strips) so the sub-tab mask fade also
    // clears on the extremes — six-tab strips like 슬라임 (with 텍스트)
    // otherwise permanently dim their first / last labels.
    const rows = Array.from(
      document.querySelectorAll<HTMLDivElement>(
        '.' + styles.options + ', .' + styles.tabs
      )
    )
    const cleanups: (() => void)[] = []
    rows.forEach((row) => {
      const update = () => {
        const max = row.scrollWidth - row.clientWidth
        row.dataset.atStart = String(row.scrollLeft <= 1)
        row.dataset.atEnd = String(max <= 0 || row.scrollLeft >= max - 1)
      }
      update()
      row.addEventListener('scroll', update, { passive: true })
      const ro = new ResizeObserver(update)
      ro.observe(row)
      cleanups.push(() => {
        row.removeEventListener('scroll', update)
        ro.disconnect()
      })
    })
    return () => cleanups.forEach((c) => c())
  })
  // Single hidden <input> reused for every photo pick — the pending
  // target (sticker | first empty photo bead slot) is stashed in this
  // ref so the file input's onChange dispatches to the right handler.
  const pickerInputRef = useRef<HTMLInputElement | null>(null)
  const pickerTargetRef = useRef<
    | { kind: 'sticker' }
    | { kind: 'photoBead'; index: number }
    | { kind: 'customPhoto' }
    | null
  >(null)

  const openPhotoPicker = (
    target: NonNullable<typeof pickerTargetRef.current>
  ) => {
    pickerTargetRef.current = target
    pickerInputRef.current?.click()
  }


  const openCategory = (c: CategoryId, subId?: string) => {
    setCategory(c)
    // Default sub-cat matches the FIRST tab in each category's tab
    // strip so the panel opens on a "primary" control every time:
    //   슬라임 → 재질 (material)
    //   꽉비즈(compact) → 색상 (color, fill-only, no 양)
    //   비즈볼(chunk) + 슬라임볼(inner-slime) → 크기 (size)
    //   추가비즈(custom-beads) → 양 (count)
    //   스팽글(paper) → 종류 (kind) — set further down
    //   가루/잉크 → 양 (count)
    setBeadsSub(
      c === 'compact'
        ? 'color'
        : c === 'chunk' || c === 'inner-slime'
          ? 'size'
          : 'count'
    )
    setSprinkleSub('count')
    setSlimeSub('material')
    // Compact / chunk are single-combo categories now — entering
    // either sets the beads combo to that flavour with its defaults
    // if it wasn't already active. This preserves user tweaks when
    // re-entering the same combo (they land back where they left off)
    // while cleanly switching away from a stale combo.
    if (c === 'compact' && beads.combo !== 'compact') {
      const cfg = BEAD_COMBOS.find((x) => x.id === 'compact')
      if (cfg) {
        // Seed bead palette from the slime's own colours on first
        // activation so 꽉비즈 reads as the same colour as the slime
        // it's covering instead of defaulting to plain white. Only
        // fills the empty case — a user who's already picked bead
        // colours (before switching combos) keeps their picks.
        const seedColors =
          beads.colors.length > 0
            ? beads.colors
            : (colors as ColorId[])
        onBeads({
          ...beads,
          combo: 'compact',
          ...cfg.defaults,
          coating: 'none',
          colors: seedColors
        })
      }
    }
    if (c === 'chunk' && beads.combo !== 'chunk') {
      const cfg = BEAD_COMBOS.find((x) => x.id === 'chunk')
      if (cfg) {
        onBeads({ ...beads, combo: 'chunk', ...cfg.defaults, coating: 'none' })
      }
    }
    // 속슬라임 reuses the chunk combo internally but writes to its own
    // innerSlime state. Auto-activate combo = 'chunk' on first entry
    // with count forced to 1 (chunk defaults to 4 for 속비즈, but the
    // 속슬라임 inclusion reads as a single soft blob by default).
    if (c === 'inner-slime' && innerSlime.combo !== 'chunk') {
      const cfg = BEAD_COMBOS.find((x) => x.id === 'chunk')
      if (cfg) {
        // Coerce the material to a valid slime MaterialId on first entry
        // — legacy configs may still carry BeadMaterialId 'plastic' from
        // before 슬라임볼 switched to the MATERIALS palette.
        const materialValid = MATERIALS.some(
          (m) => m.id === innerSlime.material
        )
        // Inherit the slime's own shape — a cube slime should get a
        // cube 슬라임볼 by default, sphere → sphere, etc. rect/twist
        // fall back to their closest bead-shape analogue.
        const inheritedShape: BeadShapeId =
          shape === 'cube' || shape === 'rect'
            ? 'cube'
            : 'sphere'
        onInnerSlime({
          ...innerSlime,
          combo: 'chunk',
          ...cfg.defaults,
          // 슬라임볼 defaults to a single ball at MAX size (0.58) so the
          // core reads as a dominant buried element straight away —
          // matches the 슬라임볼 size-slider ceiling for count === 1.
          size: 0.58,
          count: 1,
          shapes: [inheritedShape],
          coating: 'none',
          // 슬라임볼 default is 광택 — polished candy with a mirror
          // clearcoat, opaque so single- and multi-colour balls render
          // at the same size (opaqueBallMaterial hides the wrap-shell).
          material: materialValid
            ? (innerSlime.material as MaterialId)
            : 'glossy'
        })
      }
    }
    // 스팽글 / 가루 / 잉크 are each dedicated leaves. sprinkleType is
    // pinned to the matching type so the shared panel renders that type's
    // sub-cats. 스팽글 also seeds fill=true + a default color so the
    // surface reads populated the moment the user opens the leaf.
    if (c === 'paper') {
      // 스팽글 lands on 종류 first — that's the identity choice
      // (paper vs plastic) users typically pick before tuning count /
      // colour / shape, so it belongs at the top of the sub-cat row.
      setSprinkleSub('kind')
      if (!sprinkles.paper.fill && sprinkles.paper.count === 0) {
        onSprinkles({
          ...sprinkles,
          paper: {
            ...sprinkles.paper,
            fill: true,
            colors:
              sprinkles.paper.colors.length > 0
                ? sprinkles.paper.colors
                : [SPRINKLE_COLORS[0].id]
          }
        })
      }
    }
    if (c === 'powder') {
      setSprinkleSub('count')
    }
    if (c === 'ink') {
      setSprinkleSub('count')
      // Seed ink at MAX amount AND a default colour on first entry so
      // the marble effect is immediately visible. Without seeding a
      // colour the ink layer renders nothing until the user picks one,
      // which read as "ink didn't apply" to users. Preserves any prior
      // user tweak when either count or colours are already set.
      if (sprinkles.ink.count === 0 && sprinkles.ink.colors.length === 0) {
        onSprinkles({
          ...sprinkles,
          ink: {
            ...sprinkles.ink,
            count: SPRINKLES_LIMITS.inkCountMax,
            colors: [SPRINKLE_COLORS[0].id]
          }
        })
      } else if (sprinkles.ink.count === 0) {
        onSprinkles({
          ...sprinkles,
          ink: { ...sprinkles.ink, count: SPRINKLES_LIMITS.inkCountMax }
        })
      }
    }
    // 커스텀비즈 lands on the 양(count) sub-cat first, and if there
    // aren't any beads yet, seeds count=2 so the user sees beads on
    // the slime immediately without having to touch the slider.
    if (c === 'custom-beads') {
      setBeadsSub('count')
      if (customBeads.count === 0) {
        onCustomBeads({ ...customBeads, count: 2 })
      }
    }
    // Fresh entry into any category clears the persisted colour-
    // adjust focus so the panel doesn't auto-open a slider row from
    // a previous session — the user only sees hue / lightness after
    // clicking a specific colour chip on this visit.
    setActiveAdjustColor(null)
    // Deep-link override — when a tag click passes an explicit sub-cat
    // id (e.g. clicking a "슬라임 색상" tag lands on 색상 instead of
    // the primary's default 재질), route it to the matching setter.
    // Routed AFTER the defaults above so the caller wins. Sprinkles /
    // custom-beads share the sprinkle+beads sub setters respectively.
    if (subId) {
      if (c === 'slime') {
        setSlimeSub(subId as SlimeSub)
      } else if (
        c === 'compact' ||
        c === 'chunk' ||
        c === 'inner-slime' ||
        c === 'custom-beads'
      ) {
        setBeadsSub(subId)
      } else if (c === 'paper' || c === 'powder' || c === 'ink') {
        setSprinkleSub(subId)
      }
    }
  }

  // Expose openCategory to the parent via a ref-of-latest so tag clicks
  // in SlimeApp's unified tag row can jump straight into the panel that
  // owns the tag. Registered once — the ref inside always points at the
  // most recent closure so it stays in sync with current state.
  const openCategoryLatestRef = useRef(openCategory)
  openCategoryLatestRef.current = openCategory
  useEffect(() => {
    onRegisterOpenCategory?.((id, subId) => {
      if (id === null) {
        setCategory(null)
      } else {
        openCategoryLatestRef.current(id as CategoryId, subId)
      }
    })
  }, [onRegisterOpenCategory])

  const toggleBeadShape = (id: BeadShapeId) => {
    const has = beads.shapes.includes(id)
    // Keep at least one shape selected — an empty shapes[] disables the
    // whole layer, and deselecting the last chip would feel like a bug.
    if (has && beads.shapes.length === 1) return
    const next = has
      ? beads.shapes.filter((s) => s !== id)
      : [...beads.shapes, id]
    onBeads({ ...beads, shapes: next })
  }

  /** Merge a partial update into one sub-config of the composite
   *  sprinkles state — e.g. toggling a paper colour only touches
   *  sprinkles.paper.colors, leaving powder / ink alone. */
  const updateSprinkleSub = <K extends SprinkleTypeId>(
    typeId: K,
    patch: Partial<SprinklesConfig[K]>
  ) => {
    onSprinkles({
      ...sprinkles,
      [typeId]: { ...sprinkles[typeId], ...patch }
    })
  }

  const toggleSprinkleColor = (typeId: SprinkleTypeId, id: SprinkleColorId) => {
    const cur = sprinkles[typeId].colors
    const next = cur.includes(id) ? cur.filter((c) => c !== id) : [...cur, id]
    updateSprinkleSub(typeId, { colors: next })
  }

  /** Persistent primary chip row rendered above every panel. Selected
   *  chip reads at full opacity with the standard tab highlight;
   *  others fade to 50% via data-dim so users can always see the
   *  full navigation without losing context. Scrolls horizontally
   *  because 8 chips don't fit on a phone-width panel. */
  const primaryChipsRow = (
    <PrimaryChipsRow
      category={category}
      openCategory={openCategory}
      closeCategory={() => setCategory(null)}
      scrollLeftRef={primaryChipsScrollLeftRef}
    />
  )

  // "슬라임 안" toggle — active/handler resolved per-category from
  // the four embed-capable leaves (compact / paper / theme /
  // custom-beads). Null for every other category, so the injected
  // button JSX below just renders nothing when not applicable.
  const insideToggle: { active: boolean; onToggle: () => void } | null =
    category === 'compact'
      ? {
          active: !!beads.inside,
          onToggle: () =>
            onBeads({ ...beads, inside: !beads.inside })
        }
      : category === 'paper'
        ? {
            active: !!sprinkles.paper.inside,
            onToggle: () =>
              onSprinkles({
                ...sprinkles,
                paper: {
                  ...sprinkles.paper,
                  inside: !sprinkles.paper.inside
                }
              })
          }
        : category === 'theme'
          ? {
              active: !!emojiBeads.inside,
              onToggle: () =>
                onEmojiBeads({
                  ...emojiBeads,
                  inside: !emojiBeads.inside
                })
            }
          : category === 'custom-beads'
            ? {
                active: !!customBeads.inside,
                onToggle: () =>
                  onCustomBeads({
                    ...customBeads,
                    inside: !customBeads.inside
                  })
              }
            : null

  const insideToggleBtn = insideToggle ? (
    <div className={styles.insideToggleRow}>
      <button
        type="button"
        className={styles.insideToggleBtn}
        data-active={insideToggle.active}
        onClick={insideToggle.onToggle}
        aria-pressed={insideToggle.active}
        title={tr('슬라임 안')}
      >
        슬라임 안
      </button>
    </div>
  ) : null

  /* ── Root view: just the chip row (all chips dimmed to 50%). */
  if (category === null) {
    return (
      <div className={styles.panel} data-hud>
        {primaryChipsRow}
      </div>
    )
  }

  const catLabel = tr(CATEGORIES.find((c) => c.id === category)?.label ?? '')
  const goBack = () => {
    setCategory(null)
  }

  /* ── Slime: sub-cat chips + active control on one panel ───── */
  if (category === 'slime') {
    // Build removable tags for every currently-selected slime option.
    // Color tags remove one from the multi-select (last one is locked
    // so slime always has ≥ 1 colour); other tags revert their field
    // to the default so removing a tag lands the slime back on the
    // "unselected / neutral" value for that dimension.
    const slimeTags: SelectionTag[] = []
    colors.forEach((cid) => {
      slimeTags.push({
        key: `color-${cid}`,
        label: resolveColorLabel(cid),
        onRemove: () => onColors(colors.filter((x) => x !== cid))
      })
    })
    if (material !== 'crystal') {
      const m = MATERIALS.find((x) => x.id === material)
      if (m) {
        slimeTags.push({
          key: `mat-${material}`,
          label: tr(m.label),
          onRemove: () => onMaterial('crystal')
        })
      }
    }
    if (coating !== 'none') {
      const c = COATINGS.find((x) => x.id === coating)
      if (c) {
        slimeTags.push({
          key: `coat-${coating}`,
          label: tr(c.label),
          onRemove: () => onCoating('none')
        })
      }
    }
    if (shape !== 'sphere') {
      const s = SHAPES.find((x) => x.id === shape)
      if (s) {
        slimeTags.push({
          key: `shape-${shape}`,
          label: tr(s.label),
          onRemove: () => onShape('sphere')
        })
      }
    }
    return (
      <div className={styles.panel} data-hud>
        {insideToggleBtn}
        {primaryChipsRow}
        <input
          ref={pickerInputRef}
          type="file"
          accept="image/*"
          capture="user"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.currentTarget.files?.[0]
            e.currentTarget.value = ''
            const target = pickerTargetRef.current
            pickerTargetRef.current = null
            if (!f || !target) return
            if (target.kind === 'sticker') onPickSticker(f)
            else if (target.kind === 'customPhoto') onPickCustomBeadsPhoto(f)
            else onPickPhotoBead(target.index, f)
          }}
        />
        <Header
          title={catLabel}
          onBack={goBack}
          tags={slimeTags}
          rightAction={{
            ariaLabel: stickerOn ? tr('사진 지우기') : tr('사진 슬라임'),
            active: stickerOn,
            onClick: () => {
              if (stickerOn) onClearSticker()
              else openPhotoPicker({ kind: 'sticker' })
            },
            icon: <CameraIcon />
          }}
        />
        <div className={styles.tabs}>
          <CameraTriggerChip
            ariaLabel={stickerOn ? tr('사진 스티커 교체') : tr('사진 슬라임')}
            active={stickerOn}
            onClick={() => openPhotoPicker({ kind: 'sticker' })}
          />
          {SLIME_SUBS.map((s) => (
            <button
              key={s.id}
              className={styles.tab}
              data-active={slimeSub === s.id}
              type="button"
              onClick={() => {
                setSlimeSub(s.id)
                setActiveAdjustColor(null)
              }}
            >
              {tr(s.label)}
            </button>
          ))}
        </div>
        {slimeSub === 'color' && (
          <>
            <div className={styles.options}>
              {COLORS.map((c) => {
                // Multi-select: clicking a chip toggles the colour in
                // the list AND opens its adjustment sliders below.
                // Deselecting the LAST colour is blocked so the slime
                // always has at least one hue.
                const active = colors.includes(c.id)
                return (
                  <button
                    key={c.id}
                    className={styles.chip}
                    data-active={active}
                    data-adjust-target={activeAdjustColor === c.id ? 'true' : undefined}
                    type="button"
                    onClick={() => {
                      if (active) {
                        // Clicking an already-selected colour NEVER
                        // deselects it — only switches which colour the
                        // adjustment sliders act on. Removal happens
                        // exclusively via the option's tag × button
                        // (user's explicit UX rule).
                        setActiveAdjustColor(c.id)
                      } else {
                        onColors([...colors, c.id])
                        // Fresh pick that has never been tuned before:
                        // seed the entry at zero so the sliders render
                        // in the default state instead of an implicit
                        // "undefined" that also happens to be zero but
                        // reads inconsistently.
                        if (colorAdjustments[c.id] === undefined) {
                          onColorAdjustment(c.id, 0, 0)
                        }
                        setActiveAdjustColor(c.id)
                      }
                    }}
                    aria-label={tr(c.label)}
                    aria-pressed={active}
                  >
                    <span
                      className={styles.swatch}
                      style={{
                        background: hexToCss(
                          resolveColorHex(c.id, colorAdjustments)
                        )
                      }}
                    />
                    <span className={styles.chipLabel}>{tr(c.label)}</span>
                  </button>
                )
              })}
            </div>
            {activeAdjustColor && (
              <ColorAdjustSliders
                colorId={activeAdjustColor}
                adjustments={colorAdjustments}
                onChange={onColorAdjustment}
              />
            )}
          </>
        )}
        {slimeSub === 'material' && (
          <div className={styles.options}>
            {MATERIALS.map((m) => (
              <button
                key={m.id}
                className={styles.chip}
                data-active={material === m.id}
                type="button"
                onClick={() => onMaterial(m.id)}
              >
                <span className={styles.chipLabel}>{tr(m.label)}</span>
              </button>
            ))}
          </div>
        )}
        {slimeSub === 'coating' && (
          <>
            <div className={styles.options}>
              {COATINGS.map((c) => (
                <button
                  key={c.id}
                  className={styles.chip}
                  data-active={coating === c.id}
                  type="button"
                  onClick={() => onCoating(c.id)}
                >
                  <span className={styles.chipLabel}>{tr(c.label)}</span>
                </button>
              ))}
            </div>
            {(coating === 'wax' ||
              coating === 'thinwax' ||
              coating === 'tube' ||
              coating === 'ice') && (
              <>
                <div className={styles.options}>
                  {COLORS.map((c) => {
                    const active = coatingColors.includes(c.id)
                    const adjustKey = `wc:${c.id}`
                    return (
                      <button
                        key={c.id}
                        className={styles.chip}
                        data-active={active}
                        data-adjust-target={activeAdjustColor === adjustKey ? 'true' : undefined}
                        type="button"
                        onClick={() => {
                          const has = coatingColors.includes(c.id)
                          if (!has) {
                            onCoatingColors([...coatingColors, c.id])
                            if (colorAdjustments[adjustKey] === undefined) {
                              onColorAdjustment(adjustKey, 0, 0)
                            }
                          }
                          // Click on already-selected coating colour
                          // only switches adjust target — removal via
                          // tag × only, matching the body-colour UX.
                          setActiveAdjustColor(adjustKey)
                        }}
                        aria-label={tr(c.label)}
                        aria-pressed={active}
                      >
                        <span
                          className={styles.swatch}
                          style={{
                            background: hexToCss(
                              resolveWaxCoatingHex(c.id, colorAdjustments)
                            )
                          }}
                        />
                        <span className={styles.chipLabel}>{tr(c.label)}</span>
                      </button>
                    )
                  })}
                </div>
                {activeAdjustColor &&
                  activeAdjustColor.startsWith('wc:') && (
                    <ColorAdjustSliders
                      colorId={activeAdjustColor}
                      adjustments={colorAdjustments}
                      onChange={onColorAdjustment}
                    />
                  )}
              </>
            )}
            {coating === 'foil' && (
              <>
                <div className={styles.options}>
                  {COATING_COLORS.map((c) => {
                    const active = foilColors.includes(c.id)
                    const adjustKey = `fc:${c.id}`
                    return (
                      <button
                        key={c.id}
                        className={styles.chip}
                        data-active={active}
                        data-adjust-target={activeAdjustColor === adjustKey ? 'true' : undefined}
                        type="button"
                        onClick={() => {
                          const has = foilColors.includes(c.id)
                          if (!has) {
                            onFoilColors([...foilColors, c.id])
                            if (colorAdjustments[adjustKey] === undefined) {
                              onColorAdjustment(adjustKey, 0, 0)
                            }
                          }
                          // Click on already-selected coating colour
                          // only switches adjust target — removal via
                          // tag × only, matching the body-colour UX.
                          setActiveAdjustColor(adjustKey)
                        }}
                        aria-label={tr(c.label)}
                        aria-pressed={active}
                      >
                        <span
                          className={styles.swatch}
                          style={{
                            background: hexToCss(
                              resolveFoilCoatingHex(c.id, colorAdjustments)
                            )
                          }}
                        />
                        <span className={styles.chipLabel}>{tr(c.label)}</span>
                      </button>
                    )
                  })}
                </div>
                {activeAdjustColor &&
                  activeAdjustColor.startsWith('fc:') && (
                    <ColorAdjustSliders
                      colorId={activeAdjustColor}
                      adjustments={colorAdjustments}
                      onChange={onColorAdjustment}
                    />
                  )}
              </>
            )}
          </>
        )}
        {slimeSub === 'shape' && (
          <div className={styles.options}>
            {SHAPES.map((s) => (
              <button
                key={s.id}
                className={styles.chip}
                data-active={shape === s.id}
                type="button"
                onClick={() => onShape(s.id)}
              >
                <span className={styles.chipLabel}>{tr(s.label)}</span>
              </button>
            ))}
          </div>
        )}
        {slimeSub === 'text' && (
          <div className={styles.simpleTextPanel} data-hud>
            {/* Text input row. No focus-within CSS trickery here — the
                previous panel hid sibling controls with :focus-within
                which sometimes latched on Android WebView and made
                the color chips below unclickable. Kept intentionally
                flat: [input] [확인] on one row, then size slider, then
                color chips underneath. */}
            <div className={styles.simpleTextInputRow}>
              <input
                className={styles.simpleTextInput}
                type="text"
                value={slimeText.content}
                maxLength={12}
                placeholder={tr('텍스트 입력')}
                onChange={(e) =>
                  onSlimeText({ ...slimeText, content: e.target.value })
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    ;(e.target as HTMLInputElement).blur()
                  }
                }}
              />
              {slimeText.content && (
                <button
                  type="button"
                  className={styles.simpleTextClearBtn}
                  onClick={() => onSlimeText(SLIME_TEXT_DEFAULT)}
                  aria-label={tr('텍스트 지우기')}
                >
                  ×
                </button>
              )}
            </div>
            <div className={styles.sliderRow}>
              <span className={styles.sliderLabelPrefix}>크기</span>
              <input
                type="range"
                min={0.5}
                max={1.6}
                step={0.05}
                value={slimeText.size}
                onChange={(e) =>
                  onSlimeText({
                    ...slimeText,
                    size: Number(e.target.value)
                  })
                }
                className={styles.slider}
              />
              <span className={styles.sliderValue}>
                {slimeText.size.toFixed(2)}
              </span>
            </div>
            <div className={styles.options}>
              {COLORS.map((c) => {
                const isActive = slimeText.color === c.id
                return (
                  <button
                    key={c.id}
                    className={styles.chip}
                    data-active={isActive}
                    type="button"
                    onClick={() => {
                      onSlimeText({ ...slimeText, color: c.id })
                      onTextColorImmediate?.(
                        resolveColorHex(c.id, colorAdjustments)
                      )
                    }}
                    aria-label={tr(c.label)}
                    aria-pressed={isActive}
                  >
                    <span
                      className={styles.swatch}
                      style={{
                        background: hexToCss(
                          resolveColorHex(c.id, colorAdjustments)
                        )
                      }}
                    />
                    <span className={styles.chipLabel}>{tr(c.label)}</span>
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </div>
    )
  }

  /* ── Beads: split into two top-level categories.
        'compact' → 미니비즈, 'chunk' → 빅비즈. Each category renders the
        same panel skeleton (sub-cat tabs + detail control + header camera
        for 사진 비즈), differing only in which sub-cats + tag semantics
        apply. Both share the same underlying `beads` state — entering
        a category pins beads.combo to that flavour via openCategory. */
  if (category === 'compact' || category === 'chunk') {
    const activeCombo: BeadCombo = category
    const combo = BEAD_COMBOS.find((c) => c.id === activeCombo)
    const catTitle = tr(combo?.label ?? '')
    // 속비즈 (chunk) here no longer exposes 코팅 — coating lives on
    // the 속슬라임 tab now, since the 슬라임/속슬라임 pair is where
    // the coating decision belongs. The 속슬라임 panel renders its
    // own copy of the sub-cat list further down.
    const subs =
      activeCombo === 'chunk'
        ? BEAD_SUB_CATEGORIES_BY_COMBO.chunk.filter((s) => s.id !== 'coating')
        : (BEAD_SUB_CATEGORIES_BY_COMBO[activeCombo] ?? [])
    const activeSub = subs.some((s) => s.id === beadsSub)
      ? beadsSub
      : (subs[0]?.id ?? '')
    // Tags for every currently-active bead selection in THIS combo.
    // Only render tags when the combo actually matches the category
    // — otherwise stale chunk-only fields (count / coating) would
    // show up under compact when the user switches away and back.
    const beadTags: SelectionTag[] = []
    if (beads.combo === activeCombo) {
      beads.colors.forEach((cid) => {
        beadTags.push({
          key: `bc-${cid}`,
          label: resolveColorLabel(cid),
          onRemove: () =>
            onBeads({ ...beads, colors: beads.colors.filter((x) => x !== cid) })
        })
      })
      beads.shapes.forEach((sid) => {
        const s = BEAD_SHAPES.find((x) => x.id === sid)
        if (!s || beads.shapes.length <= 1) return
        beadTags.push({
          key: `bs-${sid}`,
          label: tr(s.label),
          onRemove: () =>
            onBeads({ ...beads, shapes: beads.shapes.filter((x) => x !== sid) })
        })
      })
      if (beads.material !== 'plastic') {
        const bm = BEAD_MATERIALS.find((x) => x.id === beads.material)
        if (bm) {
          beadTags.push({
            key: `bm-${beads.material}`,
            label: tr(bm.label),
            onRemove: () => onBeads({ ...beads, material: 'plastic' })
          })
        }
      }
      if (activeCombo === 'chunk' && beads.coating !== 'none') {
        const bc = COATINGS.find((x) => x.id === beads.coating)
        if (bc) {
          beadTags.push({
            key: `bcoat-${beads.coating}`,
            label: tr(bc.label),
            onRemove: () => onBeads({ ...beads, coating: 'none' })
          })
        }
      }
    }
    return (
      <div className={styles.panel} data-hud>
        {insideToggleBtn}
        {primaryChipsRow}
        <input
          ref={pickerInputRef}
          type="file"
          accept="image/*"
          capture="user"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.currentTarget.files?.[0]
            e.currentTarget.value = ''
            const target = pickerTargetRef.current
            pickerTargetRef.current = null
            if (!f || !target) return
            if (target.kind === 'sticker') onPickSticker(f)
            else if (target.kind === 'customPhoto') onPickCustomBeadsPhoto(f)
            else onPickPhotoBead(target.index, f)
          }}
        />
        <Header title={catTitle} onBack={goBack} tags={beadTags} />
        <div className={styles.tabs}>
          {subs.map((s) => (
            <button
              key={s.id}
              className={styles.tab}
              data-active={activeSub === s.id}
              type="button"
              onClick={() => {
                setBeadsSub(s.id)
                setActiveAdjustColor(null)
              }}
            >
              {tr(s.label)}
            </button>
          ))}
        </div>
        {activeSub === 'color' && (
          <>
            <div className={styles.optionsRow}>
              {/* 그라데이션 토글 — compact / chunk 양쪽에서 노출. OFF일
                  때 다수색은 첫 색 하나만 적용, ON일 때 상하 그라데이션
                  (compact = 슬라임 세로축 밴드, chunk = 비드마다 위→아래
                  전체 팔레트) 사용. beads.colors 두 개 이상일 때만 실질
                  차이가 남. Pinned OUTSIDE the scrolling chip row so it
                  stays visible while the palette scrolls sideways. */}
              <button
                type="button"
                className={styles.chip}
                data-active={beads.gradient ? 'true' : undefined}
                onClick={() =>
                  onBeads({ ...beads, gradient: !beads.gradient })
                }
                aria-label={tr('그라데이션 토글')}
                aria-pressed={!!beads.gradient}
              >
                <GradientIcon />
              </button>
              <div className={styles.options}>
              {BEAD_COLORS.map((c) => {
                const active = beads.colors.includes(c.id)
                return (
                  <button
                    key={c.id}
                    className={styles.chip}
                    data-active={active}
                    data-adjust-target={activeAdjustColor === c.id ? 'true' : undefined}
                    type="button"
                    onClick={() => {
                      // Same double-click semantics as slime: first
                      // click adds + focuses, click again on focused
                      // chip deselects it, click a different active
                      // chip re-focuses without deselect.
                      if (active) {
                        // Click on already-selected colour never
                        // deselects — only switches the adjust slider
                        // target. Removal via tag × only.
                        setActiveAdjustColor(c.id)
                      } else {
                        onBeads({
                          ...beads,
                          colors: [...beads.colors, c.id]
                        })
                        if (colorAdjustments[c.id] === undefined) {
                          onColorAdjustment(c.id, 0, 0)
                        }
                        setActiveAdjustColor(c.id)
                      }
                    }}
                    aria-label={tr(c.label)}
                    aria-pressed={active}
                  >
                    <span
                      className={styles.swatch}
                      style={{
                        background: hexToCss(
                          resolveColorHex(c.id, colorAdjustments)
                        )
                      }}
                    />
                    <span className={styles.chipLabel}>{tr(c.label)}</span>
                  </button>
                )
              })}
              </div>
            </div>
            {activeAdjustColor && (
              <ColorAdjustSliders
                colorId={activeAdjustColor}
                adjustments={colorAdjustments}
                onChange={onColorAdjustment}
              />
            )}
          </>
        )}
        {activeSub === 'count' && activeCombo === 'chunk' && (() => {
          // Same fallback as 속슬라임: if beads.combo is still stuck at
          // the compact / none default (size 0.13, below chunk sizeMin
          // 0.3) after a global reset that landed the user on this tab,
          // treat the slider ceiling as the chunk default so counts stay
          // sensible, and snap size / fill into chunk defaults on move.
          const chunkCfg = BEAD_COMBOS.find((x) => x.id === 'chunk')
          const sizeForCap =
            beads.combo === 'chunk'
              ? beads.size
              : (chunkCfg?.defaults.size ?? 0.46)
          return (
          <div className={styles.sliderRow}>
            <input
              type="range"
              min={1}
              max={beadChunkMaxCount(sizeForCap)}
              step={1}
              value={Math.min(beads.count, beadChunkMaxCount(sizeForCap))}
              onChange={(e) => {
                const nextCount = parseInt(e.currentTarget.value)
                const needsDefaults = beads.combo !== 'chunk'
                onBeads({
                  ...beads,
                  ...(needsDefaults && chunkCfg
                    ? chunkCfg.defaults
                    : {}),
                  combo: 'chunk',
                  count: nextCount,
                  fill: false
                })
              }}
              className={styles.slider}
              aria-label={tr('비즈 양')}
            />
            <span className={styles.sliderValue}>
              {Math.min(beads.count, beadChunkMaxCount(sizeForCap))}
            </span>
          </div>
          )
        })()}
        {activeSub === 'size' && (() => {
          const comboMin = combo?.sizeMin ?? BEADS_LIMITS.sizeMin
          // Per-shape min applies ONLY to the compact (mini) combo.
          // Chunk beads are always ≥ 0.3 which already dwarfs the
          // cube corner-rounding, so the shape-based floor is
          // irrelevant there.
          const shapeMin =
            activeCombo === 'compact'
              ? beadShapesMinSize(beads.shapes)
              : 0
          const sizeMin = Math.max(comboMin, shapeMin)
          const comboMax = combo?.sizeMax ?? BEADS_LIMITS.sizeMax
          // Compact combo lets a specific shape extend the ceiling
          // (cube → 0.4) since cube grids stay tight at larger sizes;
          // chunk stays on its own combo max.
          const shapeMax =
            activeCombo === 'compact'
              ? beadShapesMaxSize(beads.shapes)
              : comboMax
          const sizeMax = Math.max(comboMax, shapeMax)
          const clampedSize = Math.min(Math.max(beads.size, sizeMin), sizeMax)
          return (
            <div className={styles.sliderRow}>
              <input
                type="range"
                min={sizeMin}
                max={sizeMax}
                step={0.02}
                value={clampedSize}
                onChange={(e) => {
                  const size = parseFloat(e.currentTarget.value)
                  if (activeCombo === 'chunk') {
                    const cap = beadChunkMaxCount(size)
                    onBeads({
                      ...beads,
                      size,
                      count: Math.min(beads.count, cap)
                    })
                  } else {
                    onBeads({ ...beads, size })
                  }
                }}
                className={styles.slider}
                aria-label={tr('비즈 크기')}
              />
              <span className={styles.sliderValue}>
                {clampedSize.toFixed(2)}
              </span>
            </div>
          )
        })()}
        {activeSub === 'shape' && (() => {
          // When any photo slot is active in compact mode, sphere and
          // torus are hidden — orthographic photo UV collapses on
          // their curved outward surfaces and reads as no photo. The
          // remaining shapes (원반 / 큐브 / 별 / 하트) all have flat
          // or near-flat front faces that hold the printed photo.
          const photosActive =
            activeCombo === 'compact' &&
            photoBeadSlots.some(Boolean)
          const disabledShapes: BeadShapeId[] = photosActive
            ? ['sphere', 'torus']
            : []
          return (
            <div className={styles.options}>
              {BEAD_SHAPES.filter((s) => !disabledShapes.includes(s.id)).map(
                (s) => (
                  <button
                    key={s.id}
                    className={styles.chip}
                    data-active={beads.shapes.includes(s.id)}
                    type="button"
                    onClick={() => toggleBeadShape(s.id)}
                    aria-pressed={beads.shapes.includes(s.id)}
                  >
                    <span className={styles.chipLabel}>{tr(s.label)}</span>
                  </button>
                )
              )}
            </div>
          )
        })()}
        {activeSub === 'material' && (
          <div className={styles.options}>
            {(activeCombo === 'compact'
              ? COMPACT_BEAD_MATERIALS
              : CHUNK_BEAD_MATERIALS
            ).map((m) => (
              <button
                key={m.id}
                className={styles.chip}
                data-active={beads.material === m.id}
                type="button"
                onClick={() => onBeads({ ...beads, material: m.id })}
              >
                <span className={styles.chipLabel}>{tr(m.label)}</span>
              </button>
            ))}
          </div>
        )}
        {activeSub === 'coating' && activeCombo === 'chunk' && (
          <div className={styles.options}>
            {COATINGS.map((c) => (
              <button
                key={c.id}
                className={styles.chip}
                data-active={beads.coating === c.id}
                type="button"
                onClick={() => onBeads({ ...beads, coating: c.id })}
              >
                <span className={styles.chipLabel}>{tr(c.label)}</span>
              </button>
            ))}
          </div>
        )}
        {activeSub === 'flatness' && activeCombo === 'compact' && (
          <div className={styles.sliderRow}>
            <input
              type="range"
              min={0}
              max={0.58}
              step={0.05}
              value={Math.min(beads.flatness ?? 0, 0.58)}
              onChange={(e) =>
                onBeads({
                  ...beads,
                  flatness: parseFloat(e.currentTarget.value)
                })
              }
              className={styles.slider}
              aria-label={tr('꽉비즈 납작함')}
            />
            <span className={styles.sliderValue}>
              {Math.round(Math.min(beads.flatness ?? 0, 0.58) * 100)}%
            </span>
          </div>
        )}
      </div>
    )
  }

  /* ── Sprinkle leaves (스팽글 / 가루 / 잉크): each is its own primary
        chip now, so the type picker is never rendered — the sprinkleType
        is force-set by openCategory to match the leaf and users land
        directly in the sub-cat chips + active control. */
  if (category === 'paper' || category === 'powder' || category === 'ink') {
    // Derive the sprinkle type from the category itself instead of the
    // sprinkleType state — that way switching primary chips can never
    // show stale sub-cats for the previous type between renders.
    const effectiveType: SprinkleTypeId = category
    const typeCfg = sprinkles[effectiveType]
    const subs = SPRINKLE_SUB_CATEGORIES[effectiveType] ?? []
    const activeSub = subs.some((s) => s.id === sprinkleSub)
      ? sprinkleSub
      : (subs[0]?.id ?? '')
    const isPaper = effectiveType === 'paper'
    const isInk = effectiveType === 'ink'
    // Each sprinkle leaf lands straight in its sub-cat picker — no
    // step-1 type chip row to bounce through anymore.
    const showDetail = subs.length > 0
    const countMax =
      effectiveType === 'paper'
        ? SPRINKLES_LIMITS.paperCountMax
        : effectiveType === 'powder'
          ? SPRINKLES_LIMITS.powderCountMax
          : SPRINKLES_LIMITS.inkCountMax
    const countMin =
      effectiveType === 'powder'
        ? SPRINKLES_LIMITS.powderCountMin
        : SPRINKLES_LIMITS.countMin
    // Tags for currently-active sprinkle type's selections. Removing
    // a color tag drops it from that type's palette; removing an
    // 'active' tag zeroes the count so the whole type turns off.
    const sprinkleTags: SelectionTag[] = []
    if (typeCfg.count > 0 || ('fill' in typeCfg && typeCfg.fill)) {
      const tLabel = tr(SPRINKLE_TYPES.find((t) => t.id === effectiveType)?.label ?? '')
      if (tLabel) {
        sprinkleTags.push({
          key: `stype-${effectiveType}`,
          label: `${tLabel} 사용중`,
          onRemove: () => {
            if (effectiveType === 'paper') {
              onSprinkles({
                ...sprinkles,
                paper: { ...sprinkles.paper, count: 0, fill: false }
              })
            } else if (effectiveType === 'powder') {
              onSprinkles({
                ...sprinkles,
                powder: { ...sprinkles.powder, count: 0, fill: false }
              })
            } else {
              onSprinkles({
                ...sprinkles,
                ink: { ...sprinkles.ink, count: 0 }
              })
            }
          }
        })
      }
      typeCfg.colors.forEach((cid) => {
        const c = SPRINKLE_COLORS.find((x) => x.id === cid)
        if (!c) return
        sprinkleTags.push({
          key: `sc-${effectiveType}-${cid}`,
          label: tr(c.label),
          onRemove: () => {
            const next = typeCfg.colors.filter((x) => x !== cid)
            if (effectiveType === 'paper') {
              onSprinkles({
                ...sprinkles,
                paper: { ...sprinkles.paper, colors: next }
              })
            } else if (effectiveType === 'powder') {
              onSprinkles({
                ...sprinkles,
                powder: { ...sprinkles.powder, colors: next }
              })
            } else {
              onSprinkles({
                ...sprinkles,
                ink: { ...sprinkles.ink, colors: next }
              })
            }
          }
        })
      })
    }
    return (
      <div className={styles.panel} data-hud>
        {primaryChipsRow}
        <Header title={catLabel} onBack={goBack} tags={sprinkleTags} />
        {showDetail && (
          <div className={styles.tabs}>
            {subs.map((s) => (
              <button
                key={s.id}
                className={styles.tab}
                data-active={activeSub === s.id}
                type="button"
                onClick={() => {
                  setSprinkleSub(s.id)
                  setActiveAdjustColor(null)
                }}
              >
                {tr(s.label)}
              </button>
            ))}
          </div>
        )}
        {showDetail && activeSub === 'color' && (
          <div className={styles.options}>
            {SPRINKLE_COLORS.map((c) => {
              // Sprinkle colours share the same colourAdjustments map
              // as slime/beads, but under a `sp:` prefix so a sprinkle
              // 'pink' tune doesn't collide with the slime 'pink' tune.
              const adjustKey = `sp:${c.id}`
              return (
                <button
                  key={c.id}
                  className={styles.chip}
                  data-active={typeCfg.colors.includes(c.id)}
                  type="button"
                  onClick={() => {
                    const has = typeCfg.colors.includes(c.id)
                    toggleSprinkleColor(effectiveType, c.id)
                    if (!has) {
                      if (colorAdjustments[adjustKey] === undefined) {
                        onColorAdjustment(adjustKey, 0, 0)
                      }
                      setActiveAdjustColor(adjustKey)
                    } else if (activeAdjustColor === adjustKey) {
                      setActiveAdjustColor(null)
                    } else {
                      setActiveAdjustColor(adjustKey)
                    }
                  }}
                  aria-label={tr(c.label)}
                  aria-pressed={typeCfg.colors.includes(c.id)}
                >
                  <span
                    className={styles.swatch}
                    style={{ background: hexToCss(c.hex) }}
                  />
                  <span className={styles.chipLabel}>{tr(c.label)}</span>
                </button>
              )
            })}
          </div>
        )}
        {showDetail && activeSub === 'color' && activeAdjustColor && (
          <ColorAdjustSliders
            colorId={activeAdjustColor}
            adjustments={colorAdjustments}
            onChange={onColorAdjustment}
          />
        )}
        {showDetail && activeSub === 'count' && (() => {
          // Paper and powder both expose a "꽉 채우기" toggle in count —
          // paper's fills the surface with confetti pieces, powder's swaps
          // the marble-ribbon distribution for a uniform coating scatter.
          // Ink has no fill mode (it's a shader effect).
          const isPowder = effectiveType === 'powder'
          const supportsFill = isPaper || isPowder
          const isFilling =
            (isPaper && sprinkles.paper.fill) ||
            (isPowder && sprinkles.powder.fill)
          return (
            <div className={styles.beadsGrid}>
              <div className={styles.sliderRow}>
                <input
                  type="range"
                  min={countMin}
                  max={countMax}
                  step={1}
                  value={typeCfg.count}
                  onChange={(e) => {
                    const count = parseInt(e.currentTarget.value)
                    if (isPaper) {
                      updateSprinkleSub('paper', {
                        count,
                        fill: false,
                        colors:
                          sprinkles.paper.colors.length > 0
                            ? sprinkles.paper.colors
                            : [SPRINKLE_COLORS[0].id]
                      })
                    } else if (isPowder) {
                      updateSprinkleSub('powder', {
                        count,
                        fill: false,
                        colors:
                          sprinkles.powder.colors.length > 0
                            ? sprinkles.powder.colors
                            : [SPRINKLE_COLORS[0].id]
                      })
                    } else {
                      updateSprinkleSub(effectiveType, {
                        count,
                        colors:
                          typeCfg.colors.length > 0
                            ? typeCfg.colors
                            : [SPRINKLE_COLORS[0].id]
                      })
                    }
                  }}
                  className={styles.slider}
                  disabled={isFilling}
                  aria-label={tr('스프링클 양')}
                />
                <span className={styles.sliderValue}>
                  {isFilling ? tr('꽉') : typeCfg.count}
                </span>
              </div>
              {supportsFill && (
                <div className={styles.options}>
                  <button
                    type="button"
                    className={styles.chip}
                    data-active={isFilling}
                    onClick={() => {
                      if (isPaper) {
                        updateSprinkleSub('paper', {
                          fill: !sprinkles.paper.fill
                        })
                      } else if (isPowder) {
                        updateSprinkleSub('powder', {
                          fill: !sprinkles.powder.fill
                        })
                      }
                    }}
                  >
                    <span className={styles.chipLabel}>꽉 채우기</span>
                  </button>
                </div>
              )}
            </div>
          )
        })()}
        {showDetail && activeSub === 'size' && isPaper && (() => {
          // Plastic pieces stop reading as chunky beads below ~0.05 —
          // they collapse into visual noise. Floor plastic's slider at
          // 0.05 while paper keeps the full 0.03 range.
          const isPlastic = sprinkles.paper.kind === 'plastic'
          const sMin = isPlastic ? 0.05 : SPRINKLES_LIMITS.sizeMin
          const clamped = Math.max(sprinkles.paper.size, sMin)
          return (
            <div className={styles.sliderRow}>
              <input
                type="range"
                min={sMin}
                max={SPRINKLES_LIMITS.sizeMax}
                step={0.005}
                value={clamped}
                onChange={(e) =>
                  updateSprinkleSub('paper', {
                    size: parseFloat(e.currentTarget.value)
                  })
                }
                className={styles.slider}
                aria-label={tr('스프링클 크기')}
              />
              <span className={styles.sliderValue}>
                {clamped.toFixed(2)}
              </span>
            </div>
          )
        })()}
        {showDetail && activeSub === 'shape' && isPaper && (
          <div className={styles.options}>
            {SPRINKLE_SHAPES.map((s) => (
              <button
                key={s.id}
                className={styles.chip}
                data-active={sprinkles.paper.shape === s.id}
                type="button"
                onClick={() =>
                  updateSprinkleSub('paper', { shape: s.id })
                }
              >
                <span className={styles.chipLabel}>{tr(s.label)}</span>
              </button>
            ))}
          </div>
        )}
        {showDetail && activeSub === 'material' && !isInk && (
          <div className={styles.options}>
            {SPRINKLE_MATERIALS.filter((m) =>
              SPRINKLE_MATERIALS_BY_TYPE[effectiveType].includes(m.id)
            ).map((m) => (
              <button
                key={m.id}
                className={styles.chip}
                data-active={
                  isPaper
                    ? sprinkles.paper.material === m.id
                    : sprinkles.powder.material === m.id
                }
                type="button"
                onClick={() =>
                  isPaper
                    ? updateSprinkleSub('paper', { material: m.id })
                    : updateSprinkleSub('powder', { material: m.id })
                }
              >
                <span className={styles.chipLabel}>{tr(m.label)}</span>
              </button>
            ))}
          </div>
        )}
        {showDetail && activeSub === 'kind' && isPaper && (
          <div className={styles.options}>
            {SPANGLE_KINDS.map((k) => (
              <button
                key={k.id}
                className={styles.chip}
                data-active={sprinkles.paper.kind === k.id}
                type="button"
                onClick={() => {
                  // Plastic reads best at max size — a chunky moulded
                  // bead look. Snap the size slider up on the plastic
                  // pick so the user sees the intended silhouette without
                  // having to hunt for the size sub-cat. Switching BACK
                  // to paper resets to the paper default so plastic's
                  // chunky max doesn't linger as a mismatched paper size.
                  const patch: Partial<typeof sprinkles.paper> = { kind: k.id }
                  if (k.id === 'plastic') {
                    patch.size = SPRINKLES_LIMITS.sizeMax
                  } else if (k.id === 'paper') {
                    patch.size = SPRINKLES_DEFAULT.paper.size
                  }
                  updateSprinkleSub('paper', patch)
                }}
              >
                <span className={styles.chipLabel}>{tr(k.label)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }

  /* ── Inner slime (속슬라임): mirror of 속비즈 (chunk beads) config
        that lives under the slime tab. Panel reuses chunk sub-cats
        (색상/양/크기/모양/재질/코팅) bound to innerSlime state; the
        dedicated inner BeadsLayer instance in SlimeApp applies a
        soft compress-on-press so it visibly squishes. */
  if (category === 'inner-slime') {
    const subs = BEAD_SUB_CATEGORIES_BY_COMBO.chunk
    const activeSub = subs.some((s) => s.id === beadsSub)
      ? beadsSub
      : (subs[0]?.id ?? '')
    const combo = BEAD_COMBOS.find((c) => c.id === 'chunk')
    const beadTags: SelectionTag[] = []
    innerSlime.colors.forEach((cid) => {
      beadTags.push({
        key: `is-c-${cid}`,
        label: resolveColorLabel(cid),
        onRemove: () =>
          onInnerSlime({
            ...innerSlime,
            colors: innerSlime.colors.filter((x) => x !== cid)
          })
      })
    })
    innerSlime.shapes.forEach((sid) => {
      const s = BEAD_SHAPES.find((x) => x.id === sid)
      if (!s || innerSlime.shapes.length <= 1) return
      beadTags.push({
        key: `is-s-${sid}`,
        label: tr(s.label),
        onRemove: () =>
          onInnerSlime({
            ...innerSlime,
            shapes: innerSlime.shapes.filter((x) => x !== sid)
          })
      })
    })
    // 슬라임볼 material palette matches the slime's own (crystal / glossy /
    // matte / metal); tag it against MATERIALS instead of BEAD_MATERIALS,
    // and treat 'crystal' as the default (no chip → no tag).
    if (innerSlime.material !== 'crystal') {
      const sm = MATERIALS.find((x) => x.id === innerSlime.material)
      if (sm) {
        beadTags.push({
          key: `is-m-${innerSlime.material}`,
          label: tr(sm.label),
          onRemove: () =>
            onInnerSlime({ ...innerSlime, material: 'crystal' })
        })
      }
    }
    if (innerSlime.coating !== 'none') {
      const bc = COATINGS.find((x) => x.id === innerSlime.coating)
      if (bc) {
        beadTags.push({
          key: `is-co-${innerSlime.coating}`,
          label: tr(bc.label),
          onRemove: () => onInnerSlime({ ...innerSlime, coating: 'none' })
        })
      }
    }
    const isSphereMin = beadShapesMinSize(innerSlime.shapes)
    const sizeMin = Math.max(combo?.sizeMin ?? BEADS_LIMITS.sizeMin, isSphereMin)
    // 슬라임볼 lets a SINGLE ball grow up to 0.58 so it reads as a
    // notably larger core than the multi-ball chunk max (0.46) without
    // overflowing the slime volume. Multi-ball layouts stay on the
    // chunk sizeMax (0.46).
    const sizeMax =
      innerSlime.count <= 1 ? 0.58 : combo?.sizeMax ?? BEADS_LIMITS.sizeMax
    const clampedSize = Math.min(
      Math.max(innerSlime.size, sizeMin),
      sizeMax
    )
    return (
      <div className={styles.panel} data-hud>
        {primaryChipsRow}
        <Header title={catLabel} onBack={goBack} tags={beadTags} />
        <div className={styles.tabs}>
          {subs.map((s) => (
            <button
              key={s.id}
              className={styles.tab}
              data-active={activeSub === s.id}
              type="button"
              onClick={() => {
                setBeadsSub(s.id)
                setActiveAdjustColor(null)
              }}
            >
              {tr(s.label)}
            </button>
          ))}
        </div>
        {activeSub === 'color' && (
          <div className={styles.optionsRow}>
            {/* Gradient toggle — same as beads. Multi-colour slime ball
                only shows a top-to-bottom gradient when ON; otherwise
                the ball uses the first picked colour. Pinned outside
                the scrolling chip row so it stays visible on scroll. */}
            <button
              type="button"
              className={styles.chip}
              data-active={innerSlime.gradient ? 'true' : undefined}
              onClick={() =>
                onInnerSlime({
                  ...innerSlime,
                  gradient: !innerSlime.gradient
                })
              }
              aria-label={tr('그라데이션 토글')}
              aria-pressed={!!innerSlime.gradient}
            >
              <GradientIcon />
            </button>
            <div className={styles.options}>
            {BEAD_COLORS.map((c) => (
              <button
                key={c.id}
                className={styles.chip}
                data-active={innerSlime.colors.includes(c.id)}
                data-adjust-target={activeAdjustColor === c.id ? 'true' : undefined}
                type="button"
                onClick={() => {
                  const has = innerSlime.colors.includes(c.id)
                  if (!has) {
                    onInnerSlime({
                      ...innerSlime,
                      colors: [...innerSlime.colors, c.id]
                    })
                    if (colorAdjustments[c.id] === undefined) {
                      onColorAdjustment(c.id, 0, 0)
                    }
                  }
                  // Click on already-selected colour never deselects —
                  // only switches the adjust slider target. Removal
                  // via tag × only.
                  setActiveAdjustColor(c.id)
                }}
                aria-label={tr(c.label)}
                aria-pressed={innerSlime.colors.includes(c.id)}
              >
                <span
                  className={styles.swatch}
                  style={{
                    background: hexToCss(
                      resolveColorHex(c.id, colorAdjustments)
                    )
                  }}
                />
                <span className={styles.chipLabel}>{tr(c.label)}</span>
              </button>
            ))}
            </div>
          </div>
        )}
        {activeSub === 'color' && activeAdjustColor && (
          <ColorAdjustSliders
            colorId={activeAdjustColor}
            adjustments={colorAdjustments}
            onChange={onColorAdjustment}
          />
        )}
        {activeSub === 'count' && (() => {
          // If the ball hasn't been flipped into the chunk combo yet
          // (e.g. after a global reset that dropped innerSlime back to
          // BEADS_DEFAULT while the user was still on this tab), the
          // stored size (0.13) is below chunk's 0.3 sizeMin and would
          // render as tiny sub-min balls. Coerce the slider ceiling to
          // the chunk default and, when the user actually moves the
          // slider, spread the chunk defaults so size / fill snap to
          // sensible chunk values as the combo flips over.
          const chunkCfg = BEAD_COMBOS.find((x) => x.id === 'chunk')
          const sizeForCap =
            innerSlime.combo === 'chunk'
              ? innerSlime.size
              : (chunkCfg?.defaults.size ?? 0.46)
          return (
          <div className={styles.sliderRow}>
            <input
              type="range"
              min={1}
              max={beadChunkMaxCount(sizeForCap)}
              step={1}
              value={Math.min(
                innerSlime.count,
                beadChunkMaxCount(sizeForCap)
              )}
              onChange={(e) => {
                const nextCount = parseInt(e.currentTarget.value)
                const needsDefaults = innerSlime.combo !== 'chunk'
                onInnerSlime({
                  ...innerSlime,
                  ...(needsDefaults && chunkCfg
                    ? chunkCfg.defaults
                    : {}),
                  combo: 'chunk',
                  count: nextCount,
                  fill: false
                })
              }}
              className={styles.slider}
              aria-label={tr('속슬라임 양')}
            />
            <span className={styles.sliderValue}>
              {Math.min(
                innerSlime.count,
                beadChunkMaxCount(sizeForCap)
              )}
            </span>
          </div>
          )
        })()}
        {activeSub === 'size' && (
          <div className={styles.sliderRow}>
            <input
              type="range"
              min={sizeMin}
              max={sizeMax}
              step={0.02}
              value={clampedSize}
              onChange={(e) => {
                const size = parseFloat(e.currentTarget.value)
                const cap = beadChunkMaxCount(size)
                onInnerSlime({
                  ...innerSlime,
                  combo: 'chunk',
                  size,
                  count: Math.min(innerSlime.count, cap)
                })
              }}
              className={styles.slider}
              aria-label={tr('속슬라임 크기')}
            />
            <span className={styles.sliderValue}>
              {clampedSize.toFixed(2)}
            </span>
          </div>
        )}
        {activeSub === 'shape' && (
          <div className={styles.options}>
            {BEAD_SHAPES.map((s) => (
              <button
                key={s.id}
                className={styles.chip}
                data-active={innerSlime.shapes.includes(s.id)}
                type="button"
                onClick={() => {
                  const has = innerSlime.shapes.includes(s.id)
                  if (has && innerSlime.shapes.length === 1) return
                  onInnerSlime({
                    ...innerSlime,
                    shapes: has
                      ? innerSlime.shapes.filter((x) => x !== s.id)
                      : [...innerSlime.shapes, s.id]
                  })
                }}
                aria-pressed={innerSlime.shapes.includes(s.id)}
              >
                <span className={styles.chipLabel}>{tr(s.label)}</span>
              </button>
            ))}
          </div>
        )}
        {activeSub === 'material' && (
          <div className={styles.options}>
            {MATERIALS.map((m) => (
              <button
                key={m.id}
                className={styles.chip}
                data-active={innerSlime.material === m.id}
                type="button"
                onClick={() =>
                  onInnerSlime({ ...innerSlime, material: m.id })
                }
              >
                <span className={styles.chipLabel}>{tr(m.label)}</span>
              </button>
            ))}
          </div>
        )}
        {activeSub === 'coating' && (
          <>
            <div className={styles.options}>
              {COATINGS.map((c) => (
                <button
                  key={c.id}
                  className={styles.chip}
                  data-active={innerSlime.coating === c.id}
                  type="button"
                  onClick={() =>
                    onInnerSlime({ ...innerSlime, coating: c.id })
                  }
                >
                  <span className={styles.chipLabel}>{tr(c.label)}</span>
                </button>
              ))}
            </div>
            {innerSlime.coating !== 'none' && (
              <>
                <div className={styles.options}>
                  {COLORS.map((c) => {
                    const active = (innerSlime.coatingColors ?? []).includes(
                      c.id
                    )
                    const adjustKey = `ic:${c.id}`
                    return (
                      <button
                        key={c.id}
                        className={styles.chip}
                        data-active={active}
                        data-adjust-target={activeAdjustColor === adjustKey ? 'true' : undefined}
                        type="button"
                        onClick={() => {
                          const cur = innerSlime.coatingColors ?? []
                          const has = cur.includes(c.id)
                          if (!has) {
                            onInnerSlime({
                              ...innerSlime,
                              coatingColors: [...cur, c.id]
                            })
                            if (colorAdjustments[adjustKey] === undefined) {
                              onColorAdjustment(adjustKey, 0, 0)
                            }
                          }
                          // Click on already-selected coating colour
                          // only switches adjust target — removal via
                          // tag × only.
                          setActiveAdjustColor(adjustKey)
                        }}
                        aria-label={tr(c.label)}
                        aria-pressed={active}
                      >
                        <span
                          className={styles.swatch}
                          style={{
                            background: hexToCss(
                              resolveInnerCoatingHex(c.id, colorAdjustments)
                            )
                          }}
                        />
                        <span className={styles.chipLabel}>{tr(c.label)}</span>
                      </button>
                    )
                  })}
                </div>
                {activeAdjustColor &&
                  activeAdjustColor.startsWith('ic:') && (
                    <ColorAdjustSliders
                      colorId={activeAdjustColor}
                      adjustments={colorAdjustments}
                      onChange={onColorAdjustment}
                    />
                  )}
              </>
            )}
          </>
        )}
      </div>
    )
  }

  /* ── Custom beads (커스텀비즈): emoji-style additive layer of
        coloured accent 3D beads. 4 sub-cats — color / count / size /
        shape — reusing the bead colour palette + shape list. Physics
        (positioning, drag-to-move) handled by the CustomBeadsLayer
        which mirrors the emoji bead pipeline. */
  if (category === 'custom-beads') {
    const CUSTOM_SUBS = [
      { id: 'count', label: '양' },
      { id: 'size', label: '크기' },
      { id: 'shape', label: '모양' },
      { id: 'color', label: '색상' },
      { id: 'flatness', label: '두께' }
    ] as const
    // Sphere excluded from custom-beads shape choices — the orthographic
    // photo projection collapses onto a sphere's tiny cap, and the
    // accent-bead aesthetic reads better with the flat-faced shapes.
    const CUSTOM_BEAD_SHAPES = BEAD_SHAPES.filter((s) => s.id !== 'sphere')
    const activeSub = CUSTOM_SUBS.some((s) => s.id === beadsSub)
      ? beadsSub
      : 'count'
    const beadTags: SelectionTag[] = []
    customBeads.colors.forEach((cid) => {
      beadTags.push({
        key: `cb-c-${cid}`,
        label: resolveColorLabel(cid),
        onRemove: () =>
          onCustomBeads({
            ...customBeads,
            colors: customBeads.colors.filter((x) => x !== cid)
          })
      })
    })
    customBeads.shapes.forEach((sid) => {
      const s = BEAD_SHAPES.find((x) => x.id === sid)
      if (!s || customBeads.shapes.length <= 1) return
      beadTags.push({
        key: `cb-s-${sid}`,
        label: tr(s.label),
        onRemove: () =>
          onCustomBeads({
            ...customBeads,
            shapes: customBeads.shapes.filter((x) => x !== sid)
          })
      })
    })
    return (
      <div className={styles.panel} data-hud>
        {insideToggleBtn}
        {primaryChipsRow}
        <input
          ref={pickerInputRef}
          type="file"
          accept="image/*"
          capture="user"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.currentTarget.files?.[0]
            e.currentTarget.value = ''
            const target = pickerTargetRef.current
            pickerTargetRef.current = null
            if (!f || !target) return
            if (target.kind === 'sticker') onPickSticker(f)
            else if (target.kind === 'customPhoto') onPickCustomBeadsPhoto(f)
            else onPickPhotoBead(target.index, f)
          }}
        />
        <Header
          title={catLabel}
          onBack={goBack}
          tags={beadTags}
          rightAction={{
            ariaLabel: customBeadsPhotoOn ? tr('사진 지우기') : tr('사진 인쇄'),
            active: customBeadsPhotoOn,
            onClick: () => {
              if (customBeadsPhotoOn) onClearCustomBeadsPhoto()
              else openPhotoPicker({ kind: 'customPhoto' })
            },
            icon: <CameraIcon />
          }}
        />
        <div className={styles.tabs}>
          <CameraTriggerChip
            ariaLabel={customBeadsPhotoOn ? tr('사진 교체') : tr('사진 인쇄')}
            active={customBeadsPhotoOn}
            onClick={() => openPhotoPicker({ kind: 'customPhoto' })}
          />
          {CUSTOM_SUBS.map((s) => (
            <button
              key={s.id}
              className={styles.tab}
              data-active={activeSub === s.id}
              type="button"
              onClick={() => {
                setBeadsSub(s.id)
                setActiveAdjustColor(null)
              }}
            >
              {tr(s.label)}
            </button>
          ))}
        </div>
        {activeSub === 'color' && (
          <div className={styles.optionsRow}>
            {/* Gradient toggle mirrors the compact-beads one — 2+
                palette picks interpolate across beads when active.
                Pinned outside the scrolling chip row so it stays
                visible while the palette scrolls sideways. */}
            <button
              type="button"
              className={styles.chip}
              data-active={customBeads.gradient ? 'true' : undefined}
              onClick={() =>
                onCustomBeads({
                  ...customBeads,
                  gradient: !customBeads.gradient
                })
              }
              aria-label={tr('그라데이션 토글')}
              aria-pressed={!!customBeads.gradient}
            >
              <GradientIcon />
            </button>
            <div className={styles.options}>
            {BEAD_COLORS.map((c) => {
              const adjustKey = `cb:${c.id}`
              return (
                <button
                  key={c.id}
                  className={styles.chip}
                  data-active={customBeads.colors.includes(c.id)}
                  data-adjust-target={activeAdjustColor === adjustKey ? 'true' : undefined}
                  type="button"
                  onClick={() => {
                    const has = customBeads.colors.includes(c.id)
                    if (!has) {
                      onCustomBeads({
                        ...customBeads,
                        colors: [...customBeads.colors, c.id]
                      })
                      if (colorAdjustments[adjustKey] === undefined) {
                        onColorAdjustment(adjustKey, 0, 0)
                      }
                    }
                    // Click on already-selected colour never deselects
                    // — only switches the adjust slider target. Removal
                    // via tag × only.
                    setActiveAdjustColor(adjustKey)
                  }}
                  aria-pressed={customBeads.colors.includes(c.id)}
                >
                  <span
                    className={styles.swatch}
                    style={{
                      background: hexToCss(
                        resolveCustomBeadHex(c.id, colorAdjustments)
                      )
                    }}
                  />
                  <span className={styles.chipLabel}>{tr(c.label)}</span>
                </button>
              )
            })}
            </div>
          </div>
        )}
        {activeSub === 'color' && activeAdjustColor && (
          <ColorAdjustSliders
            colorId={activeAdjustColor}
            adjustments={colorAdjustments}
            onChange={onColorAdjustment}
          />
        )}
        {activeSub === 'count' && (
          <div className={styles.sliderRow}>
            <input
              type="range"
              min={CUSTOM_BEADS_LIMITS.countMin}
              max={CUSTOM_BEADS_LIMITS.countMax}
              step={1}
              value={customBeads.count}
              onChange={(e) =>
                onCustomBeads({
                  ...customBeads,
                  count: parseInt(e.currentTarget.value)
                })
              }
              className={styles.slider}
              aria-label={tr('추가비즈 양')}
            />
            <span className={styles.sliderValue}>
              {customBeads.count}
            </span>
          </div>
        )}
        {activeSub === 'size' && (
          <div className={styles.sliderRow}>
            <input
              type="range"
              min={CUSTOM_BEADS_LIMITS.sizeMin}
              max={CUSTOM_BEADS_LIMITS.sizeMax}
              step={0.01}
              value={customBeads.size}
              onChange={(e) =>
                onCustomBeads({
                  ...customBeads,
                  size: parseFloat(e.currentTarget.value)
                })
              }
              className={styles.slider}
              aria-label={tr('추가비즈 크기')}
            />
            <span className={styles.sliderValue}>
              {customBeads.size.toFixed(2)}
            </span>
          </div>
        )}
        {activeSub === 'shape' && (
          <div className={styles.options}>
            {CUSTOM_BEAD_SHAPES.map((s) => (
              <button
                key={s.id}
                className={styles.chip}
                data-active={customBeads.shapes.includes(s.id)}
                type="button"
                onClick={() => {
                  const has = customBeads.shapes.includes(s.id)
                  if (has && customBeads.shapes.length === 1) return
                  onCustomBeads({
                    ...customBeads,
                    shapes: has
                      ? customBeads.shapes.filter((x) => x !== s.id)
                      : [...customBeads.shapes, s.id]
                  })
                }}
                aria-pressed={customBeads.shapes.includes(s.id)}
              >
                <span className={styles.chipLabel}>{tr(s.label)}</span>
              </button>
            ))}
          </div>
        )}
        {activeSub === 'flatness' && (
          <div className={styles.sliderRow}>
            <input
              type="range"
              min={0}
              max={0.58}
              step={0.05}
              value={Math.min(customBeads.flatness, 0.58)}
              onChange={(e) =>
                onCustomBeads({
                  ...customBeads,
                  flatness: parseFloat(e.currentTarget.value)
                })
              }
              className={styles.slider}
              aria-label={tr('추가비즈 두께')}
            />
            <span className={styles.sliderValue}>
              {Math.round(Math.min(customBeads.flatness, 0.58) * 100)}%
            </span>
          </div>
        )}
      </div>
    )
  }

  /* ── Theme: palette chips + per-emoji toggles + count/size sliders.
        Themes are emoji palettes only — they no longer overwrite the rest
        of the slime, so this view is self-contained. */
  if (category === 'theme') {
    const activePalette = emojiBeads.themeId
      ? (THEMES.find((t) => t.id === emojiBeads.themeId) ?? null)
      : null
    const toggleEmoji = (emoji: string) => {
      const has = emojiBeads.emojis.includes(emoji)
      const nextEmojis = has
        ? emojiBeads.emojis.filter((e) => e !== emoji)
        : [...emojiBeads.emojis, emoji]
      // Auto-bump count from 0 → default the first time an emoji is picked
      // so the layer becomes visible without a second slider tweak.
      const nextCount =
        !has && emojiBeads.count === 0 ? 8 : emojiBeads.count
      onEmojiBeads({
        ...emojiBeads,
        emojis: nextEmojis,
        count: nextCount
      })
    }
    const emojiTags: SelectionTag[] = emojiBeads.emojis.map((e) => ({
      key: `em-${e}`,
      label: e,
      onRemove: () =>
        onEmojiBeads({
          ...emojiBeads,
          emojis: emojiBeads.emojis.filter((x) => x !== e)
        })
    }))
    return (
      <div className={styles.panel} data-hud>
        {insideToggleBtn}
        {primaryChipsRow}
        <Header title={catLabel} onBack={goBack} tags={emojiTags} />
        <div className={styles.options}>
          {THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              className={styles.chip}
              data-active={emojiBeads.themeId === t.id}
              onClick={() => {
                // Switching themes NO LONGER clears the selected
                // emoji list — cross-theme picks accumulate so a
                // user can combine e.g. spring flowers + winter
                // snowflakes on one slime. Toggling the active
                // theme off just hides the palette; existing
                // emojis stay placed.
                if (emojiBeads.themeId === t.id) {
                  onEmojiBeads({
                    ...emojiBeads,
                    themeId: null
                  })
                } else {
                  onEmojiBeads({
                    ...emojiBeads,
                    themeId: t.id
                  })
                }
              }}
            >
              <span className={styles.chipLabel}>{tr(t.label)}</span>
            </button>
          ))}
        </div>
        {activePalette && (
          <div className={styles.options}>
            {activePalette.emojis.map((e) => (
              <button
                key={e}
                type="button"
                className={`${styles.chip} ${styles.emojiChip}`}
                data-active={emojiBeads.emojis.includes(e)}
                onClick={() => toggleEmoji(e)}
                aria-label={`이모지 ${e}`}
              >
                <span className={styles.emojiChipLabel}>{e}</span>
              </button>
            ))}
          </div>
        )}
        {emojiBeads.emojis.length > 0 && (
          <>
            <div className={styles.sliderRow}>
              <input
                type="range"
                min={EMOJI_BEADS_LIMITS.countMin}
                max={EMOJI_BEADS_LIMITS.countMax}
                step={1}
                value={emojiBeads.count}
                onChange={(e) =>
                  onEmojiBeads({
                    ...emojiBeads,
                    count: parseInt(e.currentTarget.value)
                  })
                }
                className={styles.slider}
                aria-label={tr('이모지 양')}
              />
              <span className={styles.sliderValue}>
                {emojiBeads.count}
              </span>
            </div>
            <div className={styles.sliderRow}>
              <input
                type="range"
                min={EMOJI_BEADS_LIMITS.sizeMin}
                max={EMOJI_BEADS_LIMITS.sizeMax}
                step={0.01}
                value={emojiBeads.size}
                onChange={(e) =>
                  onEmojiBeads({
                    ...emojiBeads,
                    size: parseFloat(e.currentTarget.value)
                  })
                }
                className={styles.slider}
                aria-label={tr('이모지 크기')}
              />
              <span className={styles.sliderValue}>
                {emojiBeads.size.toFixed(2)}
              </span>
            </div>
          </>
        )}
      </div>
    )
  }

  return null
}

export type SelectionTag = {
  key: string
  label?: string
  /** Optional swatch. When present the tag renders a filled circle
   *  in this colour instead of (or alongside) the label. Format is
   *  any valid CSS colour string (`#a1b2c3`, `rgb(...)`, etc.). */
  swatchColor?: string
  onRemove: () => void
  /** Optional category id to navigate to when the tag body is
   *  clicked (i.e. clicking anywhere on the pill EXCEPT the ×
   *  button). Lets users jump straight from a tag back into the
   *  option that owns it. */
  targetCategory?: string
  /** Optional sub-cat id (e.g. 'color', 'size', 'material', 'coating',
   *  'shape', 'text', 'kind', 'count', 'flatness') to open INSIDE
   *  the target category. Without this, the primary category opens
   *  on its own default sub-cat and clicking a "슬라임 색상" tag
   *  would land on 재질 instead of 색상. */
  targetSubCategory?: string
}

function Header(_: {
  title?: string
  onBack?: () => void
  tags?: readonly SelectionTag[]
  rightAction?: unknown
}) {
  // Selected-option tags render in a unified row below CustomizePanel
  // (in SlimeApp) now, so this in-panel header renders nothing. The
  // signature stays intact so existing call sites compile untouched.
  return null
}
