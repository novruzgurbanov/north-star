import { hash, rng } from './textures'

export type Vec3 = [number, number, number]

const GOLDEN = 2.39996323

/** Where each of my goals sits. You are the centre of your own universe. */
export function myGoalOrigin(index: number): Vec3 {
  if (index === 0) return [0, 0, 0]
  const angle = index * GOLDEN
  const r = 9.5 + index * 0.6
  return [Math.cos(angle) * r, Math.sin(index * 1.7) * 2.2, Math.sin(angle) * r * 0.55 - 2]
}

/** Other people spiral outward around you (sunflower pattern keeps them apart). */
export function otherUserOrigin(k: number, id: string): Vec3 {
  const rand = rng(hash(id))
  const angle = k * GOLDEN + 0.6
  const r = 30 + 11 * Math.sqrt(k)
  return [Math.cos(angle) * r, (rand() - 0.5) * 10, Math.sin(angle) * r]
}

/** A user's goals relative to that user's origin. */
export function goalOffset(index: number): Vec3 {
  if (index === 0) return [0, 0, 0]
  const angle = index * GOLDEN
  return [Math.cos(angle) * 7.5, Math.sin(index * 2.1) * 2, Math.sin(angle) * 7.5]
}

/** Milestone positions relative to their goal star: a wandering, constellation-like path. */
export function milestonePositions(goalId: string, count: number): Vec3[] {
  const rand = rng(hash(goalId))
  const out: Vec3[] = []
  let angle = rand() * Math.PI * 2
  let x = 0
  let y = 0
  for (let i = 0; i < count; i++) {
    angle += (rand() - 0.5) * 1.9 + (i % 2 === 0 ? 0.5 : -0.2)
    const step = 1.7 + rand() * 1.3
    x += Math.cos(angle) * step
    y += Math.sin(angle) * step * 0.8
    out.push([x, y, (rand() - 0.5) * 1.6])
  }
  // Re-centre so the whole figure is balanced around the goal star.
  const cx = out.reduce((s, p) => s + p[0], 0) / Math.max(1, count)
  const cy = out.reduce((s, p) => s + p[1], 0) / Math.max(1, count)
  return out.map(([px, py, pz]) => [px - cx * 0.6, py - cy * 0.6, pz])
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
