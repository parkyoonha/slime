/* ─── Colors ─────────────────────────────────────────── */

export type ColorId =
  | 'pink'
  | 'mint'
  | 'lavender'
  | 'peach'
  | 'sky'
  | 'butter'
  | 'cocoa'
  | 'graphite'

export const COLORS: readonly {
  id: ColorId
  label: string
  hex: number
}[] = [
  { id: 'pink', label: '벚꽃', hex: 0xff9ec7 },
  { id: 'mint', label: '민트', hex: 0x9dedd0 },
  { id: 'lavender', label: '라벤더', hex: 0xc4a7e7 },
  { id: 'peach', label: '피치', hex: 0xffbe98 },
  { id: 'sky', label: '하늘', hex: 0x8fbfff },
  { id: 'butter', label: '버터', hex: 0xffe89a },
  { id: 'cocoa', label: '코코아', hex: 0xa87458 },
  { id: 'graphite', label: '먹색', hex: 0x2f2f3a }
]

/* ─── Coatings ───────────────────────────────────────── */

export type CoatingId =
  | 'glossy'
  | 'matte'
  | 'wax'
  | 'crystal'
  | 'cream'
  | 'metal'

export interface CoatingParams {
  roughness: number
  transmission: number
  thickness: number
  ior: number
  clearcoat: number
  clearcoatRoughness: number
  metalness: number
  sheen: number
  sheenRoughness: number
  sheenColorHex: number
}

export const COATINGS: readonly {
  id: CoatingId
  label: string
  params: CoatingParams
}[] = [
  {
    id: 'glossy',
    label: '광택',
    params: {
      roughness: 0.18,
      transmission: 0.35,
      thickness: 1.2,
      ior: 1.35,
      clearcoat: 1.0,
      clearcoatRoughness: 0.08,
      metalness: 0.0,
      sheen: 0.4,
      sheenRoughness: 0.4,
      sheenColorHex: 0xffe0ee
    }
  },
  {
    id: 'matte',
    label: '무광',
    params: {
      roughness: 0.85,
      transmission: 0.0,
      thickness: 0.0,
      ior: 1.4,
      clearcoat: 0.0,
      clearcoatRoughness: 0.0,
      metalness: 0.0,
      sheen: 0.0,
      sheenRoughness: 0.5,
      sheenColorHex: 0xffffff
    }
  },
  {
    id: 'wax',
    label: '왁스',
    params: {
      roughness: 0.45,
      transmission: 0.08,
      thickness: 0.8,
      ior: 1.42,
      clearcoat: 0.55,
      clearcoatRoughness: 0.3,
      metalness: 0.0,
      sheen: 0.8,
      sheenRoughness: 0.6,
      sheenColorHex: 0xfff2d6
    }
  },
  {
    id: 'crystal',
    label: '크리스탈',
    params: {
      roughness: 0.05,
      transmission: 0.95,
      thickness: 0.4,
      ior: 1.5,
      clearcoat: 1.0,
      clearcoatRoughness: 0.04,
      metalness: 0.0,
      sheen: 0.0,
      sheenRoughness: 0.5,
      sheenColorHex: 0xffffff
    }
  },
  {
    id: 'cream',
    label: '크림',
    params: {
      roughness: 0.55,
      transmission: 0.05,
      thickness: 0.4,
      ior: 1.4,
      clearcoat: 0.2,
      clearcoatRoughness: 0.4,
      metalness: 0.0,
      sheen: 1.0,
      sheenRoughness: 0.7,
      sheenColorHex: 0xfff2e0
    }
  },
  {
    id: 'metal',
    label: '메탈',
    params: {
      roughness: 0.28,
      transmission: 0.0,
      thickness: 0.0,
      ior: 2.0,
      clearcoat: 0.6,
      clearcoatRoughness: 0.15,
      metalness: 0.9,
      sheen: 0.0,
      sheenRoughness: 0.5,
      sheenColorHex: 0xffffff
    }
  }
]

/* ─── Shapes ─────────────────────────────────────────── */

export type ShapeId = 'sphere' | 'blob' | 'egg' | 'pumpkin' | 'spike'

export const SHAPES: readonly { id: ShapeId; label: string }[] = [
  { id: 'sphere', label: '구' },
  { id: 'blob', label: '블롭' },
  { id: 'egg', label: '달걀' },
  { id: 'pumpkin', label: '호박' },
  { id: 'spike', label: '가시' }
]

/** Given a unit direction from origin, return per-axis scale for the shape. */
export function shapeScale(
  shape: ShapeId,
  nx: number,
  ny: number,
  nz: number
): [number, number, number] {
  switch (shape) {
    case 'sphere':
      return [1, 1, 1]
    case 'blob': {
      const n =
        1 +
        0.14 *
          Math.sin(nx * 3.1 + 0.7) *
          Math.cos(ny * 2.6) *
          Math.sin(nz * 4.2 - 0.3)
      return [n, n, n]
    }
    case 'egg':
      return [0.85, 1.28, 0.85]
    case 'pumpkin': {
      const grooves = 1 - 0.09 * Math.abs(Math.cos(Math.atan2(nz, nx) * 3))
      return [grooves, 0.88, grooves]
    }
    case 'spike': {
      const s =
        1 +
        0.4 *
          Math.max(0, Math.sin(nx * 5) * Math.sin(ny * 5) * Math.sin(nz * 5))
      return [s, s, s]
    }
  }
}

/* ─── Beads ──────────────────────────────────────────── */

export type BeadColorId =
  | 'pearl'
  | 'pink'
  | 'peach'
  | 'lemon'
  | 'mint'
  | 'sky'
  | 'lavender'
  | 'ruby'
  | 'gold'
  | 'silver'
  | 'coral'
  | 'aqua'

export const BEAD_COLORS: readonly {
  id: BeadColorId
  label: string
  hex: number
}[] = [
  { id: 'pearl', label: '진주', hex: 0xfff8f4 },
  { id: 'pink', label: '핑크', hex: 0xff9ac9 },
  { id: 'peach', label: '피치', hex: 0xffb591 },
  { id: 'lemon', label: '레몬', hex: 0xffe25e },
  { id: 'mint', label: '민트', hex: 0x8fe8c4 },
  { id: 'sky', label: '하늘', hex: 0x8fc7ff },
  { id: 'lavender', label: '라벤더', hex: 0xc5a5f2 },
  { id: 'ruby', label: '루비', hex: 0xf24d6b },
  { id: 'gold', label: '골드', hex: 0xffcf5e },
  { id: 'silver', label: '실버', hex: 0xd6dbe1 },
  { id: 'coral', label: '코랄', hex: 0xff7d7d },
  { id: 'aqua', label: '아쿠아', hex: 0x5ee3d8 }
]

export type BeadDistributionId =
  | 'uniform'
  | 'top'
  | 'bottom'
  | 'equator'
  | 'random'

export const BEAD_DISTRIBUTIONS: readonly {
  id: BeadDistributionId
  label: string
}[] = [
  { id: 'uniform', label: '균일' },
  { id: 'top', label: '상단' },
  { id: 'bottom', label: '하단' },
  { id: 'equator', label: '적도' },
  { id: 'random', label: '랜덤' }
]

/** Material style applied uniformly to every bead in the layer. */
export type BeadMaterialId =
  | 'glossy'
  | 'pearl'
  | 'metal'
  | 'crystal'
  | 'matte'
  | 'iridescent'

export const BEAD_MATERIALS: readonly {
  id: BeadMaterialId
  label: string
}[] = [
  { id: 'glossy', label: '광택' },
  { id: 'pearl', label: '진주' },
  { id: 'metal', label: '메탈' },
  { id: 'crystal', label: '크리스탈' },
  { id: 'matte', label: '무광' },
  { id: 'iridescent', label: '홀로그램' }
]

/** MeshPhysicalMaterial parameter presets per bead material. */
export interface BeadMaterialParams {
  roughness: number
  metalness: number
  clearcoat: number
  clearcoatRoughness: number
  transmission: number
  thickness: number
  ior: number
  sheen: number
  sheenRoughness: number
  iridescence: number
  iridescenceIOR: number
  envMapIntensity: number
}

export const BEAD_MATERIAL_PARAMS: Record<BeadMaterialId, BeadMaterialParams> = {
  glossy: {
    roughness: 0.12,
    metalness: 0.05,
    clearcoat: 1.0,
    clearcoatRoughness: 0.05,
    transmission: 0.0,
    thickness: 0.0,
    ior: 1.5,
    sheen: 0.25,
    sheenRoughness: 0.5,
    iridescence: 0.0,
    iridescenceIOR: 1.3,
    envMapIntensity: 1.3
  },
  pearl: {
    roughness: 0.22,
    metalness: 0.1,
    clearcoat: 1.0,
    clearcoatRoughness: 0.12,
    transmission: 0.0,
    thickness: 0.0,
    ior: 1.5,
    sheen: 1.0,
    sheenRoughness: 0.55,
    iridescence: 0.4,
    iridescenceIOR: 1.3,
    envMapIntensity: 1.4
  },
  metal: {
    roughness: 0.28,
    metalness: 1.0,
    clearcoat: 0.5,
    clearcoatRoughness: 0.18,
    transmission: 0.0,
    thickness: 0.0,
    ior: 2.5,
    sheen: 0.0,
    sheenRoughness: 0.5,
    iridescence: 0.0,
    iridescenceIOR: 1.3,
    envMapIntensity: 1.6
  },
  crystal: {
    roughness: 0.02,
    metalness: 0.0,
    clearcoat: 1.0,
    clearcoatRoughness: 0.02,
    transmission: 0.95,
    thickness: 0.35,
    ior: 1.55,
    sheen: 0.0,
    sheenRoughness: 0.5,
    iridescence: 0.0,
    iridescenceIOR: 1.3,
    envMapIntensity: 1.2
  },
  matte: {
    roughness: 0.9,
    metalness: 0.0,
    clearcoat: 0.0,
    clearcoatRoughness: 0.0,
    transmission: 0.0,
    thickness: 0.0,
    ior: 1.5,
    sheen: 0.35,
    sheenRoughness: 0.8,
    iridescence: 0.0,
    iridescenceIOR: 1.3,
    envMapIntensity: 0.7
  },
  iridescent: {
    roughness: 0.08,
    metalness: 0.15,
    clearcoat: 1.0,
    clearcoatRoughness: 0.04,
    transmission: 0.0,
    thickness: 0.0,
    ior: 1.4,
    sheen: 0.0,
    sheenRoughness: 0.5,
    iridescence: 1.0,
    iridescenceIOR: 1.9,
    envMapIntensity: 1.5
  }
}

export interface BeadsConfig {
  colors: BeadColorId[]
  size: number // radius in local space
  count: number
  distribution: BeadDistributionId
  material: BeadMaterialId
}

export const BEADS_DEFAULT: BeadsConfig = {
  colors: [],
  size: 0.05,
  count: 0,
  distribution: 'uniform',
  material: 'glossy'
}

export const BEADS_LIMITS = {
  sizeMin: 0.02,
  sizeMax: 0.11,
  countMin: 0,
  countMax: 200
}
