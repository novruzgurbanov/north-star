// Microphone capture for voice input. Audio is decoded and resampled in the browser
// to 16 kHz mono Float32 PCM, which is what the server's local Whisper expects.

/** Live input level (0..1) that the 3D scene reads to pulse with the user's voice. */
export const voiceLevel = { current: 0 }

export const MAX_SECONDS = 120

export class Recorder {
  private stream: MediaStream | null = null
  private ctx: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private recorder: MediaRecorder | null = null
  private chunks: Blob[] = []
  private samples = new Float32Array(1024)

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    this.ctx = new AudioContext()
    const source = this.ctx.createMediaStreamSource(this.stream)
    this.analyser = this.ctx.createAnalyser()
    this.analyser.fftSize = 1024
    source.connect(this.analyser)
    this.chunks = []
    this.recorder = new MediaRecorder(this.stream)
    this.recorder.ondataavailable = e => { if (e.data.size > 0) this.chunks.push(e.data) }
    this.recorder.start(250)
  }

  /** Current loudness, roughly 0..1. */
  level() {
    if (!this.analyser) return 0
    this.analyser.getFloatTimeDomainData(this.samples)
    let sum = 0
    for (let i = 0; i < this.samples.length; i++) sum += this.samples[i] * this.samples[i]
    const rms = Math.sqrt(sum / this.samples.length)
    return Math.min(1, rms * 6)
  }

  stop(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const rec = this.recorder
      if (!rec) return reject(new Error('not recording'))
      rec.onstop = () => {
        const blob = new Blob(this.chunks, { type: rec.mimeType || 'audio/webm' })
        this.release()
        resolve(blob)
      }
      rec.stop()
    })
  }

  cancel() {
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.onstop = null
      this.recorder.stop()
    }
    this.release()
  }

  private release() {
    this.stream?.getTracks().forEach(t => t.stop())
    void this.ctx?.close().catch(() => {})
    this.stream = null
    this.ctx = null
    this.analyser = null
    this.recorder = null
    voiceLevel.current = 0
  }
}

/** Decode any recorded blob and resample it to 16 kHz mono Float32. */
export async function toPcm16k(blob: Blob): Promise<Float32Array> {
  const data = await blob.arrayBuffer()
  const decoder = new AudioContext()
  let audio: AudioBuffer
  try {
    audio = await decoder.decodeAudioData(data)
  } finally {
    void decoder.close().catch(() => {})
  }
  const length = Math.max(1, Math.ceil(audio.duration * 16000))
  const offline = new OfflineAudioContext(1, length, 16000)
  const src = offline.createBufferSource()
  src.buffer = audio
  src.connect(offline.destination)
  src.start()
  const rendered = await offline.startRendering()
  return rendered.getChannelData(0)
}
