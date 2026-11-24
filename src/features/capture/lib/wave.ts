import type { AudioPart } from '../../../shared/document'

export function toWave(parts: readonly AudioPart[], start: number, end: number, rate: number) {
  const length = Math.max(0, Math.round((end - start) * rate))
  const buffer = new ArrayBuffer(44 + length * 2)
  const view = new DataView(buffer)
  const mark = (offset: number, tag: string) => {
    for (const [index, value] of Array.from(tag).entries()) view.setUint8(offset + index, value.charCodeAt(0))
  }
  mark(0, 'RIFF')
  view.setUint32(4, buffer.byteLength - 8, true)
  mark(8, 'WAVE')
  mark(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  mark(36, 'data')
  view.setUint32(40, length * 2, true)
  // Every part is placed at its own absolute spot on the pass. Audio that
  // sounded past the line boundary was clipped away before it got here, so a
  // blocked loop jump cannot leak over the boundary.
  for (const part of parts) {
    const offset = Math.round((part.songTime - start) * rate)
    const first = Math.max(0, -offset)
    const last = Math.min(part.samples.length, length - offset)
    for (let index = first; index < last; index++) {
      const value = Math.max(-1, Math.min(1, part.samples[index]))
      view.setInt16(44 + 2 * (offset + index), Math.round(value * 32767), true)
    }
  }
  return new Blob([buffer], { type: 'audio/wav' })
}
