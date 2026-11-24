import { computed, shallowRef } from 'vue'
import type { PitchPoint, TimeRange } from '../../../shared/document'
import { noteName, samplePitch } from '../lib/detect'

export function usePitch() {
  const points = shallowRef<PitchPoint[]>([])
  const latest = computed(() => {
    const midi = points.value.at(-1)?.midi
    return midi == null ? null : noteName(midi)
  })

  /** Analyse one piece of a received frame without adding it to the live view. */
  function sample(time: number, samples: Float32Array, rate: number) {
    return { time, midi: samplePitch(samples, rate) }
  }

  /** Add the points that were actually audible in the current pass. */
  function append(next: readonly PitchPoint[]) {
    points.value = [...points.value, ...next]
  }

  function slice(range: TimeRange) {
    return points.value.filter(point => point.time >= range.start && point.time < range.end)
  }

  function clear() { points.value = [] }
  return { points, latest, sample, append, slice, clear }
}
