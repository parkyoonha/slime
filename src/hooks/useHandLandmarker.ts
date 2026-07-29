import { useCallback, useEffect, useRef, useState } from 'react'
import {
  FilesetResolver,
  HandLandmarker,
  type HandLandmarkerResult
} from '@mediapipe/tasks-vision'

const WASM_URL =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.17/wasm'
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'

export type HandStatus = 'idle' | 'loading' | 'ready' | 'error'

export type DetectFn = (
  video: HTMLVideoElement,
  timestampMs: number
) => HandLandmarkerResult | null

/** Shared module-scope Promise so the WASM + model start downloading the
 *  moment this module is IMPORTED (during React's render preparation),
 *  not when the hook's effect fires (after mount + after every other
 *  mount-time effect that runs before it). Saves the head start we'd
 *  otherwise lose to sound-sample fetches, camera permission, PMREM
 *  environment build, and initial layer allocation — all of which had
 *  been pushing the model download by a few hundred ms on first load. */
let landmarkerPromise: Promise<HandLandmarker> | null = null
function preloadLandmarker(): Promise<HandLandmarker> {
  if (landmarkerPromise) return landmarkerPromise
  landmarkerPromise = (async () => {
    const vision = await FilesetResolver.forVisionTasks(WASM_URL)
    return HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: MODEL_URL,
        delegate: 'GPU'
      },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5
    })
  })()
  return landmarkerPromise
}
// Kick off the download at module load time — no `await`, we just want the
// network request in flight before the component even mounts.
void preloadLandmarker().catch(() => {
  // Swallow — the hook's effect will surface any real error via state.
})

export function useHandLandmarker() {
  const [status, setStatus] = useState<HandStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const landmarkerRef = useRef<HandLandmarker | null>(null)

  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    preloadLandmarker().then(
      (landmarker) => {
        if (cancelled) return
        landmarkerRef.current = landmarker
        setStatus('ready')
      },
      (e) => {
        if (cancelled) return
        console.error(e)
        setError(e instanceof Error ? e.message : String(e))
        setStatus('error')
      }
    )
    return () => {
      cancelled = true
      // The shared landmarker instance is intentionally NOT closed here —
      // it's cached in module scope so a hot-reload / remount reuses the
      // already-downloaded WASM+model instead of paying the full startup
      // cost again. In a production single-mount app this leaks nothing.
      landmarkerRef.current = null
    }
  }, [])

  // Stable identity across renders — the effect that spins the render loop
  // must not tear down when unrelated state (hand count, status) changes.
  const detect = useCallback<DetectFn>((video, timestampMs) => {
    const landmarker = landmarkerRef.current
    if (!landmarker) return null
    if (video.readyState < 2) return null
    return landmarker.detectForVideo(video, timestampMs)
  }, [])

  return { status, error, detect }
}
