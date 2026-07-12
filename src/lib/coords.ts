export type Landmark = { x: number; y: number; z: number }

/**
 * MediaPipe hand landmark chains per finger. Thumb has one fewer joint;
 * we repeat its DIP index so downstream code can treat all fingers uniformly.
 * (MCP, PIP, DIP, TIP)
 */
export const FINGERS = [
  { name: 'thumb', mcp: 2, pip: 3, dip: 3, tip: 4 },
  { name: 'index', mcp: 5, pip: 6, dip: 7, tip: 8 },
  { name: 'middle', mcp: 9, pip: 10, dip: 11, tip: 12 },
  { name: 'ring', mcp: 13, pip: 14, dip: 15, tip: 16 },
  { name: 'pinky', mcp: 17, pip: 18, dip: 19, tip: 20 }
] as const

/** MediaPipe standard hand landmark connections (edges of the skeleton graph). */
export const HAND_CONNECTIONS: readonly (readonly [number, number])[] = [
  [0, 1], [1, 2], [2, 3], [3, 4],           // thumb
  [0, 5], [5, 6], [6, 7], [7, 8],           // index
  [5, 9], [9, 10], [10, 11], [11, 12],      // middle
  [9, 13], [13, 14], [14, 15], [15, 16],    // ring
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20] // pinky + palm base
]

function dist(a: Landmark, b: Landmark): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = a.z - b.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

/**
 * Curl amount for a single finger, roughly 0 when fully extended and up to
 * ~0.6 when tightly curled. Computed as (1 - straightDistance / totalChain).
 * Thumb's repeated DIP index degenerates one segment length to zero, which is
 * fine — the calc still tracks the thumb's overall bend.
 */
export function fingerCurl(
  hand: readonly Landmark[],
  finger: (typeof FINGERS)[number]
): number {
  const mcp = hand[finger.mcp]
  const pip = hand[finger.pip]
  const dip = hand[finger.dip]
  const tip = hand[finger.tip]
  if (!mcp || !pip || !dip || !tip) return 0

  const straight = dist(mcp, tip)
  const chain = dist(mcp, pip) + dist(pip, dip) + dist(dip, tip)
  if (chain < 1e-6) return 0
  return 1 - straight / chain
}

/**
 * A straight finger presses, a bent one does not.
 * curl ≤ low → weight 1 (fully extended, full press).
 * curl ≥ high → weight 0 (bent enough that the tip has pulled back).
 */
export function extensionToWeight(
  curl: number,
  low = 0.05,
  high = 0.18
): number {
  const t = Math.min(1, Math.max(0, (curl - low) / (high - low)))
  const s = t * t * (3 - 2 * t)
  return 1 - s
}
