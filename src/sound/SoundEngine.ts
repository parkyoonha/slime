/**
 * Procedural sound synthesis for slime interactions. No audio files —
 * everything is generated from white noise + biquad filters + envelopes so
 * the app has zero download cost for audio.
 *
 * iOS/Safari require a user gesture before an AudioContext will produce sound;
 * call `resume()` from the first pointerdown/touchstart handler.
 */
export class SoundEngine {
  private ctx: AudioContext | null = null
  private masterGain: GainNode | null = null
  private noiseBuffer: AudioBuffer | null = null

  // Squish is played as a continuous loop whose gain we drive with the
  // current kneading intensity. Chain (all → master):
  //   sub sine (pitch-wobbled by slow LFO) → subGain ─┐
  //   noise → bandpass (Q=13, low freq)   ────────────┼→ mix → lowpass → master
  //   LFO → filter.frequency (gurgle)
  //   LFO → sub.frequency  (jelly wobble)
  //   Pump LFO → mix.gain  (breathing)
  // Sine dominates (tonal, gloopy body), noise is a minor wet texture, and
  // the terminal lowpass kills any residual hissy top-end.
  private squishSource: AudioBufferSourceNode | null = null
  private squishFilter: BiquadFilterNode | null = null
  private squishGain: GainNode | null = null
  private squishOut: BiquadFilterNode | null = null
  private squishSubOsc: OscillatorNode | null = null
  private squishSubGain: GainNode | null = null
  private squishLfo: OscillatorNode | null = null
  private squishLfoDepth: GainNode | null = null
  private squishPumpLfo: OscillatorNode | null = null
  private squishPumpDepth: GainNode | null = null
  private squishPitchLfo: OscillatorNode | null = null
  private squishPitchDepth: GainNode | null = null
  private squishSquelchTimer: ReturnType<typeof setTimeout> | null = null
  private squishTargetLevel = 0

  /** Optional real slime sample files. When populated (via loadSquishSamples),
   *  we play random samples on each squelch tick instead of synthesizing —
   *  that gives the authentic sticky "peel" character which pure synthesis
   *  can't match. Loading is silently skipped if any file is missing. */
  private squishSamples: AudioBuffer[] = []
  private squishSamplesLoadStarted = false

  private lastCrackTime = 0

  private volume = 0.9
  private enabled = true

  /** Lazily initialize the AudioContext. Safe to call multiple times. */
  private ensureCtx(): AudioContext | null {
    if (this.ctx) return this.ctx
    const AC =
      (typeof window !== 'undefined' &&
        (window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext)) ||
      null
    if (!AC) return null
    this.ctx = new AC()
    this.masterGain = this.ctx.createGain()
    this.masterGain.gain.value = this.volume
    this.masterGain.connect(this.ctx.destination)
    this.noiseBuffer = this.buildNoiseBuffer(this.ctx)
    return this.ctx
  }

  /** Must be called from a user gesture on iOS/Safari. */
  resume() {
    const ctx = this.ensureCtx()
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {})
  }

  /**
   * Fetch and decode a set of squish sample files. Files that fail to load
   * (missing, wrong format, network error) are silently skipped. Runs at
   * most once per SoundEngine instance.
   */
  async loadSquishSamples(urls: readonly string[]) {
    if (this.squishSamplesLoadStarted) return
    this.squishSamplesLoadStarted = true
    const ctx = this.ensureCtx()
    if (!ctx) return
    const decoded = await Promise.all(
      urls.map(async (url) => {
        try {
          const res = await fetch(url)
          if (!res.ok) return null
          // Dev servers often serve the SPA index.html as a 200 for missing
          // static files. That HTML then blows up in decodeAudioData with a
          // noisy EncodingError. Skip anything that isn't clearly audio.
          const ct = res.headers.get('content-type') || ''
          if (!ct.startsWith('audio/')) return null
          const buf = await res.arrayBuffer()
          return await ctx.decodeAudioData(buf)
        } catch {
          return null
        }
      })
    )
    this.squishSamples = decoded.filter(
      (b): b is AudioBuffer => b !== null
    )
  }

  setEnabled(on: boolean) {
    this.enabled = on
    if (!on) this.stopSquish()
    if (this.masterGain) {
      this.masterGain.gain.value = on ? this.volume : 0
    }
  }

  setVolume(v: number) {
    this.volume = Math.max(0, Math.min(1, v))
    if (this.masterGain && this.enabled) this.masterGain.gain.value = this.volume
  }

  private buildNoiseBuffer(ctx: AudioContext): AudioBuffer {
    const seconds = 2
    const buf = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
    return buf
  }

  /**
   * Drive a soft, wet squelch. `intensity ∈ [0, 1]` — 0 fades the loop out,
   * high values open a low-pass filter and raise gain so it sounds tighter.
   */
  setSquishLevel(intensity: number) {
    if (!this.enabled) return
    const ctx = this.ensureCtx()
    if (!ctx || !this.noiseBuffer || !this.masterGain) return
    const target = Math.max(0, Math.min(1, intensity))
    this.squishTargetLevel = target

    if (target < 0.02) {
      this.stopSquish()
      return
    }

    // Kick off (or keep alive) the sticky "squelch" scheduler. This is what
    // gives the sound its slime character — irregular short pops of the
    // "peel apart" moment.
    if (this.squishSquelchTimer === null) {
      const scheduleSquelch = () => {
        if (this.squishTargetLevel < 0.02) {
          this.squishSquelchTimer = null
          return
        }
        this.playSquelch(this.squishTargetLevel)
        // Faster and denser as intensity rises. When we have real samples
        // we can afford a slower pace (each sample already sounds full).
        const usingSamples = this.squishSamples.length > 0
        const base = usingSamples
          ? 110 + Math.random() * 220
          : 40 + Math.random() * 90
        const scale = 1.4 - this.squishTargetLevel
        this.squishSquelchTimer = setTimeout(scheduleSquelch, base * scale)
      }
      scheduleSquelch()
    }

    // When real sample files are loaded, skip the synthesized "body" —
    // otherwise the drone under samples reads back as the same 웅웅 hum.
    if (this.squishSamples.length > 0) return

    if (!this.squishSource) {
      // --- Noise path (minor wet texture) --------------------------------
      const src = ctx.createBufferSource()
      src.buffer = this.noiseBuffer
      src.loop = true
      const filter = ctx.createBiquadFilter()
      filter.type = 'bandpass'
      filter.frequency.value = 380
      filter.Q.value = 11

      const lfo = ctx.createOscillator()
      lfo.type = 'sine'
      lfo.frequency.value = 2.4
      const lfoDepth = ctx.createGain()
      lfoDepth.gain.value = 160
      lfo.connect(lfoDepth)
      lfoDepth.connect(filter.frequency)

      // --- Sub oscillator (dominant tonal body) --------------------------
      // Triangle at 170Hz: audible on all consumer speakers, has enough
      // upper harmonics to feel "gooey" instead of a pure bass hum, and
      // sits low enough to still read as body rather than a lead tone.
      const sub = ctx.createOscillator()
      sub.type = 'triangle'
      sub.frequency.value = 170
      const subGain = ctx.createGain()
      subGain.gain.value = 0

      // Slow pitch LFO on sub → the jelly wobble.
      const pitchLfo = ctx.createOscillator()
      pitchLfo.type = 'sine'
      pitchLfo.frequency.value = 0.85
      const pitchDepth = ctx.createGain()
      pitchDepth.gain.value = 55
      pitchLfo.connect(pitchDepth)
      pitchDepth.connect(sub.frequency)

      // Very slow amplitude LFO — pump so it doesn't sit as a drone.
      const pumpLfo = ctx.createOscillator()
      pumpLfo.type = 'sine'
      pumpLfo.frequency.value = 1.4
      const pumpDepth = ctx.createGain()
      pumpDepth.gain.value = 0

      const mix = ctx.createGain()
      mix.gain.value = 0

      // Terminal lowpass kills any residual high-frequency hiss so the
      // squish reads purely as "gloopy" and never "airy". Cutoff sits above
      // the bandpass and triangle harmonics so their body isn't wiped out.
      const out = ctx.createBiquadFilter()
      out.type = 'lowpass'
      out.frequency.value = 900
      out.Q.value = 0.7

      src.connect(filter)
      filter.connect(mix)
      sub.connect(subGain)
      subGain.connect(mix)
      pumpLfo.connect(pumpDepth)
      pumpDepth.connect(mix.gain)
      mix.connect(out)
      out.connect(this.masterGain)

      src.start()
      lfo.start()
      sub.start()
      pitchLfo.start()
      pumpLfo.start()

      this.squishSource = src
      this.squishFilter = filter
      this.squishGain = mix
      this.squishOut = out
      this.squishSubOsc = sub
      this.squishSubGain = subGain
      this.squishLfo = lfo
      this.squishLfoDepth = lfoDepth
      this.squishPitchLfo = pitchLfo
      this.squishPitchDepth = pitchDepth
      this.squishPumpLfo = pumpLfo
      this.squishPumpDepth = pumpDepth
    }

    if (this.squishFilter && this.squishGain && this.squishSubGain) {
      const now = ctx.currentTime
      // Filter sits in lower-mid range: warm and wet, not hissy.
      this.squishFilter.frequency.cancelScheduledValues(now)
      this.squishFilter.frequency.setTargetAtTime(
        320 + target * 220,
        now,
        0.06
      )
      // Sub is now background "body" only — the squelch bursts (see
      // playSquelch) carry the tacky slime character, so we keep the drone
      // low to avoid the "웅웅" hum.
      this.squishSubGain.gain.cancelScheduledValues(now)
      this.squishSubGain.gain.setTargetAtTime(target * 0.55, now, 0.06)
      // Mix bus level — pump LFO breathes around this base.
      const base = target * 0.7
      this.squishGain.gain.cancelScheduledValues(now)
      this.squishGain.gain.setTargetAtTime(base, now, 0.06)
      if (this.squishPumpDepth) {
        this.squishPumpDepth.gain.cancelScheduledValues(now)
        this.squishPumpDepth.gain.setTargetAtTime(base * 0.3, now, 0.08)
      }
    }
  }

  /**
   * A single sticky "squelch" — if real sample files are loaded, play a
   * random one at pitch-varied playback rate. Otherwise fall back to a
   * synthesized bandpass-noise burst so there is still some audible cue.
   */
  private playSquelch(intensity: number) {
    const ctx = this.ctx
    if (!ctx || !this.masterGain) return
    const amp = Math.max(0.15, Math.min(1, intensity))

    if (this.squishSamples.length > 0) {
      const buf =
        this.squishSamples[
          Math.floor(Math.random() * this.squishSamples.length)
        ]
      const src = ctx.createBufferSource()
      src.buffer = buf
      // Subtle pitch variation per hit — prevents obvious "same clip"
      // repetition and matches how real slime pops never sound identical.
      const rate = 0.85 + Math.random() * 0.3
      src.playbackRate.value = rate

      // For long recordings we cut a short random window instead of playing
      // the whole clip. Otherwise overlapping full-length plays smear into
      // noise. Short clips (< 0.6s) get played end-to-end.
      const isLong = buf.duration > 0.7
      const winSec = isLong ? 0.22 + Math.random() * 0.25 : buf.duration
      const offsetSec = isLong
        ? Math.random() * Math.max(0, buf.duration - winSec - 0.02)
        : 0

      // Small fade envelope so the abrupt window boundaries don't click.
      const now = ctx.currentTime
      const peak = 0.35 + amp * 0.75
      const gain = ctx.createGain()
      gain.gain.setValueAtTime(0.0001, now)
      gain.gain.exponentialRampToValueAtTime(peak, now + 0.008)
      const playSec = winSec / rate
      gain.gain.setValueAtTime(peak, now + playSec - 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + playSec)

      src.connect(gain)
      gain.connect(this.masterGain)
      src.start(now, offsetSec)
      src.stop(now + playSec + 0.02)
      src.onended = () => {
        src.disconnect()
        gain.disconnect()
      }
      return
    }

    // Fallback: synthesized burst (works until sample files are added).
    if (!this.noiseBuffer) return
    const now = ctx.currentTime
    const src = ctx.createBufferSource()
    src.buffer = this.noiseBuffer
    src.playbackRate.value = 0.4 + Math.random() * 0.7
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = 500 + Math.random() * 1100
    bp.Q.value = 6 + Math.random() * 6
    bp.frequency.setValueAtTime(bp.frequency.value, now)
    bp.frequency.exponentialRampToValueAtTime(
      Math.max(120, bp.frequency.value * 0.35),
      now + 0.05 + Math.random() * 0.05
    )
    const gain = ctx.createGain()
    const peak = amp * (0.35 + Math.random() * 0.25)
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(peak, now + 0.004)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09)
    src.connect(bp)
    bp.connect(gain)
    gain.connect(this.masterGain)
    src.start(now)
    src.stop(now + 0.12)
    src.onended = () => {
      src.disconnect()
      bp.disconnect()
      gain.disconnect()
    }
  }

  stopSquish() {
    if (!this.ctx) return
    this.squishTargetLevel = 0
    if (this.squishSquelchTimer !== null) {
      clearTimeout(this.squishSquelchTimer)
      this.squishSquelchTimer = null
    }
    if (this.squishGain) {
      const now = this.ctx.currentTime
      this.squishGain.gain.cancelScheduledValues(now)
      this.squishGain.gain.setTargetAtTime(0, now, 0.06)
    }
    // Fully tear down after fade so we can rebuild on next call.
    if (this.squishSource) {
      const src = this.squishSource
      const nodes = [
        this.squishGain,
        this.squishFilter,
        this.squishOut,
        this.squishSubGain,
        this.squishLfoDepth,
        this.squishPitchDepth,
        this.squishPumpDepth
      ]
      const oscs = [
        this.squishSubOsc,
        this.squishLfo,
        this.squishPitchLfo,
        this.squishPumpLfo
      ]
      setTimeout(() => {
        try {
          src.stop()
        } catch {
          /* already stopped */
        }
        src.disconnect()
        for (const o of oscs) {
          try {
            o?.stop()
          } catch {
            /* already stopped */
          }
          o?.disconnect()
        }
        for (const n of nodes) n?.disconnect()
      }, 150)
      this.squishSource = null
      this.squishGain = null
      this.squishFilter = null
      this.squishOut = null
      this.squishSubOsc = null
      this.squishSubGain = null
      this.squishLfo = null
      this.squishLfoDepth = null
      this.squishPitchLfo = null
      this.squishPitchDepth = null
      this.squishPumpLfo = null
      this.squishPumpDepth = null
    }
  }

  /**
   * Play a brief brittle crack. Layered as filtered white noise (the actual
   * fracture) plus a short bandpass burst around 3.5 kHz (the "tick").
   */
  playCrack(intensity: number = 1) {
    if (!this.enabled) return
    const ctx = this.ensureCtx()
    if (!ctx || !this.noiseBuffer || !this.masterGain) return
    const now = ctx.currentTime
    if (now - this.lastCrackTime < 0.08) return
    this.lastCrackTime = now
    const amp = Math.max(0.1, Math.min(1, intensity))

    const src = ctx.createBufferSource()
    src.buffer = this.noiseBuffer
    src.playbackRate.value = 1.4 + Math.random() * 0.4

    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = 2400 + Math.random() * 1600
    bp.Q.value = 3.5

    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(amp * 0.55, now + 0.004)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09)

    src.connect(bp)
    bp.connect(gain)
    gain.connect(this.masterGain)
    src.start(now)
    src.stop(now + 0.11)
    src.onended = () => {
      src.disconnect()
      bp.disconnect()
      gain.disconnect()
    }
  }

  dispose() {
    this.stopSquish()
    if (this.ctx) {
      this.ctx.close().catch(() => {})
      this.ctx = null
      this.masterGain = null
      this.noiseBuffer = null
    }
  }
}
