import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Line } from '@react-three/drei'
import * as THREE from 'three'
import type { DetailKind, Goal } from '../types'
import { glowTexture, ringTexture } from './textures'
import { milestonePositions, type Vec3 } from './layout'
import { voiceLevel } from '../voice'

const now = () => performance.now() / 1000
const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const easeOutBack = (t: number) => {
  const c1 = 1.70158
  const c3 = c1 + 1
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2)
}

type StarProps = {
  position: Vec3
  color: string
  brightness: number
  size: number
  dim: number
  seed: number
  bornAt?: number
  delay?: number
  flashAt?: number
  shockwave?: boolean
  listening?: boolean
  pulse?: boolean
}

export function Star({ position, color, brightness, size, dim, seed, bornAt, delay = 0, flashAt, shockwave, listening, pulse }: StarProps) {
  const halo = useRef<THREE.Sprite>(null)
  const core = useRef<THREE.Sprite>(null)
  const ring = useRef<THREE.Sprite>(null)
  const current = useRef(bornAt === undefined ? brightness : 0.05)
  const base = useMemo(() => new THREE.Color(color), [color])
  const white = useMemo(() => new THREE.Color('#ffffff'), [])

  useFrame((_, dt) => {
    if (!halo.current || !core.current) return
    const t = now()
    let appear = 1
    let flash = 0
    let sinceBirth = Infinity
    if (bornAt !== undefined) {
      sinceBirth = t - bornAt - delay
      appear = sinceBirth < 0 ? 0 : clamp01(sinceBirth / 1.1)
      if (sinceBirth > 0) flash = Math.exp(-sinceBirth * 1.9) * (shockwave ? 1.4 : 0.7)
    }
    if (flashAt !== undefined) {
      const since = t - flashAt
      if (since >= 0 && since < 5) flash = Math.max(flash, Math.exp(-since * 1.6) * 1.1)
    }
    if (listening) flash = Math.max(flash, voiceLevel.current * 0.45)
    if (pulse) flash = Math.max(flash, (Math.sin(t * 2.4) * 0.5 + 0.5) * 0.22)
    current.current += (brightness - current.current) * Math.min(1, dt * 1.2)
    const b = current.current
    const twinkle = 1 + Math.sin(t * (1.1 + (seed % 7) * 0.13) + seed) * 0.07
    const s = size * (0.5 + b * 1.3) * twinkle * Math.max(0, easeOutBack(appear)) + size * flash * 2.6

    halo.current.scale.setScalar(s * 2.4)
    core.current.scale.setScalar(s * 0.55)
    const hm = halo.current.material
    hm.opacity = Math.min(1, ((0.16 + b * 0.84) * appear + flash * 0.7) * dim)
    hm.color.copy(base).multiplyScalar(0.5 + b * 1.9 + flash * 2.4)
    const cm = core.current.material
    cm.opacity = Math.min(1, (0.35 + b * 0.65) * appear * dim + flash * 0.4)
    cm.color.copy(white).lerp(base, 0.25).multiplyScalar(0.8 + b * 2.2 + flash * 2)

    if (ring.current) {
      const r = sinceBirth
      const visible = r > 0 && r < 2.2
      ring.current.visible = visible
      if (visible) {
        ring.current.scale.setScalar(size * (1 + r * 11))
        ring.current.material.opacity = (1 - r / 2.2) * 0.55 * dim
      }
    }
  })

  return (
    <group position={position}>
      <sprite ref={halo}>
        <spriteMaterial map={glowTexture()} transparent depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} opacity={0} />
      </sprite>
      <sprite ref={core}>
        <spriteMaterial map={glowTexture()} transparent depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} opacity={0} />
      </sprite>
      {shockwave && (
        <sprite ref={ring} visible={false}>
          <spriteMaterial map={ringTexture()} color={base} transparent depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} opacity={0} />
        </sprite>
      )}
    </group>
  )
}

function Segment({ from, to, color, lit, dim, bornAt, delay }: {
  from: Vec3; to: Vec3; color: string; lit: boolean; dim: number; bornAt?: number; delay: number
}) {
  const ref = useRef<any>(null)
  const current = useRef(0)
  useFrame((_, dt) => {
    const mat = ref.current?.material
    if (!mat) return
    let appear = 1
    if (bornAt !== undefined) appear = clamp01((now() - bornAt - delay) / 1.2)
    const target = (lit ? 0.55 : 0.14) * dim * appear
    current.current += (target - current.current) * Math.min(1, dt * 2)
    mat.opacity = current.current
  })
  return <Line ref={ref} points={[from, to]} color={color} lineWidth={1} transparent opacity={0} depthWrite={false} toneMapped={false} />
}

// Details orbit the goal star as tiny satellites, tinted by what they are.
const DETAIL_TINT: Record<DetailKind, string | null> = {
  motivation: '#ffd59e',
  on_track: '#8dffc7',
  action: null,
  subgoal: null,
  obstacle: '#ff9eb0',
  distraction: '#ff6b81',
}

function detailPosition(i: number, total: number, scale: number): Vec3 {
  const angle = (i / Math.max(1, total)) * Math.PI * 2 + 0.7
  const r = (1.5 + (i % 3) * 0.32) * scale
  return [Math.cos(angle) * r, Math.sin(angle) * r * 0.75, Math.sin(angle * 2) * 0.5 * scale]
}

type Props = {
  goal: Goal
  color: string
  origin: Vec3
  dim?: number
  scale?: number
  bornAt?: number
  listening?: boolean
  pulse?: boolean
}

export function Constellation({ goal, color, origin, dim = 1, scale = 1, bornAt, listening, pulse }: Props) {
  const positions = useMemo(
    () => milestonePositions(goal.id, goal.milestones.length).map(p => p.map(v => v * scale) as Vec3),
    [goal.id, goal.milestones.length, scale],
  )

  // Remember when each milestone turned done so its star can flare.
  const prevDone = useRef(new Map<string, boolean>())
  const flashes = useRef(new Map<string, number>())
  useEffect(() => {
    for (const m of goal.milestones) {
      const before = prevDone.current.get(m.id)
      if (before === false && m.done) flashes.current.set(m.id, now())
      prevDone.current.set(m.id, m.done)
    }
  }, [goal.milestones])

  const ms = [...goal.milestones].sort((a, b) => a.order - b.order)
  const milestoneDelay = (i: number) => 1.5 + i * 0.55

  return (
    <group position={origin}>
      <Star position={[0, 0, 0]} color={color} brightness={goal.brightness} size={1.05 * scale} dim={dim}
        seed={1} bornAt={bornAt} shockwave={bornAt !== undefined} listening={listening} pulse={pulse} />
      {ms.map((m, i) => (
        <Star key={m.id} position={positions[i]} color={color} brightness={m.brightness} size={0.42 * scale}
          dim={dim} seed={i + 2} bornAt={bornAt} delay={milestoneDelay(i)} flashAt={flashes.current.get(m.id)} />
      ))}
      {(goal.details ?? []).map((d, i, all) => {
        const pos = detailPosition(i, all.length, scale)
        const tint = DETAIL_TINT[d.kind] ?? color
        return (
          <group key={d.id}>
            <Star position={pos} color={tint} brightness={d.kind === 'distraction' || d.kind === 'obstacle' ? 0.3 : 0.55}
              size={0.17 * scale} dim={dim} seed={i + 40} bornAt={bornAt} delay={0.9 + i * 0.25} />
            <Segment from={[0, 0, 0]} to={pos} color={tint} lit={false} dim={dim * 0.55} bornAt={bornAt} delay={0.8 + i * 0.25} />
          </group>
        )
      })}
      {ms.map((m, i) => (
        <Segment key={`s-${m.id}`} from={i === 0 ? [0, 0, 0] : positions[i - 1]} to={positions[i]} color={color}
          lit={m.done && (i === 0 || ms[i - 1].done)} dim={dim} bornAt={bornAt} delay={milestoneDelay(i) - 0.3} />
      ))}
    </group>
  )
}
