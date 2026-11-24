<script setup lang="ts">
import { Activity } from '@lucide/vue'
import { onBeforeUnmount, onMounted, ref, watchEffect } from 'vue'
import type { GuideNote, PitchPoint, TimeRange } from '../../../shared/document'
import { drawPitch } from '../lib/plot'

const props = defineProps<{
  notes: GuideNote[]; position: number; range: TimeRange; latest: string | null
  live: PitchPoint[]; takeA: PitchPoint[]; takeB: PitchPoint[]; pass: number
  onsets: { onset: number | null; complete: boolean }[]
}>()
const canvas = ref<HTMLCanvasElement | null>(null)
const size = ref({ width: 0, height: 0 })
let observer: ResizeObserver | undefined
onMounted(() => {
  if (!canvas.value) return
  observer = new ResizeObserver(([entry]) => {
    size.value = { width: entry.contentRect.width, height: entry.contentRect.height }
  })
  observer.observe(canvas.value)
})
onBeforeUnmount(() => observer?.disconnect())
watchEffect(() => {
  const { width, height } = size.value
  if (!canvas.value || width < 80 || height < 80) return
  drawPitch(canvas.value, width, height, {
    notes: props.notes, range: props.range, position: props.position,
    onsets: props.onsets,
    traces: [
      { points: props.takeA, color: '#85cbd5' },
      { points: props.takeB, color: '#ec9fa9' },
      { points: props.live, color: '#b8dc9d' },
    ],
  })
})
</script>

<template>
  <section class="pitch-panel" aria-labelledby="pitch-title">
    <div class="pitch-heading">
      <h2 id="pitch-title" class="panel-heading"><Activity :size="17" /> 音高轨迹</h2>
      <div class="pitch-legends">
        <span><i class="legend reference"></i>参考音</span><span><i class="legend live"></i>我的声音</span>
        <span v-if="takeA.length"><i class="legend a"></i>A</span><span v-if="takeB.length"><i class="legend b"></i>B</span>
        <span v-if="pass > 0" class="mono">第 {{ pass + 1 }} 遍</span>
        <span v-if="onsets.some(entry => entry.onset !== null)"><i class="legend onset"></i>开口</span>
        <span v-if="onsets.some(entry => !entry.complete)"><i class="legend cut"></i>未完成</span>
      </div>
    </div>
    <canvas ref="canvas" class="pitch-canvas" role="img"
      :aria-label="`参考音与录音音高轨迹，当前音高 ${latest ?? '未检测到'}`"></canvas>
    <div class="pitch-footer"><span>当前音高 <strong class="mono">{{ latest ?? '—' }}</strong></span><span>歌曲时间</span></div>
  </section>
</template>
