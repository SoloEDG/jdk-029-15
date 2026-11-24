import type { AudioPart, PitchPoint, TimeRange } from '../../../shared/document'

export interface TakeAudio {
  /** Zero-based pass over the recorded line. */
  pass: number
  /** Groups the passes recorded while the microphone stayed open. */
  sessionId: string
  start: number
  end: number
  /** Sample rate of `parts`. */
  rate: number
  /** Absolute song time of the first confirmed voiced sample. */
  onset: number
  /** True when the pass sounded all the way to the end of the line. */
  complete: boolean
  parts: AudioPart[]
  pitch: PitchPoint[]
}

export interface LivePoint {
  pass: number
  point: PitchPoint
}

export type PitchSampler = (time: number, samples: Float32Array, rate: number) => PitchPoint

interface Segment {
  pass: number
  /** Audio-clock time at which this pass became audible. */
  startClock: number
  /** Audio-clock time at which the accompaniment left this pass. */
  endClock: number | null
  /** Song time that matches startClock. */
  songStart: number
}

interface PassWork {
  pass: number
  parts: AudioPart[]
  pitch: PitchPoint[]
  onset: number | null
  lastSong: number
  /** Clock at which the pass ended, or null while it is still audible. */
  sealed: number | null
  complete: boolean
  /** Song time to report for a pass stopped before the line end. */
  end: number
}

/** Audio that ran past the line end and is not classified yet. */
interface Pending {
  clock: number
  samples: Float32Array
}

const EPSILON = 1e-4
const ONSET_WINDOW = 0.02
const ONSET_STEP = 0.005
const ONSET_RMS = 0.01

/**
 * Return the sample offset of the first voiced sound. This runs on raw PCM
 * rather than on the pitch estimate: a pass must be kept when a voice onset
 * was received even if the note was too short for the pitch detector. A short
 * window above the threshold is required so that a quiet, silent tail does
 * not turn into a take of its own.
 */
export function firstVoicedSample(samples: Float32Array, rate: number) {
  if (!samples.length) return null
  const window = Math.max(1, Math.round(ONSET_WINDOW * rate))
  const step = Math.max(1, Math.round(ONSET_STEP * rate))
  for (let start = 0; start < samples.length; start += step) {
    const count = Math.min(window, samples.length - start)
    let energy = 0
    for (let index = 0; index < count; index++) {
      const value = samples[start + index]
      energy += value * value
    }
    if (Math.sqrt(energy / count) < ONSET_RMS) continue
    if (count < window) return start
    // Windows overlap, so the first loud window can start before the attack.
    for (let index = start; index < start + count; index++) {
      if (Math.abs(samples[index]) >= ONSET_RMS) return index
    }
    return start
  }
  return null
}

/**
 * Places microphone frames on the song timeline, pass by pass.
 *
 * Frames are classified by their audio-clock timestamp rather than by
 * whichever pass happens to be current when the message is handled. Audio
 * that maps past the line end while the jump back has not been observed yet
 * is held back: once the jump clock arrives it is either discarded (it
 * sounded past the boundary during a stall and belongs to no pass) or placed
 * at the start of the next pass. A delayed notification therefore neither
 * loses nor misplaces samples, and the next pass still shows its real
 * silence from the line start.
 */
export function createTimeline(range: TimeRange, sessionId: string) {
  const segments: Segment[] = []
  const passes = new Map<number, PassWork>()
  const emitted = new Set<number>()
  let pending: Pending[] = []
  let rate = 48000
  let open = false
  let closed: number | null = null
  /** Every frame handled so far ended at or before this clock. */
  let watermark = 0
  let sampler: PitchSampler = (time: number) => ({ time, midi: null })

  function work(pass: number, songStart: number) {
    let entry = passes.get(pass)
    if (!entry) {
      entry = {
        pass, parts: [], pitch: [], onset: null,
        lastSong: songStart, sealed: null, complete: false, end: songStart,
      }
      passes.set(pass, entry)
    }
    return entry
  }

  function begin(clock: number, song: number, sampleRate: number) {
    open = true
    rate = sampleRate
    closed = null
    watermark = clock
    pending = []
    segments.length = 0
    passes.clear()
    emitted.clear()
    segments.push({ pass: 0, startClock: clock, endClock: null, songStart: song })
    work(0, song)
  }

  function place(pass: number, songStart: number, offset: number, samples: Float32Array) {
    if (!samples.length) return null
    let first = 0
    let from = songStart + offset
    if (from < range.start - EPSILON) {
      first = Math.min(samples.length, Math.round((range.start - from) * rate))
      from += first / rate
      if (first >= samples.length) return null
    }
    if (from >= range.end - EPSILON) return null
    let count = samples.length - first
    if (from + count / rate > range.end) count = Math.max(0, Math.round((range.end - from) * rate))
    if (count <= 0) return null
    const clipped = samples.subarray(first, first + count)
    const entry = work(pass, songStart)
    entry.parts.push({ songTime: from, samples: clipped })
    entry.lastSong = Math.max(entry.lastSong, from + clipped.length / rate)
    if (entry.onset === null) {
      const voiced = firstVoicedSample(clipped, rate)
      if (voiced !== null) entry.onset = from + voiced / rate
    } else {
      // Frames may be handled out of order (late delivery); the onset is the
      // earliest voiced moment of the pass, not the first one noticed.
      const voiced = firstVoicedSample(clipped, rate)
      if (voiced !== null) entry.onset = Math.min(entry.onset, from + voiced / rate)
    }
    const point = sampler(from + clipped.length / (2 * rate), clipped, rate)
    entry.pitch.push(point)
    return point
  }

  /** The clock at which an audible pass would reach the end of the line. */
  function boundaryClock(segment: Segment) {
    return segment.startClock + (range.end - segment.songStart)
  }

  function trim(part: AudioPart, stop: number) {
    const room = Math.round((stop - part.songTime) * rate)
    if (room <= 0) return null
    if (part.samples.length <= room) return part
    return { songTime: part.songTime, samples: part.samples.subarray(0, room) }
  }

  function take(entry: PassWork): TakeAudio | null {
    const start = range.start
    // The end may have been frozen when the stop arrived, before the last
    // frames were flushed in. A voiced onset the microphone had already
    // confirmed must still be covered by the take.
    const lastSong = entry.parts.reduce(
      (far, part) => Math.max(far, part.songTime + part.samples.length / rate), entry.lastSong,
    )
    const stop = entry.complete
      ? range.end
      : Math.max(start, Math.min(range.end, Math.max(entry.end, lastSong, entry.onset ?? start)))
    if (entry.onset === null || entry.onset >= stop - EPSILON) return null
    const parts = entry.parts
      .map(part => part.songTime < stop - EPSILON ? trim(part, stop) : null)
      .filter((part): part is AudioPart => part !== null)
    if (!parts.length) return null
    return {
      pass: entry.pass,
      sessionId,
      start,
      end: stop,
      rate,
      onset: entry.onset,
      complete: entry.complete,
      parts,
      pitch: entry.pitch
        .filter(point => point.time >= start && point.time < stop)
        .sort((a, b) => a.time - b.time),
    }
  }

  /**
   * Archive every pass whose audio has been fully delivered. A pass is safe
   * once a handled frame has reached its end clock: the worklet port is
   * ordered, so no earlier sample can still be waiting. The pass that is
   * still audible, and the pass closed by a stop, wait for the flush.
   */
  function settle(force: boolean) {
    const takes: TakeAudio[] = []
    const ordered = [...passes.values()].sort((a, b) => a.pass - b.pass)
    for (const entry of ordered) {
      if (emitted.has(entry.pass)) continue
      if (entry.sealed === null) break
      if (!force) {
        if (!entry.complete) break
        if (watermark < entry.sealed) break
      }
      const result = take(entry)
      emitted.add(entry.pass)
      if (result) takes.push(result)
    }
    return takes
  }

  /**
   * The accompaniment jumped back at `clock`. Audio held while the
   * notification was late is split at that clock: before it, it sounded past
   * the line end and belongs to no pass; from it on, it belongs to the next
   * pass.
   */
  function jump(clock: number): TakeAudio[] {
    if (!open || closed !== null) return []
    const active = segments.find(segment => segment.endClock === null)
    if (!active) return []
    const at = Math.max(active.startClock, clock)
    // The jump back means the pass did sound through to the boundary, even
    // if the browser only noticed afterwards.
    active.endClock = at
    const finished = work(active.pass, active.songStart)
    finished.complete = true
    finished.sealed = at
    const next = active.pass + 1
    segments.push({ pass: next, startClock: at, endClock: null, songStart: range.start })
    work(next, range.start)
    const held = pending
    pending = []
    for (const entry of held) {
      const end = entry.clock + entry.samples.length / rate
      if (end <= at) continue
      const skip = Math.max(0, Math.min(entry.samples.length, Math.round((at - entry.clock) * rate)))
      if (skip >= entry.samples.length) continue
      // Audio after the jump maps to the start of the line plus the time
      // elapsed since the jump, so the next pass keeps its real silence.
      const start = Math.max(at, entry.clock)
      place(next, range.start, start - at, entry.samples.subarray(skip))
    }
    return settle(false)
  }

  function receive(inputTime: number, samples: Float32Array, sampleRate: number, onPitch: PitchSampler) {
    if (!open || !samples.length) return { takes: [] as TakeAudio[], points: [] as LivePoint[] }
    sampler = onPitch
    rate = sampleRate
    const frameEnd = inputTime + samples.length / rate
    watermark = Math.max(watermark, frameEnd)
    const limit = Math.min(frameEnd, closed ?? Infinity)
    const points: LivePoint[] = []
    for (const segment of segments) {
      const from = Math.max(inputTime, segment.startClock)
      if (from >= limit) continue
      const end = Math.min(segment.endClock ?? Infinity, limit)
      if (end <= from) continue
      // Split at the line end while the jump back has not been observed, so
      // samples past the boundary can be held instead of discarded. They are
      // held after the stop too: if the jump turns out to have happened
      // before them they are dropped, otherwise they belong to the next pass.
      const edge = segment.endClock === null ? Math.min(end, boundaryClock(segment)) : end
      const first = Math.max(0, Math.min(samples.length, Math.round((from - inputTime) * rate)))
      if (edge > from) {
        const last = Math.max(first, Math.min(samples.length, Math.round((edge - inputTime) * rate)))
        if (last > first) {
          const point = place(segment.pass, segment.songStart, from - segment.startClock, samples.subarray(first, last))
          if (point) points.push({ pass: segment.pass, point })
        }
      }
      const heldFrom = Math.max(from, edge)
      if (closed === null && heldFrom < end) {
        const skip = Math.max(0, Math.min(samples.length, Math.round((heldFrom - inputTime) * rate)))
        const last = Math.max(skip, Math.min(samples.length, Math.round((end - inputTime) * rate)))
        if (last > skip) pending.push({ clock: heldFrom, samples: samples.slice(skip, last) })
      }
    }
    return { takes: settle(false), points }
  }

  /**
   * Stop accepting audio at `clock`; no sample captured after it is kept.
   * The pass that was audible stays incomplete unless playback had reached
   * the end of the line.
   */
  function close(clock: number, song: number) {
    if (closed !== null) return
    closed = clock
    const active = segments.find(segment => segment.endClock === null)
    if (!active) return
    const at = Math.max(active.startClock, clock)
    active.endClock = at
    const entry = work(active.pass, active.songStart)
    entry.complete = song >= range.end - EPSILON
    entry.sealed = at
    entry.end = entry.complete
      ? range.end
      : Math.min(range.end, Math.max(entry.lastSong, entry.onset ?? active.songStart, song))
  }

  /**
   * Finish the session. Frames flushed after `close` may still be delivered
   * through `receive`; samples captured after the stop clock are dropped, and
   * a confirmed voiced onset from just before it is kept.
   */
  function finish() {
    if (!open) return [] as TakeAudio[]
    open = false
    const last = segments[segments.length - 1]
    if (last && last.endClock === null) {
      // No jump back was observed, so the audible pass cannot be proven to
      // have reached the boundary. Audio held past the line end is dropped:
      // without an observed jump it belongs to no pass.
      last.endClock = Math.max(last.startClock, watermark)
      const entry = work(last.pass, last.songStart)
      entry.complete = false
      entry.sealed = last.endClock
      entry.end = Math.max(entry.end, Math.min(range.end, range.start + (last.endClock - last.startClock)))
    }
    pending = []
    return settle(true)
  }

  return { begin, jump, receive, close, finish, sessionId }
}

export type CaptureTimeline = ReturnType<typeof createTimeline>
