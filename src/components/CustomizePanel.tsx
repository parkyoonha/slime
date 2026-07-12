import { useState } from 'react'
import {
  BEAD_COLORS,
  BEAD_DISTRIBUTIONS,
  BEAD_MATERIALS,
  BEADS_LIMITS,
  COATINGS,
  COLORS,
  SHAPES,
  type BeadColorId,
  type BeadsConfig,
  type CoatingId,
  type ColorId,
  type ShapeId
} from '../slime/presets'
import styles from './CustomizePanel.module.css'

type Tab = 'color' | 'coating' | 'shape' | 'beads'

const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'color', label: '색상' },
  { id: 'coating', label: '코팅' },
  { id: 'shape', label: '모양' },
  { id: 'beads', label: '비즈' }
]

interface Props {
  color: ColorId
  coating: CoatingId
  shape: ShapeId
  beads: BeadsConfig
  onColor: (v: ColorId) => void
  onCoating: (v: CoatingId) => void
  onShape: (v: ShapeId) => void
  onBeads: (v: BeadsConfig) => void
}

function hexToCss(h: number): string {
  return '#' + h.toString(16).padStart(6, '0')
}

export default function CustomizePanel({
  color,
  coating,
  shape,
  beads,
  onColor,
  onCoating,
  onShape,
  onBeads
}: Props) {
  // `null` = tab list mode; otherwise showing the detail for that tab.
  const [activeTab, setActiveTab] = useState<Tab | null>(null)

  const toggleBeadColor = (id: BeadColorId) => {
    const has = beads.colors.includes(id)
    const next = has
      ? beads.colors.filter((c) => c !== id)
      : [...beads.colors, id]
    onBeads({ ...beads, colors: next })
  }

  if (activeTab === null) {
    return (
      <div className={styles.panel} data-hud>
        <div className={styles.tabs}>
          {TABS.map((t) => (
            <button
              key={t.id}
              className={styles.tab}
              type="button"
              onClick={() => setActiveTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
    )
  }

  const activeLabel = TABS.find((t) => t.id === activeTab)?.label

  return (
    <div className={styles.panel} data-hud>
      <div className={styles.detailHeader}>
        <button
          className={styles.backButton}
          type="button"
          onClick={() => setActiveTab(null)}
          aria-label="뒤로"
        >
          ‹
        </button>
        <span className={styles.detailTitle}>{activeLabel}</span>
      </div>

      {activeTab === 'color' && (
        <div className={styles.options}>
          {COLORS.map((c) => (
            <button
              key={c.id}
              className={styles.chip}
              data-active={color === c.id}
              type="button"
              onClick={() => onColor(c.id)}
              aria-label={c.label}
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

      {activeTab === 'coating' && (
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
      )}

      {activeTab === 'shape' && (
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

      {activeTab === 'beads' && (
        <div className={styles.beadsGrid}>
          <div className={styles.subLabel}>색상 (여러 개 선택)</div>
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

          <div className={styles.sliderRow}>
            <span className={styles.subLabel}>양</span>
            <input
              type="range"
              min={BEADS_LIMITS.countMin}
              max={BEADS_LIMITS.countMax}
              step={1}
              value={beads.count}
              onChange={(e) =>
                onBeads({ ...beads, count: parseInt(e.currentTarget.value) })
              }
              className={styles.slider}
              aria-label="비즈 양"
            />
            <span className={styles.sliderValue}>{beads.count}</span>
          </div>

          <div className={styles.sliderRow}>
            <span className={styles.subLabel}>크기</span>
            <input
              type="range"
              min={BEADS_LIMITS.sizeMin}
              max={BEADS_LIMITS.sizeMax}
              step={0.005}
              value={beads.size}
              onChange={(e) =>
                onBeads({
                  ...beads,
                  size: parseFloat(e.currentTarget.value)
                })
              }
              className={styles.slider}
              aria-label="비즈 크기"
            />
            <span className={styles.sliderValue}>
              {beads.size.toFixed(2)}
            </span>
          </div>

          <div className={styles.subLabel}>재질</div>
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

          <div className={styles.subLabel}>배치</div>
          <div className={styles.options}>
            {BEAD_DISTRIBUTIONS.map((d) => (
              <button
                key={d.id}
                className={styles.chip}
                data-active={beads.distribution === d.id}
                type="button"
                onClick={() =>
                  onBeads({ ...beads, distribution: d.id })
                }
              >
                <span className={styles.chipLabel}>{d.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
