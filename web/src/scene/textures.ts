import * as THREE from 'three'

function canvasTexture(size: number, draw: (g: CanvasRenderingContext2D, s: number) => void) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const g = canvas.getContext('2d')!
  draw(g, size)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

let glow: THREE.Texture | null = null
/** Soft round halo with faint diffraction spikes. */
export function glowTexture() {
  if (glow) return glow
  glow = canvasTexture(256, (g, s) => {
    const c = s / 2
    const halo = g.createRadialGradient(c, c, 0, c, c, c)
    halo.addColorStop(0, 'rgba(255,255,255,1)')
    halo.addColorStop(0.08, 'rgba(255,255,255,0.85)')
    halo.addColorStop(0.22, 'rgba(255,255,255,0.28)')
    halo.addColorStop(0.5, 'rgba(255,255,255,0.06)')
    halo.addColorStop(1, 'rgba(255,255,255,0)')
    g.fillStyle = halo
    g.fillRect(0, 0, s, s)
    g.globalCompositeOperation = 'lighter'
    for (const [w, h] of [[s, 3], [3, s]]) {
      const spike = g.createRadialGradient(c, c, 0, c, c, c)
      spike.addColorStop(0, 'rgba(255,255,255,0.55)')
      spike.addColorStop(0.6, 'rgba(255,255,255,0.04)')
      spike.addColorStop(1, 'rgba(255,255,255,0)')
      g.fillStyle = spike
      g.fillRect(c - w / 2, c - h / 2, w, h)
    }
  })
  return glow
}

let dot: THREE.Texture | null = null
/** Small soft dot for dust particles. */
export function dotTexture() {
  if (dot) return dot
  dot = canvasTexture(64, (g, s) => {
    const c = s / 2
    const grad = g.createRadialGradient(c, c, 0, c, c, c)
    grad.addColorStop(0, 'rgba(255,255,255,1)')
    grad.addColorStop(0.35, 'rgba(255,255,255,0.35)')
    grad.addColorStop(1, 'rgba(255,255,255,0)')
    g.fillStyle = grad
    g.fillRect(0, 0, s, s)
  })
  return dot
}

let ring: THREE.Texture | null = null
/** Thin bright ring for the birth shockwave. */
export function ringTexture() {
  if (ring) return ring
  ring = canvasTexture(256, (g, s) => {
    const c = s / 2
    const grad = g.createRadialGradient(c, c, c * 0.72, c, c, c * 0.98)
    grad.addColorStop(0, 'rgba(255,255,255,0)')
    grad.addColorStop(0.55, 'rgba(255,255,255,0.7)')
    grad.addColorStop(1, 'rgba(255,255,255,0)')
    g.fillStyle = grad
    g.fillRect(0, 0, s, s)
  })
  return ring
}

const clouds = new Map<string, THREE.Texture>()
/** Wispy nebula cloud built from layered soft blobs. */
export function cloudTexture(seed: number) {
  const key = String(seed)
  const hit = clouds.get(key)
  if (hit) return hit
  const rand = rng(seed)
  const tex = canvasTexture(512, (g, s) => {
    g.globalCompositeOperation = 'lighter'
    for (let i = 0; i < 46; i++) {
      const x = s * (0.2 + rand() * 0.6)
      const y = s * (0.25 + rand() * 0.5)
      const r = s * (0.06 + rand() * 0.22)
      const grad = g.createRadialGradient(x, y, 0, x, y, r)
      const a = 0.025 + rand() * 0.05
      grad.addColorStop(0, `rgba(255,255,255,${a})`)
      grad.addColorStop(1, 'rgba(255,255,255,0)')
      g.fillStyle = grad
      g.fillRect(0, 0, s, s)
    }
  })
  clouds.set(key, tex)
  return tex
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function hash(str: string) {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}
