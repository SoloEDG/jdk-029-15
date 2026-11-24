import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTimeline, firstVoicedSample } from '../src/features/capture/lib/timeline.ts'
import { toWave } from '../src/features/capture/lib/wave.ts'

const RATE = 8000
const LINE = { start: 10, end: 12 }
const SIZE = 256

const sampler = (time: number) => ({ time, midi: 60 })

/**
 * One continuous microphone signal, sampled on the audio clock. `voice` says
 * whether the singer is audible at a clock time; `jump` is when the
 * accompaniment actually returned to the line start after a loop.
 */
function microphone(voice: (clock: number) => boolean) {
  return (start: number, length: number) => {
    const samples = new Float32Array(length)
    for (let index = 0; index < length; index++) {
      const clock = start + index / RATE
      samples[index] = voice(clock) ? 0.3 * Math.sin(2 * Math.PI * 220 * clock) : 0
    }
    return samples
  }
}

type TimelineTake = ReturnType<ReturnType<typeof createTimeline>['finish']>[number]

function harness(voice: (clock: number) => boolean) {
  const timeline = createTimeline(LINE, 'session')
  timeline.begin(0, LINE.start, RATE)
  const signal = microphone(voice)
  const takes: TimelineTake[] = []

  function deliver(from: number, to: number) {
    for (let start = from; start < to - 1e-9; start += SIZE / RATE) {
      const length = Math.min(SIZE, Math.round((to - start) * RATE))
      if (length <= 0) break
      takes.push(...timeline.receive(start, signal(start, length), RATE, sampler).takes)
    }
  }

  return {
    timeline,
    takes,
    deliver,
    jump(clock: number) {
      takes.push(...timeline.jump(clock))
      return takes
    },
    close(clock: number, position: number) { timeline.close(clock, position) },
    finish() {
      takes.push(...timeline.finish())
      return takes
    },
  }
}

function totalSeconds(take: TimelineTake) {
  return take.parts.reduce((sum, part) => sum + part.samples.length, 0) / take.rate
}

function assertInside(take: TimelineTake) {
  for (const part of take.parts) {
    assert.ok(part.songTime >= LINE.start - 1e-6, `part starts at ${part.songTime}`)
    assert.ok(part.songTime + part.samples.length / take.rate <= LINE.end + 1e-6, 'part ends inside the line')
  }
}

test('each loop pass is archived with its own tail', () => {
  const run = harness(clock =>
    (clock >= 0.5 && clock < 2.0) || (clock >= 2.3 && clock < 2.45),
  )
  run.deliver(0, 2.0)
  run.jump(2.0)
  run.deliver(2.0, 2.45)
  run.close(2.45, LINE.start + 0.45)
  run.finish()

  assert.deepEqual(run.takes.map(take => take.pass), [0, 1])
  const [first, second] = run.takes
  assert.equal(first.complete, true)
  assert.equal(first.end, LINE.end)
  assert.equal(second.complete, false)
  assert.ok(Math.abs(first.onset! - 10.5) < 0.02, `first onset ${first.onset}`)
  assert.ok(Math.abs(second.onset! - 10.3) < 0.02, `second onset ${second.onset}`)
  assert.ok(Math.abs(totalSeconds(first) - 2) < 0.02, 'the whole first pass is kept')
  // The second pass starts at the line start, with the silence the singer
  // actually left before opening.
  assert.ok(Math.abs(second.parts[0].songTime - LINE.start) < 1e-6)
  assert.ok(Math.abs(totalSeconds(second) - 0.45) < 0.02)
  assertInside(first)
  assertInside(second)
})

test('audio keeps its pass even when the loop notification is late', () => {
  const voice = (clock: number) =>
    (clock >= 0.5 && clock < 2.0) || (clock >= 2.3 && clock < 2.45)
  const late = harness(voice)
  // Everything up to the stop is handled before the loop notification.
  late.deliver(0, 2.45)
  late.jump(2.0)
  late.close(2.45, LINE.start + 0.45)
  late.finish()
  const lateTakes = late.takes

  const prompt = harness(voice)
  prompt.deliver(0, 2.0)
  prompt.jump(2.0)
  prompt.deliver(2.0, 2.45)
  prompt.close(2.45, LINE.start + 0.45)
  prompt.finish()

  assert.deepEqual(lateTakes.map(take => take.pass), [0, 1])
  assert.deepEqual(
    lateTakes.map(take => [take.onset === null ? null : Math.round(take.onset * 1000), take.complete]),
    prompt.takes.map(take => [take.onset === null ? null : Math.round(take.onset * 1000), take.complete]),
  )
  assert.ok(Math.abs(lateTakes[1].onset! - 10.3) < 0.02, `second onset ${lateTakes[1].onset}`)
  assert.ok(Math.abs(lateTakes[1].parts[0].songTime - LINE.start) < 1e-6)
})

test('a stall that plays past the boundary keeps that audio out of every pass', () => {
  const run = harness(clock => clock >= 0.5)
  // The page is blocked from 1.5 to 2.5. The accompaniment runs 0.5s past the
  // line end before it is sent back, and the notification only arrives then.
  run.deliver(0, 1.5)
  run.deliver(1.5, 2.6)
  run.jump(2.5)
  run.deliver(2.6, 2.8)
  run.close(2.8, LINE.start + 0.3)
  run.finish()

  const first = run.takes.find(take => take.pass === 0)!
  const second = run.takes.find(take => take.pass === 1)!
  assert.ok(first && second)
  assert.equal(first.complete, true)
  assert.equal(first.end, LINE.end)
  assertInside(first)
  // The next pass starts at the line start and only holds audio from after
  // the actual jump; the 0.5s that sounded past the boundary is gone.
  const secondStart = Math.min(...second.parts.map(part => part.songTime))
  assert.ok(Math.abs(secondStart - LINE.start) < 1e-6)
  assert.ok(Math.abs(totalSeconds(second) - 0.3) < 0.02, `second keeps ${totalSeconds(second)}s`)
  assertInside(second)
})

test('after a blocked jump the new pass still shows its real silence', () => {
  const run = harness(clock => clock >= 2.7 && clock < 2.8)
  run.deliver(0, 1.5)
  run.deliver(1.5, 2.8)
  run.jump(2.5)
  run.close(2.8, LINE.start + 0.3)
  run.finish()

  const second = run.takes.find(take => take.pass === 1)!
  assert.ok(second, 'the voiced pass after the jump is kept')
  assert.ok(Math.abs(second.onset! - 10.2) < 0.02, `onset ${second.onset}`)
  // The 0.2s of real silence between the jump and the onset is present in the
  // archived audio instead of being collapsed away.
  assert.ok(Math.abs(second.parts[0].songTime - LINE.start) < 1e-6)
  assert.ok(Math.abs(totalSeconds(second) - 0.3) < 0.02)
})

test('a frame that straddles the jump is split across the passes', () => {
  const timeline = createTimeline(LINE, 'session')
  timeline.begin(0, LINE.start, RATE)
  const size = Math.round(0.2 * RATE)
  const samples = new Float32Array(size)
  for (let index = 0; index < size; index++) {
    samples[index] = 0.3 * Math.sin(2 * Math.PI * 220 * index / RATE)
  }
  const early = timeline.receive(1.9, samples, RATE, sampler)
  assert.equal(early.takes.length, 0)
  const jumped = timeline.jump(2.0)
  const finished = timeline.finish()
  const all = early.takes.concat(jumped, finished)

  const first = all.find(take => take.pass === 0)!
  const second = all.find(take => take.pass === 1)!
  assert.ok(first, 'the pre-boundary half belongs to the first pass')
  assert.ok(second, 'the post-jump half belongs to the second pass')
  assert.ok(Math.abs(totalSeconds(first) - 0.1) < 0.002, `first half ${totalSeconds(first)}`)
  assert.ok(Math.abs(totalSeconds(second) - 0.1) < 0.002, `second half ${totalSeconds(second)}`)
  assertInside(first)
  assertInside(second)
})

test('stopping as the second pass opens keeps the confirmed voiced onset', () => {
  const run = harness(clock => clock >= 4.05 && clock < 4.5)
  run.deliver(0, 4.0)
  run.jump(2.0)
  run.jump(4.0)
  // The singer opens 0.05s into the second pass; the first frames with the
  // onset are delivered by the flush after the stop.
  run.deliver(4.0, 4.02)
  run.close(4.15, LINE.start + 0.15)
  run.deliver(4.02, 4.2)
  run.finish()

  const opening = run.takes.find(take => take.pass === 2)
  assert.ok(opening, 'the pass that had just opened is kept')
  assert.equal(opening.complete, false)
  assert.ok(Math.abs(opening.onset! - 10.05) < 0.02, `onset ${opening.onset}`)
  assert.ok(opening.end >= opening.onset)
  // Audio captured after the stop is not credited to the silent tail.
  assert.ok(Math.abs(totalSeconds(opening) - 0.15) < 0.03, `kept ${totalSeconds(opening)}s`)
})

test('waiting through a silent tail produces no extra take', () => {
  const run = harness(clock => clock >= 0.5 && clock < 2.0)
  run.deliver(0, 2.0)
  run.jump(2.0)
  run.deliver(2.0, 2.25)
  run.jump(4.0)
  run.deliver(2.25, 4.2)
  run.close(4.2, LINE.start + 2)
  run.finish()

  assert.deepEqual(run.takes.map(take => [take.pass, take.complete]), [[0, true]])
  assert.ok(Math.abs(run.takes[0].onset! - 10.5) < 0.02)
})

test('silence only, stopped while waiting, yields nothing', () => {
  const run = harness(() => false)
  run.deliver(0, 2.5)
  run.jump(2.0)
  run.deliver(2.5, 2.7)
  run.close(2.7, LINE.start + 0.7)
  run.finish()
  assert.deepEqual(run.takes, [])
})

test('a dropped microphone keeps what was already confirmed', () => {
  const run = harness(clock => clock >= 0.5)
  run.deliver(0, 1.2)
  // The track ends at 1.2; the stop uses the audible position. The last
  // frames arrive through the flush after the stop.
  run.close(1.2, LINE.start + 1.2)
  run.deliver(1.2, 1.25)
  run.finish()

  assert.equal(run.takes.length, 1)
  const [take] = run.takes
  assert.equal(take.pass, 0)
  assert.equal(take.complete, false)
  assert.ok(Math.abs(take.onset! - 10.5) < 0.02)
  assert.ok(Math.abs(totalSeconds(take) - 1.2) < 0.03, `kept ${totalSeconds(take)}s`)
  assertInside(take)
})

test('frames handled out of order are still placed by their timestamps', () => {
  const timeline = createTimeline(LINE, 'session')
  timeline.begin(0, LINE.start, RATE)
  const signal = microphone(() => true)
  const chunks: { start: number; audio: Float32Array }[] = []
  for (let start = 0; start < 2 - 1e-9; start += SIZE / RATE) {
    const length = Math.min(SIZE, Math.round((2 - start) * RATE))
    chunks.push({ start, audio: signal(start, length) })
  }
  const takes = []
  for (const chunk of [...chunks].sort((a, b) => b.start - a.start)) {
    takes.push(...timeline.receive(chunk.start, chunk.audio, RATE, sampler).takes)
  }
  timeline.close(2, LINE.end)
  takes.push(...timeline.finish())
  assert.equal(takes.length, 1)
  assert.ok(Math.abs(totalSeconds(takes[0]) - 2) < 0.03, `total ${totalSeconds(takes[0])}`)
  assert.ok(Math.abs(takes[0].onset! - LINE.start) < 0.03, `onset ${takes[0].onset}`)
})

test('the archived wav matches the pass and never runs past its end', () => {
  // Voice stops just before the jump and resumes 0.1s into the next pass.
  const run = harness(clock => (clock >= 1.0 && clock < 2.35) || clock >= 2.5)
  run.deliver(0, 2.5)
  run.jump(2.4)
  run.deliver(2.5, 2.7)
  run.close(2.7, LINE.start + 0.3)
  run.finish()
  for (const take of run.takes) {
    const blob = toWave(take.parts, take.start, take.end, take.rate)
    const expected = Math.round((take.end - take.start) * take.rate) * 2 + 44
    assert.equal(blob.size, expected)
    assertInside(take)
  }
  const second = run.takes.find(take => take.pass === 1)!
  assert.ok(second.onset !== null && Math.abs(second.onset - 10.1) < 0.02, `second onset ${second.onset}`)
})

test('firstVoicedSample ignores silence but catches a real onset', () => {
  assert.equal(firstVoicedSample(new Float32Array(RATE), RATE), null)
  const samples = new Float32Array(RATE)
  for (let index = Math.round(0.05 * RATE); index < samples.length; index++) {
    samples[index] = 0.2
  }
  const onset = firstVoicedSample(samples, RATE)
  assert.ok(onset !== null && Math.abs(onset - Math.round(0.05 * RATE)) < 3, `onset ${onset}`)
})
