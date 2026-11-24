export interface TimeRange { start: number; end: number }

export interface LyricLine extends TimeRange {
  id: string
  text: string
}

export interface GuideNote extends TimeRange { midi: number }

export interface Song {
  id: string
  title: string
  artist: string
  bpm: number
  key: string
  duration: number
  audio: string
  cover: string
  lines: LyricLine[]
  notes: GuideNote[]
}

export interface PitchPoint {
  time: number
  midi: number | null
}

export interface Take extends TimeRange {
  id: string
  songId: string
  lineId: string
  /** Groups the passes recorded while the microphone stayed open. */
  sessionId: string
  createdAt: number
  audio: Blob
  pitch: PitchPoint[]
  /** Zero-based pass over the line while the microphone kept running. */
  pass: number
  /** Song time of the confirmed voiced onset; null when none was detected. */
  onset: number | null
  /** False when the pass was stopped before reaching the end of the line. */
  complete: boolean
}

export interface PcmFrame {
  inputTime: number
  samples: Float32Array
}

/** One contiguous piece of microphone audio, placed on the song timeline. */
export interface AudioPart {
  /** Song time of the first sample in `samples`. */
  songTime: number
  samples: Float32Array
}
