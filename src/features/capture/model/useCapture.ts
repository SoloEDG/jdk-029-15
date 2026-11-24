import { onBeforeUnmount, ref, shallowRef } from 'vue'
import type { PitchPoint, PcmFrame, TimeRange } from '../../../shared/document'
import { openInput } from '../lib/input'
import { createTimeline, type CaptureTimeline, type TakeAudio } from '../lib/timeline'

interface CaptureTarget {
  songId: string
  lineId: string
  range: TimeRange
}

interface CaptureEvents {
  /** Places and analyses one piece of received audio. */
  onPitch: (time: number, samples: Float32Array, rate: number) => PitchPoint
  /** The pieces of a received frame, in the order they sounded. */
  onLive: (points: { pass: number; point: PitchPoint }[]) => void
  /** A new pass started; the live view should start from a blank trace. */
  onPass: () => void
  onComplete: (result: TakeAudio & { songId: string; lineId: string; sessionId: string }) => Promise<void>
  position: () => number
}

type Input = Awaited<ReturnType<typeof openInput>>
type Session = CaptureTarget & { stream: Input; timeline: CaptureTimeline; saved: number; sessionId: string }

export function useCapture(events: CaptureEvents) {
  const status = ref<'idle' | 'requesting' | 'recording' | 'saving'>('idle')
  const issue = ref('')
  const level = ref(0)
  /** Zero-based pass currently being recorded, for the live view. */
  const pass = ref(0)
  const stream = shallowRef<Input | null>(null)
  let session: Session | null = null
  let request = 0
  let stopping: Promise<void> | null = null

  function receive(frame: PcmFrame) {
    if (!session) return
    const timeline = session.timeline
    const result = timeline.receive(frame.inputTime, frame.samples, session.stream.sampleRate, events.onPitch)
    for (const take of result.takes) void archive(session, take)
    if (status.value !== 'recording') return
    const rms = Math.sqrt(frame.samples.reduce((sum, value) => sum + value * value, 0) / frame.samples.length)
    level.value = Math.min(1, rms * 4)
    if (result.points.length) {
      // A frame can straddle the jump; the live view shows only the newest
      // pass so the previous pass's trace does not bleed into this one.
      const newest = result.points[result.points.length - 1].pass
      pass.value = newest
      events.onLive(result.points.filter(entry => entry.pass === newest))
    }
  }

  async function archive(target: Session, take: TakeAudio) {
    target.saved++
    try {
      await events.onComplete({
        ...take, songId: target.songId, lineId: target.lineId, sessionId: target.sessionId,
      })
    } catch {
      target.saved--
      issue.value = '录音未能保存。'
    }
  }

  /**
   * The transport jumped back to the start of the line. Read the audio clock
   * at once: because frames carry their own timestamps, even a notification
   * delayed until after the jump still splits the audio at the right place.
   * Audio that was held past the line end is resolved by this call.
   */
  function loop() {
    if (!session) return
    for (const take of session.timeline.jump(session.stream.clock())) void archive(session, take)
    // The live pitch view belongs to one pass only; start the new pass clean.
    pass.value++
    events.onPass()
  }

  async function start(target: CaptureTarget, preparePlayback: () => Promise<boolean>) {
    if (status.value !== 'idle') return
    const token = ++request
    status.value = 'requesting'
    issue.value = ''
    pass.value = 0
    try {
      const opened = await openInput(receive, lost)
      if (token !== request) { opened.close(); return }
      if (!await preparePlayback() || token !== request) { opened.close(); return }
      const timeline = createTimeline(target.range, crypto.randomUUID())
      timeline.begin(opened.clock(), events.position(), opened.sampleRate)
      stream.value = opened
      session = { ...target, stream: opened, timeline, saved: 0, sessionId: timeline.sessionId }
      status.value = 'recording'
    } catch (error) {
      if (token !== request) return
      cancelRequest()
      issue.value = error instanceof DOMException && error.name === 'NotAllowedError'
        ? '麦克风权限未开启。' : '无法开启麦克风，请检查设备和访问权限。'
    }
  }

  function cancelRequest() {
    if (status.value !== 'requesting') return
    request++
    stream.value?.close()
    stream.value = null
    status.value = 'idle'
  }

  function stop(position: number) {
    if (status.value !== 'recording' || !session) return stopping ?? Promise.resolve()
    status.value = 'saving'
    const recording = session
    // Capture ends now: audio captured after the stop is not credited to the
    // silent tail. Frames still in flight are flushed and kept only if they
    // were captured before this clock, so a confirmed onset is never lost.
    recording.timeline.close(recording.stream.clock(), position)
    stopping = (async () => {
      try {
        await recording.stream.flush()
        for (const take of recording.timeline.finish()) await archive(recording, take)
        if (!recording.saved) issue.value = '这一遍没有收到人声，未生成录音。'
      } catch {
        issue.value = '录音未能保存。'
      } finally {
        if (session === recording) session = null
        recording.stream.close()
        if (stream.value === recording.stream) stream.value = null
        level.value = 0
        status.value = 'idle'
        stopping = null
      }
    })()
    return stopping
  }

  /** The microphone track ended; keep whatever was already confirmed. */
  function lost() {
    issue.value = '麦克风已断开。'
    if (status.value === 'requesting') cancelRequest()
    else if (status.value === 'recording' && session) void stop(events.position())
  }

  onBeforeUnmount(() => {
    request++
    session = null
    stream.value?.close()
    stream.value = null
  })
  return { status, issue, level, pass, start, stop, loop, cancelRequest }
}
