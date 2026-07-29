import { useState } from 'react'
import {
  BEAD_COLORS,
  BEAD_COMBOS,
  BEAD_MATERIALS,
  BEAD_SHAPES,
  BEADS_LIMITS,
  COATING_COLORS,
  COATINGS,
  COLORS,
  EMOJI_BEADS_LIMITS,
  MATERIALS,
  SHAPES,
  SPRINKLE_COLORS,
  SPRINKLE_MATERIALS,
  SPRINKLE_MATERIALS_BY_TYPE,
  SPRINKLE_SHAPES,
  SPRINKLE_SUB_CATEGORIES,
  SPRINKLE_TYPES,
  SPRINKLES_LIMITS,
  THEMES,
  beadChunkMaxCount,
  type BeadCombo,
  type BeadColorId,
  type BeadShapeId,
  type BeadsConfig,
  type CoatingColorId,
  type CoatingId,
  type ColorId,
  type EmojiBeadsConfig,
  type MaterialId,
  type ShapeId,
  type SprinkleColorId,
  type SprinkleTypeId,
  type SprinklesConfig
} from '../slime/presets'
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
type CategoryId = 'slime' | 'beads' | 'sprinkles' | 'theme'

const CATEGORIES: readonly { id: CategoryId; label: string }[] = [
  { id: 'slime', label: '슬라임' },
  { id: 'beads', label: '비즈' },
  { id: 'sprinkles', label: '스프링클' },
  { id: 'theme', label: '이모지' }
]

type SlimeSub = 'color' | 'material' | 'coating' | 'shape'
const SLIME_SUBS: readonly { id: SlimeSub; label: string }[] = [
  { id: 'color', label: '색상' },
  { id: 'material', label: '재질' },
  { id: 'coating', label: '코팅' },
  { id: 'shape', label: '모양' }
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
    { id: 'material', label: '재질' }
  ],
  chunk: [
    { id: 'color', label: '색상' },
    { id: 'count', label: '양' },
    { id: 'size', label: '크기' },
    { id: 'shape', label: '모양' },
    { id: 'material', label: '재질' },
    { id: 'coating', label: '코팅' }
  ]
}

interface Props {
  colors: readonly ColorId[]
  material: MaterialId
  coating: CoatingId
  coatingColors: readonly ColorId[]
  foilColors: readonly CoatingColorId[]
  shape: ShapeId
  beads: BeadsConfig
  sprinkles: SprinklesConfig
  emojiBeads: EmojiBeadsConfig
  onColors: (v: ColorId[]) => void
  onMaterial: (v: MaterialId) => void
  onCoating: (v: CoatingId) => void
  onCoatingColors: (v: ColorId[]) => void
  onFoilColors: (v: CoatingColorId[]) => void
  onShape: (v: ShapeId) => void
  onBeads: (v: BeadsConfig) => void
  onSprinkles: (v: SprinklesConfig) => void
  onEmojiBeads: (v: EmojiBeadsConfig) => void
}

function hexToCss(h: number): string {
  return '#' + h.toString(16).padStart(6, '0')
}

export default function CustomizePanel({
  colors,
  material,
  coating,
  coatingColors,
  foilColors,
  shape,
  beads,
  sprinkles,
  emojiBeads,
  onColors,
  onMaterial,
  onCoating,
  onCoatingColors,
  onFoilColors,
  onShape,
  onBeads,
  onSprinkles,
  onEmojiBeads
}: Props) {
  const [category, setCategory] = useState<CategoryId | null>(null)
  // Per-category active sub-category. Each category remembers the last
  // sub-cat the user was on so re-entering the category feels continuous.
  const [slimeSub, setSlimeSub] = useState<SlimeSub>('color')
  const [beadsSub, setBeadsSub] = useState<string>('color')
  const [sprinkleType, setSprinkleType] = useState<SprinkleTypeId>('paper')
  // Sub-cat inside a sprinkle type — defaults to 'count' so drilling into
  // paper / powder / ink lands the user on the amount slider first (the
  // most common tweak) instead of the colour picker.
  const [sprinkleSub, setSprinkleSub] = useState<string>('count')
  // Two-step drill for beads and sprinkles: entering the category shows
  // ONLY the 2nd-level picker (combo/type) — the sub-cat chips + detail
  // control appear once the user commits to a combo/type. This keeps the
  // initial view uncluttered on categories that have three levels of depth.
  const [beadsDrilled, setBeadsDrilled] = useState(false)
  const [sprinklesDrilled, setSprinklesDrilled] = useState(false)

  const openCategory = (c: CategoryId) => {
    setCategory(c)
    // Always start on the 2nd-level picker when (re-)entering a two-step
    // category, so the user can consciously pick the flavour they want
    // instead of being auto-drilled into whatever combo/type was left over.
    if (c === 'beads') setBeadsDrilled(false)
    if (c === 'sprinkles') setSprinklesDrilled(false)
  }

  const toggleBeadColor = (id: BeadColorId) => {
    const has = beads.colors.includes(id)
    const next = has
      ? beads.colors.filter((c) => c !== id)
      : [...beads.colors, id]
    onBeads({ ...beads, colors: next })
  }

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

  /* ── Level 1: root category picker ─────────────────────────── */
  if (category === null) {
    return (
      <div className={styles.panel} data-hud>
        <div className={styles.tabs}>
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              className={styles.tab}
              type="button"
              onClick={() => openCategory(c.id)}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>
    )
  }

  const catLabel = CATEGORIES.find((c) => c.id === category)?.label
  const goBack = () => {
    // Drilled beads / sprinkles views go back to their 2nd-level picker
    // first, THEN to root — matches the two-step drill on the way in.
    if (category === 'beads' && beadsDrilled) {
      setBeadsDrilled(false)
      return
    }
    if (category === 'sprinkles' && sprinklesDrilled) {
      setSprinklesDrilled(false)
      return
    }
    setCategory(null)
  }

  /* ── Slime: sub-cat chips + active control on one panel ───── */
  if (category === 'slime') {
    return (
      <div className={styles.panel} data-hud>
        <Header title={catLabel} onBack={goBack} />
        <div className={styles.tabs}>
          {SLIME_SUBS.map((s) => (
            <button
              key={s.id}
              className={styles.tab}
              data-active={slimeSub === s.id}
              type="button"
              onClick={() => setSlimeSub(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
        {slimeSub === 'color' && (
          <div className={styles.options}>
            {COLORS.map((c) => {
              // Multi-select: clicking a chip toggles the colour in the
              // list. Two or more picks are rendered as a top-to-bottom
              // gradient in the slime shader. Deselecting the LAST colour
              // is blocked so the slime always has at least one hue —
              // otherwise it'd fall back to white and confuse the user.
              const active = colors.includes(c.id)
              return (
                <button
                  key={c.id}
                  className={styles.chip}
                  data-active={active}
                  type="button"
                  onClick={() => {
                    if (active) {
                      if (colors.length <= 1) return
                      onColors(colors.filter((x) => x !== c.id))
                    } else {
                      onColors([...colors, c.id])
                    }
                  }}
                  aria-label={c.label}
                  aria-pressed={active}
                >
                  <span
                    className={styles.swatch}
                    style={{ background: hexToCss(c.hex) }}
                  />
                  <span className={styles.chipLabel}>{c.label}</span>
                </button>
              )
            })}
          </div>
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
                <span className={styles.chipLabel}>{m.label}</span>
              </button>
            ))}
          </div>
        )}
        {slimeSub === 'coating' && (
          <div className={styles.beadsGrid}>
            <div className={styles.options}>
              {COATINGS.map((c) => (
                <button
                  key={c.id}
                  className={styles.chip}
                  data-active={coating === c.id}
                  type="button"
                  onClick={() => onCoating(c.id)}
                >
                  <span className={styles.chipLabel}>{c.label}</span>
                </button>
              ))}
            </div>
            {coating === 'foil' ? (
              <div className={styles.options}>
                {COATING_COLORS.map((c) => {
                  // Multi-select for foil colours — 2+ picks paint a
                  // top-to-bottom gradient across the metallic sheet.
                  // Last remaining pick is locked so there's always ≥1
                  // colour driving the tint (otherwise it'd fall back
                  // to a hardcoded default).
                  const active = foilColors.includes(c.id)
                  return (
                    <button
                      key={c.id}
                      className={styles.chip}
                      data-active={active}
                      type="button"
                      onClick={() => {
                        if (active) {
                          if (foilColors.length <= 1) return
                          onFoilColors(foilColors.filter((x) => x !== c.id))
                        } else {
                          onFoilColors([...foilColors, c.id])
                        }
                      }}
                      aria-label={c.label}
                      aria-pressed={active}
                    >
                      <span
                        className={styles.swatch}
                        style={{ background: hexToCss(c.hex) }}
                      />
                      <span className={styles.chipLabel}>{c.label}</span>
                    </button>
                  )
                })}
              </div>
            ) : coating !== 'none' ? (
              <div className={styles.options}>
                {COLORS.map((c) => {
                  // Multi-select for wax / ice coating colours — same
                  // rules as foil, drawing from the general COLORS
                  // palette instead of the metallic one.
                  const active = coatingColors.includes(c.id)
                  return (
                    <button
                      key={c.id}
                      className={styles.chip}
                      data-active={active}
                      type="button"
                      onClick={() => {
                        if (active) {
                          if (coatingColors.length <= 1) return
                          onCoatingColors(
                            coatingColors.filter((x) => x !== c.id)
                          )
                        } else {
                          onCoatingColors([...coatingColors, c.id])
                        }
                      }}
                      aria-label={c.label}
                      aria-pressed={active}
                    >
                      <span
                        className={styles.swatch}
                        style={{ background: hexToCss(c.hex) }}
                      />
                      <span className={styles.chipLabel}>{c.label}</span>
                    </button>
                  )
                })}
              </div>
            ) : null}
          </div>
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
                <span className={styles.chipLabel}>{s.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }

  /* ── Beads: two-step drill.
        Step 1 — only the combo picker (미선택/컴팩트/청크) is shown so the
        user consciously picks a flavour first.
        Step 2 — after picking a non-'none' combo, the picker stays visible
        and the combo's sub-cat chips + active control render below it. */
  if (category === 'beads') {
    const subs = BEAD_SUB_CATEGORIES_BY_COMBO[beads.combo] ?? []
    // Auto-correct the sub-cat if the current one isn't valid for this
    // combo (e.g. user switched from chunk → compact while sitting on
    // 'count' — compact has no 'count' sub-cat). Falls back to the first
    // valid sub-cat rather than showing an empty detail area.
    const activeSub = subs.some((s) => s.id === beadsSub)
      ? beadsSub
      : (subs[0]?.id ?? '')
    const showDetail = beadsDrilled && subs.length > 0
    return (
      <div className={styles.panel} data-hud>
        <Header title={catLabel} onBack={goBack} />
        {/* Combo picker only shows in Step 1 (undrilled). Once the user has
            drilled into a combo, the picker collapses so the panel focuses
            on the sub-cat chips + control below. Back arrow returns here. */}
        {!showDetail && (
          <div className={styles.tabs}>
            {BEAD_COMBOS.map((c) => {
              const active = beads.combo === c.id
              return (
                <button
                  key={c.id}
                  className={styles.tab}
                  data-active={active}
                  type="button"
                  onClick={() => {
                    // Only re-apply combo defaults when switching TO a
                    // different combo — clicking the currently active
                    // combo shouldn't nuke user tweaks (size, count).
                    if (!active) {
                      onBeads({
                        ...beads,
                        combo: c.id,
                        ...c.defaults,
                        // Coating is a chunk-only sub-option — leaving a
                        // previously-picked coating on when switching to
                        // compact / none would keep applying it to the
                        // mini beads even though the panel no longer
                        // exposes the control. Always drop back to
                        // 'none' on combo change; the user can re-pick
                        // coating after entering chunk again.
                        coating: 'none'
                      })
                      // Reset sub-cat to a valid one for the new combo.
                      const next = BEAD_SUB_CATEGORIES_BY_COMBO[c.id][0]
                      if (next) setBeadsSub(next.id)
                    }
                    // Drill into the picked combo (unless it's 'none' —
                    // no sub-options to show there).
                    setBeadsDrilled(c.id !== 'none')
                  }}
                >
                  {c.label}
                </button>
              )
            })}
          </div>
        )}
        {showDetail && (
          <div className={styles.tabs}>
            {subs.map((s) => (
              <button
                key={s.id}
                className={styles.tab}
                data-active={activeSub === s.id}
                type="button"
                onClick={() => setBeadsSub(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>
        )}
        {showDetail && activeSub === 'color' && (
          <div className={styles.options}>
            {BEAD_COLORS.map((c) => (
              <button
                key={c.id}
                className={styles.chip}
                data-active={beads.colors.includes(c.id)}
                type="button"
                onClick={() => toggleBeadColor(c.id)}
                aria-label={c.label}
                aria-pressed={beads.colors.includes(c.id)}
              >
                <span
                  className={styles.swatch}
                  style={{ background: hexToCss(c.hex) }}
                />
                <span className={styles.chipLabel}>{c.label}</span>
              </button>
            ))}
          </div>
        )}
        {showDetail && activeSub === 'count' && beads.combo === 'chunk' && (
          <div className={styles.sliderRow}>
            <input
              type="range"
              min={1}
              max={beadChunkMaxCount(beads.size)}
              step={1}
              value={Math.min(beads.count, beadChunkMaxCount(beads.size))}
              onChange={(e) =>
                onBeads({
                  ...beads,
                  count: parseInt(e.currentTarget.value),
                  fill: false
                })
              }
              className={styles.slider}
              aria-label="비즈 양"
            />
            <span className={styles.sliderValue}>
              {Math.min(beads.count, beadChunkMaxCount(beads.size))}
            </span>
          </div>
        )}
        {showDetail && activeSub === 'size' && (() => {
          const combo = BEAD_COMBOS.find((c) => c.id === beads.combo)
          const sizeMin = combo?.sizeMin ?? BEADS_LIMITS.sizeMin
          const sizeMax = combo?.sizeMax ?? BEADS_LIMITS.sizeMax
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
                  if (beads.combo === 'chunk') {
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
                aria-label="비즈 크기"
              />
              <span className={styles.sliderValue}>
                {clampedSize.toFixed(2)}
              </span>
            </div>
          )
        })()}
        {showDetail && activeSub === 'shape' && (
          <div className={styles.options}>
            {BEAD_SHAPES.map((s) => (
              <button
                key={s.id}
                className={styles.chip}
                data-active={beads.shapes.includes(s.id)}
                type="button"
                onClick={() => toggleBeadShape(s.id)}
                aria-pressed={beads.shapes.includes(s.id)}
              >
                <span className={styles.chipLabel}>{s.label}</span>
              </button>
            ))}
          </div>
        )}
        {showDetail && activeSub === 'material' && (
          <div className={styles.options}>
            {BEAD_MATERIALS.map((m) => (
              <button
                key={m.id}
                className={styles.chip}
                data-active={beads.material === m.id}
                type="button"
                onClick={() => onBeads({ ...beads, material: m.id })}
              >
                <span className={styles.chipLabel}>{m.label}</span>
              </button>
            ))}
          </div>
        )}
        {showDetail && activeSub === 'coating' && beads.combo === 'chunk' && (
          <div className={styles.options}>
            {COATINGS.map((c) => (
              <button
                key={c.id}
                className={styles.chip}
                data-active={beads.coating === c.id}
                type="button"
                onClick={() => onBeads({ ...beads, coating: c.id })}
              >
                <span className={styles.chipLabel}>{c.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }

  /* ── Sprinkles: two-step drill.
        Step 1 — only the type picker (종이/가루/잉크) is shown so the user
        commits to a type before seeing its knobs.
        Step 2 — after picking a type, the picker stays and the type's sub-cat
        chips + active control render below. Back arrow returns to Step 1. */
  if (category === 'sprinkles') {
    const typeCfg = sprinkles[sprinkleType]
    const subs = SPRINKLE_SUB_CATEGORIES[sprinkleType] ?? []
    const activeSub = subs.some((s) => s.id === sprinkleSub)
      ? sprinkleSub
      : (subs[0]?.id ?? '')
    const isPaper = sprinkleType === 'paper'
    const isInk = sprinkleType === 'ink'
    const showDetail = sprinklesDrilled && subs.length > 0
    const countMax =
      sprinkleType === 'paper'
        ? SPRINKLES_LIMITS.paperCountMax
        : sprinkleType === 'powder'
          ? SPRINKLES_LIMITS.powderCountMax
          : SPRINKLES_LIMITS.inkCountMax
    return (
      <div className={styles.panel} data-hud>
        <Header title={catLabel} onBack={goBack} />
        {/* Type picker only shows in Step 1 (undrilled). Once drilled, the
            picker collapses so the panel focuses on the sub-cat chips +
            control below. Back arrow returns here to switch types. */}
        {!showDetail && (
          <div className={styles.tabs}>
            {SPRINKLE_TYPES.map((t) => {
              // Highlight the currently-active type AND any type that
              // already has grains applied, so users spot which they've
              // configured at a glance while still on the picker.
              const isOpen = sprinkleType === t.id
              const isConfigured = sprinkles[t.id].count > 0
              return (
                <button
                  key={t.id}
                  className={styles.tab}
                  data-active={isOpen || isConfigured}
                  type="button"
                  onClick={() => {
                    setSprinkleType(t.id)
                    // Jump straight to the '양' (count) sub-cat every time
                    // a type is picked — that's the first tweak users
                    // reach for, so opening on 색상 felt off. Falls back
                    // to the type's first sub-cat only if 'count' isn't
                    // in its list (defensive; every current type has it).
                    const nextSubs = SPRINKLE_SUB_CATEGORIES[t.id]
                    const hasCount = nextSubs.some((s) => s.id === 'count')
                    setSprinkleSub(hasCount ? 'count' : nextSubs[0]?.id ?? '')
                    setSprinklesDrilled(true)
                  }}
                >
                  {t.label}
                </button>
              )
            })}
          </div>
        )}
        {showDetail && (
          <div className={styles.tabs}>
            {subs.map((s) => (
              <button
                key={s.id}
                className={styles.tab}
                data-active={activeSub === s.id}
                type="button"
                onClick={() => setSprinkleSub(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>
        )}
        {showDetail && activeSub === 'color' && (
          <div className={styles.options}>
            {SPRINKLE_COLORS.map((c) => (
              <button
                key={c.id}
                className={styles.chip}
                data-active={typeCfg.colors.includes(c.id)}
                type="button"
                onClick={() => toggleSprinkleColor(sprinkleType, c.id)}
                aria-label={c.label}
                aria-pressed={typeCfg.colors.includes(c.id)}
              >
                <span
                  className={styles.swatch}
                  style={{ background: hexToCss(c.hex) }}
                />
                <span className={styles.chipLabel}>{c.label}</span>
              </button>
            ))}
          </div>
        )}
        {showDetail && activeSub === 'count' && (() => {
          // Paper and powder both expose a "꽉 채우기" toggle in count —
          // paper's fills the surface with confetti pieces, powder's swaps
          // the marble-ribbon distribution for a uniform coating scatter.
          // Ink has no fill mode (it's a shader effect).
          const isPowder = sprinkleType === 'powder'
          const supportsFill = isPaper || isPowder
          const isFilling =
            (isPaper && sprinkles.paper.fill) ||
            (isPowder && sprinkles.powder.fill)
          return (
            <div className={styles.beadsGrid}>
              <div className={styles.sliderRow}>
                <input
                  type="range"
                  min={SPRINKLES_LIMITS.countMin}
                  max={countMax}
                  step={1}
                  value={typeCfg.count}
                  onChange={(e) => {
                    const count = parseInt(e.currentTarget.value)
                    if (isPaper) {
                      updateSprinkleSub('paper', { count, fill: false })
                    } else if (isPowder) {
                      updateSprinkleSub('powder', { count, fill: false })
                    } else {
                      updateSprinkleSub(sprinkleType, { count })
                    }
                  }}
                  className={styles.slider}
                  disabled={isFilling}
                  aria-label="스프링클 양"
                />
                <span className={styles.sliderValue}>
                  {isFilling ? '꽉' : typeCfg.count}
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
        {showDetail && activeSub === 'size' && isPaper && (
          <div className={styles.sliderRow}>
            <input
              type="range"
              min={SPRINKLES_LIMITS.sizeMin}
              max={SPRINKLES_LIMITS.sizeMax}
              step={0.005}
              value={sprinkles.paper.size}
              onChange={(e) =>
                updateSprinkleSub('paper', {
                  size: parseFloat(e.currentTarget.value)
                })
              }
              className={styles.slider}
              aria-label="스프링클 크기"
            />
            <span className={styles.sliderValue}>
              {sprinkles.paper.size.toFixed(2)}
            </span>
          </div>
        )}
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
                <span className={styles.chipLabel}>{s.label}</span>
              </button>
            ))}
          </div>
        )}
        {showDetail && activeSub === 'material' && !isInk && (
          <div className={styles.options}>
            {SPRINKLE_MATERIALS.filter((m) =>
              SPRINKLE_MATERIALS_BY_TYPE[sprinkleType].includes(m.id)
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
                <span className={styles.chipLabel}>{m.label}</span>
              </button>
            ))}
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
    return (
      <div className={styles.panel} data-hud>
        <Header title={catLabel} onBack={goBack} />
        <div className={styles.options}>
          {THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              className={styles.chip}
              data-active={emojiBeads.themeId === t.id}
              onClick={() => {
                if (emojiBeads.themeId === t.id) {
                  onEmojiBeads({
                    ...emojiBeads,
                    themeId: null,
                    emojis: []
                  })
                } else {
                  onEmojiBeads({
                    ...emojiBeads,
                    themeId: t.id,
                    emojis: []
                  })
                }
              }}
            >
              <span className={styles.chipLabel}>{t.label}</span>
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
                aria-label="이모지 양"
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
                aria-label="이모지 크기"
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

function Header({
  title,
  onBack
}: {
  title: string | undefined
  onBack: () => void
}) {
  return (
    <div className={styles.detailHeader}>
      <button
        className={styles.backButton}
        type="button"
        onClick={onBack}
        aria-label="뒤로"
      >
        {/* SVG chevron centres cleanly inside the circle — the text
            '‹' glyph sat visibly low because its font metrics reserve
            more space below the baseline than above. */}
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="15 6 9 12 15 18" />
        </svg>
      </button>
      <span className={styles.detailTitle}>{title}</span>
    </div>
  )
}
