// Soft synthesized chimes: no audio assets, everything built with WebAudio.

let ctx: AudioContext | null = null
let out: GainNode | null = null

function audio() {
  if (!ctx) {
    ctx = new AudioContext()
    out = ctx.createGain()
    out.gain.value = 0.55

    // Short generated impulse response gives the chime a little air.
    const len = ctx.sampleRate * 2.4
    const ir = ctx.createBuffer(2, len, ctx.sampleRate)
    for (let ch = 0; ch < 2; ch++) {
      const data = ir.getChannelData(ch)
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2)
    }
    const reverb = ctx.createConvolver()
    reverb.buffer = ir
    const wet = ctx.createGain()
    wet.gain.value = 0.32
    out.connect(ctx.destination)
    out.connect(reverb).connect(wet).connect(ctx.destination)
  }
  if (ctx.state === 'suspended') void ctx.resume()
  return { ctx, out: out! }
}

// A bell-ish tone: near-harmonic partials with fast attack and long, soft decay.
function bell(freq: number, when: number, gain: number, decay = 2.6) {
  const { ctx, out } = audio()
  const t0 = ctx.currentTime + when
  const partials: [number, number, number][] = [
    [1, 1, 1],
    [2.001, 0.42, 0.7],
    [3.0, 0.16, 0.45],
    [4.2, 0.07, 0.3],
  ]
  for (const [ratio, amp, life] of partials) {
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = freq * ratio
    g.gain.setValueAtTime(0, t0)
    g.gain.linearRampToValueAtTime(gain * amp, t0 + 0.008)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + decay * life)
    osc.connect(g).connect(out)
    osc.start(t0)
    osc.stop(t0 + decay * life + 0.05)
  }
}

const PENTATONIC = [0, 2, 4, 7, 9, 12, 14, 16]
const hz = (semitones: number, base = 659.25) => base * Math.pow(2, semitones / 12)

export const sound = {
  /** Called on a user gesture so the context is allowed to start. */
  unlock() {
    audio()
  },
  /** A star is born: two-note rising chime. */
  birth() {
    bell(hz(0), 0, 0.22, 3.4)
    bell(hz(7), 0.16, 0.18, 3.8)
  },
  /** A milestone star fades in or lights up. */
  twinkle(index = 0, loud = false) {
    bell(hz(PENTATONIC[index % PENTATONIC.length] + 12), 0, loud ? 0.16 : 0.06, loud ? 2.8 : 1.8)
  },
  /** Very quiet tick when the agent replies. */
  tick() {
    bell(hz(19), 0, 0.025, 0.9)
  },
}
