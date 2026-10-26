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
  const attempt = (async () => {
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
  // Wipe the shared cache on failure so the NEXT caller retries the
  // fetch from scratch. Without this, one transient network hiccup on
  // app launch would poison the cached promise for the entire session
  // and the user would be stuck seeing "모델 오류" until they killed
  // the app. Retry-on-demand keeps the happy-path fast (cache hit) and
  // the error-path recoverable (next hook use re-attempts the fetch).
  attempt.catch(() => {
    if (landmarkerPromise === attempt) landmarkerPromise = null
  })
  landmarkerPromise = attempt
  return landmarkerPromise
}

/** When `enabled` is false the model download is DEFERRED — no WASM /
 *  model fetch until the caller flips it true. Lets first-launch users
 *  with hand tracking off avoid the 8+ MB cold download (and the "model
 *  fetch error → app closes" crash on a flaky first-run network) that
 *  used to fire the instant the module was imported. Flipping to true
 *  starts the download; failures reset the shared cache so subsequent
 *  attempts retry from scratch. */
export function useHandLandmarker(enabled: boolean = true) {
  const [status, setStatus] = useState<HandStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const landmarkerRef = useRef<HandLandmarker | null>(null)

  useEffect(() => {
    if (!enabled) {
      setStatus('idle')
      setError(null)
      return
    }
    let cancelled = false
    let timeoutId: ReturnType<typeof setTimeout> | null = null
    setStatus('loading')
    setError(null)

    const LOAD_TIMEOUT_MS = 5000
    const MAX_ATTEMPTS = 2

    const attemptLoad = (attempt: number) => {
      if (cancelled) return
      // Reset the shared cache on retry so the next preload call starts
      // fresh instead of returning the (stuck) pending Promise. Without
      // this, every retry just re-awaits the same hung request.
      if (attempt > 0) {
        landmarkerPromise = null
      }

      let timedOut = false
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          timedOut = true
          reject(new Error('HAND_LOAD_TIMEOUT'))
        }, LOAD_TIMEOUT_MS)
      })

      Promise.race([preloadLandmarker(), timeoutPromise]).then(
        (landmarker) => {
          if (cancelled) return
          if (timeoutId) clearTimeout(timeoutId)
          landmarkerRef.current = landmarker as HandLandmarker
          setStatus('ready')
        },
        (e) => {
          if (cancelled) return
          if (timeoutId) clearTimeout(timeoutId)

          // Timeout → retry once. Loads normally finish well under 5s;
          // if it drags past that it's almost always a stuck WASM /
          // model fetch that a fresh request can recover from.
          if (timedOut && attempt + 1 < MAX_ATTEMPTS) {
            console.warn(`Hand landmarker load timed out, retry ${attempt + 1}/${MAX_ATTEMPTS - 1}`)
            attemptLoad(attempt + 1)
            return
          }

          console.error(e)
          setError(e instanceof Error ? e.message : String(e))
          setStatus('error')
        }
      )
    }

    attemptLoad(0)

    return () => {
      cancelled = true
      if (timeoutId) clearTimeout(timeoutId)
      // The shared landmarker instance is intentionally NOT closed here —
      // it's cached in module scope so a hot-reload / remount reuses the
      // already-downloaded WASM+model instead of paying the full startup
      // cost again. In a production single-mount app this leaks nothing.
      landmarkerRef.current = null
    }
  }, [enabled])

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
