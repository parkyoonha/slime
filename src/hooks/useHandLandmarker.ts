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

export function useHandLandmarker() {
  const [status, setStatus] = useState<HandStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const landmarkerRef = useRef<HandLandmarker | null>(null)

  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    ;(async () => {
      try {
        const vision = await FilesetResolver.forVisionTasks(WASM_URL)
        const landmarker = await HandLandmarker.createFromOptions(vision, {
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
        if (cancelled) {
          landmarker.close()
          return
        }
        landmarkerRef.current = landmarker
        setStatus('ready')
      } catch (e) {
        console.error(e)
        setError(e instanceof Error ? e.message : String(e))
        setStatus('error')
      }
    })()
    return () => {
      cancelled = true
      landmarkerRef.current?.close()
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
