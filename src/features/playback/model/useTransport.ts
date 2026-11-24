import { computed, onBeforeUnmount, ref, shallowRef } from 'vue'
import type { Song, TimeRange } from '../../../shared/document'

/**
 * `beforeSeek` / `onPause` receive the position that was actually audible
 * before the operation. `onLoop` is called when playback leaves the loop,
 * with the boundary time; the jump back is applied immediately afterwards.
 */
interface TransportEvents {
  beforeSeek: (position: number) => void
  onPause: (position: number) => void
  onLoop: (boundary: number) => void
}

export function useTransport(initial: Song, events: TransportEvents) {
  const song = shallowRef(initial)
  const position = ref(0)
  const isPlaying = ref(false)
  const loop = shallowRef<TimeRange | null>(null)
  const volume = ref(0.7)
  const issue = ref('')
  const audio = new Audio(initial.audio)
  audio.preload = 'metadata'
  audio.volume = volume.value
  let render = 0
  let operation = 0
  // True between asking for the loop jump and the element actually landing at
  // the loop start. Without it a stale currentTime can report the boundary
  // again and start a phantom extra pass.
  let resetting = false

  function sync() {
    if (audio.seeking) return
    const next = audio.currentTime
    const range = loop.value
    if (!range) {
      resetting = false
    } else if (next < range.end - 1e-3) {
      resetting = false
    } else if (!audio.paused) {
      if (resetting) return
      resetting = true
      events.onLoop(range.end)
      audio.currentTime = range.start
      position.value = range.start
      return
    }
    position.value = next
  }

  function update() {
    sync()
    if (!audio.paused) render = requestAnimationFrame(update)
  }

  function read() { return audio.currentTime }

  function seek(seconds: number) {
    const time = Math.max(0, Math.min(seconds, song.value.duration))
    if (loop.value && time < loop.value.end - 1e-3) resetting = false
    events.beforeSeek(read())
    audio.currentTime = time
    position.value = time
  }

  function pause() {
    operation++
    // Observe a pending loop jump while the element is still playing, so a
    // pause that arrives right after the jump is reported as the new pass.
    sync()
    audio.pause()
    isPlaying.value = false
    events.onPause(read())
    cancelAnimationFrame(render)
    sync()
  }

  async function play() {
    if (isPlaying.value) return true
    const current = ++operation
    issue.value = ''
    const range = loop.value
    if (range && (read() < range.start || read() >= range.end)) seek(range.start)
    else if (audio.ended) seek(0)
    resetting = false
    try {
      await audio.play()
      if (current !== operation) return false
      isPlaying.value = true
      cancelAnimationFrame(render)
      render = requestAnimationFrame(update)
      return true
    } catch {
      if (current === operation) issue.value = '伴奏播放失败，请重试。'
      return false
    }
  }

  function setSong(next: Song) {
    pause()
    song.value = next
    loop.value = null
    position.value = 0
    issue.value = ''
    audio.src = next.audio
    audio.load()
  }

  function setVolume(next: number) {
    volume.value = Math.min(1, Math.max(0, next))
    audio.volume = volume.value
  }

  function handleEnd() { pause() }
  function handleError() {
    pause()
    issue.value = '无法读取伴奏。'
  }
  audio.addEventListener('timeupdate', sync)
  audio.addEventListener('ended', handleEnd)
  audio.addEventListener('error', handleError)
  onBeforeUnmount(() => {
    pause()
    audio.removeEventListener('timeupdate', sync)
    audio.removeEventListener('ended', handleEnd)
    audio.removeEventListener('error', handleError)
    audio.removeAttribute('src')
    audio.load()
  })

  const progress = computed(() => position.value / song.value.duration)
  return { song, position, progress, loop, isPlaying, volume, issue, read, seek, play, pause, setSong, setVolume }
}
