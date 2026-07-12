import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { useHandLandmarker } from '../hooks/useHandLandmarker'
import { SlimeSphere, type WeightedTip } from '../slime/SlimeSphere'
import { BeadsLayer } from '../slime/BeadsLayer'
import {
  BEADS_DEFAULT,
  type BeadsConfig,
  type CoatingId,
  type ColorId,
  type ShapeId
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

export default function SlimeApp() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const { status: handStatus, error: handError, detect } = useHandLandmarker()
  const [cameraStatus, setCameraStatus] = useState<
    'idle' | 'requesting' | 'ready' | 'error'
  >('idle')
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [handCount, setHandCount] = useState(0)
  const [skeletonOn, setSkeletonOn] = useState(true)
  const skeletonOnRef = useRef(skeletonOn)
  useEffect(() => {
    skeletonOnRef.current = skeletonOn
  }, [skeletonOn])

  // Scale state lives entirely in a ref — no UI reads it, and pinch / wheel
  // handlers write directly without triggering React re-renders.
  const sizeRef = useRef(1)

  // Customization state.
  const [color, setColor] = useState<ColorId>('pink')
  const [coating, setCoating] = useState<CoatingId>('glossy')
  const [shape, setShape] = useState<ShapeId>('sphere')
  const [beads, setBeads] = useState<BeadsConfig>(BEADS_DEFAULT)

  // Imperative handles exposed by the scene effect.
  const applyRef = useRef<{
    setColor: (v: ColorId) => void
    setCoating: (v: CoatingId) => void
    setShape: (v: ShapeId) => void
    setBeads: (v: BeadsConfig) => void
    reset: () => void
  } | null>(null)

  useEffect(() => {
    applyRef.current?.setColor(color)
  }, [color])
  useEffect(() => {
    applyRef.current?.setCoating(coating)
  }, [coating])
  useEffect(() => {
    applyRef.current?.setShape(shape)
  }, [shape])
  useEffect(() => {
    applyRef.current?.setBeads(beads)
  }, [beads])

  // Procedural sound — no assets, no volume UI. Instantiated once, resumed
  // from the first user gesture (Safari/iOS autoplay policy).
  const soundRef = useRef<SoundEngine | null>(null)
  if (soundRef.current === null) soundRef.current = new SoundEngine()
  useEffect(() => {
    const engine = soundRef.current
    return () => {
      engine?.dispose()
    }
  }, [])

  // Start camera on mount.
  useEffect(() => {
    let stream: MediaStream | null = null
    let cancelled = false
    ;(async () => {
      setCameraStatus('requesting')
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'user',
            width: { ideal: 1280 },
            height: { ideal: 720 }
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
    }
  }, [])

  // Three.js scene + render loop.
  useEffect(() => {
    const canvas = canvasRef.current
    const video = videoRef.current
    if (!canvas || !video) return

    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance'
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
      45,
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

    // Background glow orb behind sphere for depth.
    const bg = new THREE.Mesh(
      new THREE.SphereGeometry(4, 32, 32),
      new THREE.MeshBasicMaterial({
        color: 0x1a1130,
        side: THREE.BackSide
      })
    )
    scene.add(bg)

    const slime = new SlimeSphere()
    scene.add(slime.mesh)

    const beadsLayer = new BeadsLayer()
    slime.mesh.add(beadsLayer.group)

    // Expose imperative setters so React effects can push customization changes
    // without tearing down the scene.
    applyRef.current = {
      setColor: (v) => slime.setColor(v),
      setCoating: (v) => {
        slime.setCoating(v)
        // Wax is the only "hard" coating — enable crack rendering there.
        // When leaving wax, wipe any accumulated cracks so the surface is
        // clean under a soft coating.
        const isWax = v === 'wax'
        slime.setDamageRenderingEnabled(isWax)
        if (!isWax) slime.clearDamage()
      },
      setShape: (v) => {
        slime.setShape(v)
        beadsLayer.reseat(slime.unitDirsArray)
      },
      setBeads: (v) => beadsLayer.setConfig(v, slime.unitDirsArray),
      reset: () => {
        slime.reset()
        beadsLayer.reseat(slime.unitDirsArray)
      }
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
    let lastReportedHandCount = -1
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

    // Sound trigger state.
    let smoothedPressure = 0

    const ROT_SENS = 5.5 // radians per full-screen normalized delta
    const clamp = (v: number, a: number, b: number) =>
      v < a ? a : v > b ? b : v

    // Screen-touch gestures: single pointer drag = rotate, two pointers = pinch.
    // Any scale change goes through setSize so the slider stays in sync.
    const activePointers = new Map<
      number,
      { x: number; y: number; prevX: number; prevY: number }
    >()
    let pinchStartDist = 0
    let pinchStartScale = 1
    let rotateDragId: number | null = null
    const container = canvas.parentElement as HTMLElement | null

    const pinchDistance = () => {
      const pts = Array.from(activePointers.values())
      const dx = pts[0].x - pts[1].x
      const dy = pts[0].y - pts[1].y
      return Math.hypot(dx, dy)
    }
    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return
      // First user gesture unlocks the AudioContext on Safari/iOS.
      soundRef.current?.resume()
      // Fire-and-forget: try to load real slime sample files. Missing files
      // are silently ignored and the synthesized fallback keeps playing.
      soundRef.current?.loadSquishSamples(SQUISH_SAMPLE_URLS)
      // Ignore touches that start on the HUD (slider, toggle) — otherwise
      // dragging them would trigger sphere rotation / pinch anchor.
      const target = e.target as HTMLElement | null
      if (target?.closest('[data-hud]')) return
      activePointers.set(e.pointerId, {
        x: e.clientX,
        y: e.clientY,
        prevX: e.clientX,
        prevY: e.clientY
      })
      if (activePointers.size === 1) {
        rotateDragId = e.pointerId
      } else if (activePointers.size === 2) {
        // Entering pinch mode — suspend rotation drag.
        rotateDragId = null
        pinchStartDist = pinchDistance()
        pinchStartScale = sizeRef.current
      }
    }
    const onPointerMove = (e: PointerEvent) => {
      const p = activePointers.get(e.pointerId)
      if (!p) return
      p.prevX = p.x
      p.prevY = p.y
      p.x = e.clientX
      p.y = e.clientY

      if (activePointers.size === 2 && pinchStartDist > 0) {
        const d = pinchDistance()
        sizeRef.current = clamp(
          pinchStartScale * (d / pinchStartDist),
          SCALE_MIN,
          SCALE_MAX
        )
      } else if (activePointers.size === 1 && rotateDragId === e.pointerId) {
        const w = container?.clientWidth || window.innerWidth
        const h = container?.clientHeight || window.innerHeight
        const ref = Math.min(w, h) || 1
        const dx = (p.x - p.prevX) / ref
        const dy = (p.y - p.prevY) / ref
        rotVelY += dx * ROT_SENS
        rotVelX += dy * ROT_SENS
      }
    }
    const onPointerUp = (e: PointerEvent) => {
      activePointers.delete(e.pointerId)
      if (activePointers.size < 2) {
        pinchStartDist = 0
      }
      if (activePointers.size === 1) {
        // Coming down from a pinch — promote the remaining finger back to
        // rotation drag, but reset its "previous" position so no delta jump.
        const [remaining] = activePointers.values()
        remaining.prevX = remaining.x
        remaining.prevY = remaining.y
        rotateDragId = Array.from(activePointers.keys())[0]
      } else if (activePointers.size === 0) {
        rotateDragId = null
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
      // Trackpad pinch reports much finer deltaY — bump the factor so it
      // still feels responsive.
      const factor = e.ctrlKey ? 0.014 : 0.0035
      sizeRef.current = clamp(
        sizeRef.current * Math.exp(-e.deltaY * factor),
        SCALE_MIN,
        SCALE_MAX
      )
    }
    container?.addEventListener('wheel', onWheel, { passive: false })

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
        overlayCtx.strokeStyle = 'rgba(180, 235, 255, 0.9)'
        overlayCtx.lineWidth = lineWidth
        overlayCtx.beginPath()
        for (const [a, b] of HAND_CONNECTIONS) {
          const la = hand[a]
          const lb = hand[b]
          if (!la || !lb) continue
          overlayCtx.moveTo(la.x * w, la.y * h)
          overlayCtx.lineTo(lb.x * w, lb.y * h)
        }
        overlayCtx.stroke()

        overlayCtx.fillStyle = 'rgba(255, 180, 220, 0.95)'
        for (const lm of hand) {
          if (!lm) continue
          overlayCtx.beginPath()
          overlayCtx.arc(lm.x * w, lm.y * h, jointR, 0, Math.PI * 2)
          overlayCtx.fill()
        }
      }

      overlayCtx.restore()
    }

    const loop = () => {
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

      if (video.readyState >= 2 && video.videoWidth > 0) {
        // MediaPipe requires strictly increasing timestamps.
        const ts = Math.max(Math.floor(now), lastDetectMs + 1)
        lastDetectMs = ts
        const res = detect(video, ts)
        const count = res?.landmarks?.length ?? 0
        if (count !== lastReportedHandCount) {
          lastReportedHandCount = count
          setHandCount(count)
        }
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
              addTipFromScreen(lm.x, lm.y, weight, FINGERTIP_RADIUS)
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
                addTipFromScreen(sx / valid, sy / valid, avg, 0.85)
              }
            }
          }
        } else {
          latestHands = []
        }
      }

      slime.update(localTips, dt)
      beadsLayer.update(slime.positionArray)

      // Sound: continuous squish tied to how much force is currently being
      // applied, plus a crack whenever damage crosses the next fracture step
      // (only under wax coating — other coatings don't render damage).
      const sound = soundRef.current
      if (sound) {
        const rawPressure = slime.pressureThisFrame
        // Normalize very roughly; pushStrength * ~6 tips ~= 84 at max hard press.
        const target = Math.min(1, rawPressure / 55)
        // Ease so it doesn't stutter as tips flicker on/off in tracking.
        smoothedPressure += (target - smoothedPressure) * 0.25
        sound.setSquishLevel(smoothedPressure)

        if (slime.damageRenderingEnabled) {
          const stress = slime.pressureThisFrame
          if (stress > 0.5) {
            // No local timer — SoundEngine's 30ms internal rate limit
            // handles pacing. Fire crack every frame while under stress.
            sound.playCrack(Math.min(1, 0.4 + stress / 45))
          }
        }
      }

      // Apply rotation velocity with decay + clamp pitch to avoid flipping.
      slime.mesh.rotation.y += rotVelY
      slime.mesh.rotation.x += rotVelX
      slime.mesh.rotation.x = clamp(
        slime.mesh.rotation.x,
        -Math.PI / 2 + 0.15,
        Math.PI / 2 - 0.15
      )
      rotVelY *= 0.88
      rotVelX *= 0.88

      // Smoothly ease toward the target scale (slider or pinch → sizeRef).
      currentScale += (sizeRef.current - currentScale) * 0.18
      slime.mesh.scale.setScalar(currentScale)

      renderer.render(scene, camera)
      drawSkeleton()
    }
    raf = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      container?.removeEventListener('pointerdown', onPointerDown)
      container?.removeEventListener('pointermove', onPointerMove)
      container?.removeEventListener('pointerup', onPointerUp)
      container?.removeEventListener('pointercancel', onPointerUp)
      container?.removeEventListener('pointerleave', onPointerUp)
      container?.removeEventListener('wheel', onWheel)
      applyRef.current = null
      beadsLayer.dispose()
      slime.dispose()
      envTex.dispose()
      pmrem.dispose()
      renderer.dispose()
    }
  }, [detect])

  const busy = cameraStatus !== 'ready' || handStatus !== 'ready'
  const busyLabel =
    cameraStatus === 'requesting'
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

      <div className={styles.hud}>
        <div className={styles.title}>왁부 슬라임</div>
        <div className={styles.subtitle}>
          손 펴서 눌러 납작하게 · 오므리면 힘 뺌 · 드래그: 회전 · 핀치: 크기
        </div>
        <div className={styles.stats}>손 감지: {handCount}개</div>
      </div>

      <div className={styles.controls} data-hud>
        <CustomizePanel
          color={color}
          coating={coating}
          shape={shape}
          beads={beads}
          onColor={setColor}
          onCoating={setCoating}
          onShape={setShape}
          onBeads={setBeads}
        />

        <div className={styles.compactRow}>
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
            onClick={() => setSkeletonOn((v) => !v)}
            aria-pressed={skeletonOn}
          >
            <span
              className={styles.toggleDot}
              data-on={skeletonOn ? 'true' : 'false'}
            />
            스켈레톤 {skeletonOn ? 'ON' : 'OFF'}
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
