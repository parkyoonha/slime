/**
 * Sample-based slime squish playback + procedural crack synthesis. The
 * squish scheduler stays silent until `loadSquishSamples` resolves, then
 * fires random windows of the loaded recordings each squelch tick. Only
 * the crack (wax coating) is still synthesised from white noise — the
 * slime squish is entirely sample-driven.
 *
 * iOS/Safari require a user gesture before an AudioContext will produce sound;
 * call `resume()` from the first pointerdown/touchstart handler.
 */
export class SoundEngine {
  private ctx: AudioContext | null = null
  private masterGain: GainNode | null = null
  private noiseBuffer: AudioBuffer | null = null

  private squishSquelchTimer: ReturnType<typeof setTimeout> | null = null
  private squishTargetLevel = 0

  /** Per-slot scheduler state — mirrors the squish scheduler pattern for
   *  named-sample slots (wax / foil / beads). Each slot has:
   *    - target level (0..1, updated by `setNamedLevel`)
   *    - active setTimeout that keeps firing plays while target > 0.02
   *  When target drops below the threshold, `clearTimeout` cancels the
   *  timer immediately (unlike a per-frame rate limiter, which would
   *  keep re-triggering as long as the caller reports elevated pressure). */
  private namedTimers: Record<string, ReturnType<typeof setTimeout> | null> = {
    wax: null,
    thinwax: null,
    foil: null,
    beads: null,
    paper: null,
    powder: null,
    matte: null,
    metal: null,
    emoji: null,
    slimeTap: null
  }
  private namedTargetLevels: Record<string, number> = {
    wax: 0,
    thinwax: 0,
    foil: 0,
    beads: 0,
    paper: 0,
    powder: 0,
    matte: 0,
    metal: 0,
    emoji: 0,
    slimeTap: 0
  }
  /** Per-slot GAIN multiplier for looping samples. Multiplies the
   *  intensity passed to `setLoopingSampleLevel` before feeding the
   *  gain node, so a quiet source recording can be boosted per-channel
   *  without affecting other channels or the master gain. Values >1
   *  raise the ceiling above the intensity clamp; the gain node itself
   *  has no upper bound. Missing entries default to 1.0. */
  private loopGainMultipliers: Record<string, number> = {}
  /** Per-slot LOOPING sources for continuous ambient sounds (beads,
   *  paper). Unlike the setNamedLevel scheduler which fires discrete
   *  short pops, `setLoopingSampleLevel` keeps a single AudioBufferSourceNode
   *  playing while the level is above threshold, so a continuous
   *  recording ("치이이이익") plays as one uninterrupted stream instead
   *  of chopped windows separated by silence. Gain follows intensity. */
  private loopSources: Record<
    string,
    { src: AudioBufferSourceNode; gain: GainNode } | null
  > = {
    wax: null,
    thinwax: null,
    foil: null,
    beads: null,
    paper: null,
    powder: null,
    matte: null,
    metal: null,
    emoji: null,
    slimeTap: null
  }

  /** Slime squish sample pool. `setSquishLevel` is a no-op until at least
   *  one entry is loaded here — no fallback synthesis. Load is triggered
   *  from the first user gesture and silently skips missing files. */
  private squishSamples: AudioBuffer[] = []
  private squishSamplesLoadStarted = false

  private lastCrackTime = 0

  /** Named single-sample slots for coating-specific crack sounds + the
   *  beads ambient sound. Each slot holds one decoded AudioBuffer and its
   *  own last-play timestamp so we can rate-limit playback per slot
   *  independently of the global playCrack limiter. */
  private namedSamples: Record<string, AudioBuffer | null> = {
    wax: null,
    thinwax: null,
    foil: null,
    beads: null,
    paper: null,
    powder: null,
    matte: null,
    metal: null,
    emoji: null,
    slimeTap: null
  }
  /** Optional per-slot [startSec, endSec] source-range constraint. When
   *  set, random window offsets are clamped to this range so only the
   *  desired portion of the recording is ever played. `null` means the
   *  full file is available. Set via `setNamedSampleRange`. */
  private namedSourceRanges: Record<
    string,
    readonly [number, number] | null
  > = {
    wax: null,
    thinwax: null,
    foil: null,
    beads: null,
    paper: null,
    powder: null,
    matte: null,
    metal: null,
    emoji: null,
    slimeTap: null
  }

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
    if (!on) {
      this.stopSquish()
      for (const name of Object.keys(this.namedTimers)) {
        const timer = this.namedTimers[name]
        if (timer !== null) {
          clearTimeout(timer)
          this.namedTimers[name] = null
        }
        this.namedTargetLevels[name] = 0
      }
      for (const name of Object.keys(this.loopSources)) {
        const active = this.loopSources[name]
        if (active) {
          try {
            active.src.stop()
          } catch {
            // already stopped
          }
          active.src.disconnect()
          active.gain.disconnect()
          this.loopSources[name] = null
        }
      }
    }
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
    // "peel apart" moment. `playSquelch` no-ops when samples aren't loaded
    // yet, so the scheduler is silent until `loadSquishSamples` finishes.
    if (this.squishSquelchTimer === null) {
      const scheduleSquelch = () => {
        if (this.squishTargetLevel < 0.02) {
          this.squishSquelchTimer = null
          return
        }
        this.playSquelch(this.squishTargetLevel)
        const base = 110 + Math.random() * 220
        const scale = 1.4 - this.squishTargetLevel
        this.squishSquelchTimer = setTimeout(scheduleSquelch, base * scale)
      }
      scheduleSquelch()
    }
  }

  /** Play a single random sample from the loaded pool. Silent no-op until
   *  `loadSquishSamples` finishes — no synthesised fallback, so the first
   *  presses after a hard refresh stay quiet rather than dropping in the
   *  procedural drone/pop that used to leak through. */
  private playSquelch(intensity: number) {
    const ctx = this.ctx
    if (!ctx || !this.masterGain) return
    if (this.squishSamples.length === 0) return
    const amp = Math.max(0.15, Math.min(1, intensity))

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
  }

  /** Cancel the sample scheduler. Each in-flight sample voice fades itself
   *  out via its own gain envelope, so there's nothing else to tear down. */
  stopSquish() {
    this.squishTargetLevel = 0
    if (this.squishSquelchTimer !== null) {
      clearTimeout(this.squishSquelchTimer)
      this.squishSquelchTimer = null
    }
  }

  /**
   * Drive a named-sample slot as a CONTINUOUS looping ambient sound
   * (vs setNamedLevel's discrete short-pop scheduler). Above the 0.02
   * level threshold, a single AudioBufferSourceNode loops the sample
   * (or the configured source-range) with gain following `intensity`,
   * so a recording like "치이이이익" plays as one uninterrupted stream.
   * Below the threshold, the source fades out and stops. Use for
   * beads / sprinkle sounds; keep setNamedLevel for crack pops.
   */
  setLoopingSampleLevel(
    name: string,
    intensity: number,
    fadeTime = 0.008,
    /**
     * Optional buffer offset (seconds) to seek to when STARTING a new
     * voice. When omitted, defaults to `loopStart` (i.e. skip any
     * pre-loop "attack" region in the file). Set to 0 to play the
     * whole file from the top — the section BEFORE loopStart plays
     * ONCE as an attack, then the buffer natural-loops between
     * loopStart and loopEnd for as long as gain > threshold. Ignored
     * when the voice for `name` is already active (gain is just
     * updated in place on subsequent calls).
     */
    startOffsetOverride?: number
  ) {
    if (!this.enabled) return
    const ctx = this.ensureCtx()
    if (!ctx || !this.masterGain) return
    const buf = this.namedSamples[name]
    if (!buf) return

    const level = Math.max(0, Math.min(1, intensity))
    const gainMult = this.loopGainMultipliers[name] ?? 1
    const effectiveLevel = level * gainMult
    const active = this.loopSources[name] ?? null
    const now = ctx.currentTime

    if (level < 0.02) {
      if (active) {
        active.gain.gain.cancelScheduledValues(now)
        active.gain.gain.setValueAtTime(active.gain.gain.value, now)
        active.gain.gain.linearRampToValueAtTime(
          0.0001,
          now + fadeTime
        )
        const stopAt = now + fadeTime + 0.02
        try {
          active.src.stop(stopAt)
        } catch {
          // already stopped
        }
        const oldSrc = active.src
        const oldGain = active.gain
        oldSrc.onended = () => {
          oldSrc.disconnect()
          oldGain.disconnect()
        }
        this.loopSources[name] = null
      }
      return
    }

    // An explicit startOffsetOverride means the caller wants playback
    // to *begin* at that offset — if a voice is already active the
    // offset is meaningless (playback continues from its current
    // position), so tear the active voice down and fall through to
    // the "create fresh" branch. Ensures a reset-armed wax attack
    // always plays even when the previous press's voice was still
    // alive or fading out. Tear-down is near-instant (0-gain in 2 ms,
    // stop in 5 ms) so the old sustain can't overlap the fresh
    // attack transient long enough to mask it.
    if (active && startOffsetOverride !== undefined) {
      const oldSrc = active.src
      const oldGain = active.gain
      oldGain.gain.cancelScheduledValues(now)
      oldGain.gain.setValueAtTime(0, now)
      try {
        oldSrc.stop(now + 0.005)
      } catch {
        // already stopped
      }
      oldSrc.onended = () => {
        oldSrc.disconnect()
        oldGain.disconnect()
      }
      this.loopSources[name] = null
    }

    const stillActive = this.loopSources[name]
    if (!stillActive) {
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.loop = true
      const range = this.namedSourceRanges[name]
      const loopStartSec = range
        ? Math.max(0, Math.min(buf.duration, range[0]))
        : 0
      if (range) {
        src.loopStart = loopStartSec
        src.loopEnd = Math.max(
          loopStartSec,
          Math.min(buf.duration, range[1])
        )
      }
      // Where the voice actually begins reading the buffer. Defaults
      // to loopStart (jump straight into the sustain region) unless
      // the caller wants the pre-loop attack region played first.
      const startSec =
        startOffsetOverride !== undefined
          ? Math.max(0, Math.min(buf.duration, startOffsetOverride))
          : loopStartSec
      const gain = ctx.createGain()
      gain.gain.setValueAtTime(0.0001, now)
      gain.gain.linearRampToValueAtTime(effectiveLevel, now + fadeTime)
      src.connect(gain)
      gain.connect(this.masterGain)
      src.start(now, startSec)
      this.loopSources[name] = { src, gain }
    } else {
      stillActive.gain.gain.cancelScheduledValues(now)
      stillActive.gain.gain.setValueAtTime(stillActive.gain.gain.value, now)
      stillActive.gain.gain.linearRampToValueAtTime(
        effectiveLevel,
        now + fadeTime
      )
    }
  }

  /** Set a per-channel gain multiplier for `setLoopingSampleLevel`.
   *  Use this to boost a quiet source recording without affecting the
   *  intensity input (which stays 0..1 driven by press pressure) or
   *  other channels. Default is 1.0 for any channel not set. */
  setLoopingSampleGain(name: string, gain: number) {
    this.loopGainMultipliers[name] = Math.max(0, gain)
  }

  /**
   * Restrict which portion of a named sample's recording is used as the
   * source for random windows. Pass [startSec, endSec] to clamp all
   * future `setNamedLevel` playback to that region, or `null` to allow
   * the whole file again. Useful when a single mp3 contains several
   * distinct sounds and only one segment is wanted for that slot.
   */
  setNamedSampleRange(
    name: string,
    range: readonly [number, number] | null
  ) {
    this.namedSourceRanges[name] = range
  }

  /**
   * Drive a named-sample slot exactly like `setSquishLevel` drives the
   * squish scheduler. `intensity` in [0, 1] — below 0.02, the scheduler
   * for this slot is cancelled and further calls do nothing until the
   * level rises again; above 0.02, a setTimeout scheduler fires
   * `playNamedSample` at intensity-scaled intervals. Call every frame
   * with the current pressure signal; the scheduler handles pacing and
   * decisive stop-on-release.
   */
  setNamedLevel(
    name: string,
    intensity: number,
    winRange: readonly [number, number] = [0.09, 0.18],
    intervalBase = 180,
    intervalJitter = 220
  ) {
    if (!this.enabled) return
    const ctx = this.ensureCtx()
    if (!ctx || !this.masterGain) return
    const target = Math.max(0, Math.min(1, intensity))
    this.namedTargetLevels[name] = target

    if (target < 0.02) {
      const timer = this.namedTimers[name]
      if (timer !== null) {
        clearTimeout(timer)
        this.namedTimers[name] = null
      }
      return
    }

    if (this.namedTimers[name] === null) {
      const schedule = () => {
        const level = this.namedTargetLevels[name] ?? 0
        if (level < 0.02) {
          this.namedTimers[name] = null
          return
        }
        this.playNamedSampleOnce(name, level, winRange)
        // Higher intensity → shorter gap between pops (more frequent).
        const gap = (intervalBase + Math.random() * intervalJitter) * (1.4 - level)
        this.namedTimers[name] = setTimeout(schedule, gap)
      }
      schedule()
    }
  }

  /**
   * Load a single named sample. Silently no-ops on fetch/decode failure so
   * missing files just mute their slot without breaking anything else.
   */
  async loadNamedSample(name: string, url: string) {
    const ctx = this.ensureCtx()
    if (!ctx) return
    try {
      const res = await fetch(url)
      if (!res.ok) return
      const ct = res.headers.get('content-type') || ''
      if (!ct.startsWith('audio/')) return
      const buf = await res.arrayBuffer()
      const decoded = await ctx.decodeAudioData(buf)
      this.namedSamples[name] = decoded
    } catch {
      // silent fail — leave slot null
    }
  }

  /**
   * Internal: play one short random-window pop of a named sample. Called
   * exclusively by the setNamedLevel scheduler; rate limiting / gating is
   * the scheduler's job, so this method just does the audio work.
   */
  private playNamedSampleOnce(
    name: string,
    intensity: number,
    winRange: readonly [number, number]
  ) {
    const ctx = this.ctx
    if (!ctx || !this.masterGain) return
    const buf = this.namedSamples[name]
    if (!buf) return
    const now = ctx.currentTime

    const amp = Math.max(0.1, Math.min(1, intensity))
    const src = ctx.createBufferSource()
    src.buffer = buf
    // Small per-shot pitch variation so repeated triggers don't sound like
    // a stuck loop of the same file.
    const rate = 0.92 + Math.random() * 0.16
    src.playbackRate.value = rate

    // Determine the source region: full file, or a caller-specified
    // sub-range set via setNamedSampleRange (used to pick a specific
    // sound out of a longer recording).
    const sourceRange = this.namedSourceRanges[name]
    const srcStart = sourceRange
      ? Math.max(0, Math.min(buf.duration, sourceRange[0]))
      : 0
    const srcEnd = sourceRange
      ? Math.max(srcStart, Math.min(buf.duration, sourceRange[1]))
      : buf.duration
    const srcSpan = Math.max(0, srcEnd - srcStart)

    // Chop long regions into short random windows from a random offset
    // within [srcStart, srcEnd]; short regions play end-to-end.
    const isLong = srcSpan > winRange[1] + 0.05
    const winSec = isLong
      ? winRange[0] + Math.random() * (winRange[1] - winRange[0])
      : srcSpan
    const offsetSec = isLong
      ? srcStart + Math.random() * Math.max(0, srcSpan - winSec - 0.02)
      : srcStart

    // Fade envelope so window boundaries don't click.
    const peak = 0.35 + amp * 0.75
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(peak, now + 0.006)
    const playSec = winSec / rate
    gain.gain.setValueAtTime(peak, now + playSec - 0.015)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + playSec)

    src.connect(gain)
    gain.connect(this.masterGain)
    src.start(now, offsetSec)
    src.stop(now + playSec + 0.02)
    src.onended = () => {
      src.disconnect()
      gain.disconnect()
    }
  }

  /**
   * Fire-and-forget one-shot playback of a named sample. Plays from
   * the configured range start (or 0 if no range) to the end of the
   * buffer, without looping. Cheap: one voice, constant gain, no
   * tracking. Use when a coating channel needs to fire exactly once
   * (e.g. thinwax during auto-press mode) alongside the normal loop
   * channel being muted.
   */
  playNamedSampleFull(name: string, intensity: number = 1) {
    if (!this.enabled) return
    const ctx = this.ensureCtx()
    if (!ctx || !this.masterGain) return
    const buf = this.namedSamples[name]
    if (!buf) return

    const range = this.namedSourceRanges[name]
    const startSec = range
      ? Math.max(0, Math.min(buf.duration, range[0]))
      : 0

    const src = ctx.createBufferSource()
    src.buffer = buf
    // Explicit false — we want a natural end, not a loop.
    src.loop = false

    const gain = ctx.createGain()
    gain.gain.value = Math.max(0.1, Math.min(1.5, intensity))

    src.connect(gain)
    gain.connect(this.masterGain)
    src.start(ctx.currentTime, startSec)
    src.onended = () => {
      src.disconnect()
      gain.disconnect()
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
    for (const name of Object.keys(this.namedTimers)) {
      const timer = this.namedTimers[name]
      if (timer !== null) {
        clearTimeout(timer)
        this.namedTimers[name] = null
      }
      this.namedTargetLevels[name] = 0
    }
    for (const name of Object.keys(this.loopSources)) {
      const active = this.loopSources[name]
      if (active) {
        try {
          active.src.stop()
        } catch {
          // already stopped
        }
        active.src.disconnect()
        active.gain.disconnect()
        this.loopSources[name] = null
      }
    }
    if (this.ctx) {
      this.ctx.close().catch(() => {})
      this.ctx = null
      this.masterGain = null
      this.noiseBuffer = null
    }
  }
}
