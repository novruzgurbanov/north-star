import { useMemo, useRef } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Html, Stars } from '@react-three/drei'
import { Bloom, EffectComposer, Noise, Vignette } from '@react-three/postprocessing'
import * as THREE from 'three'
import type { Goal, PointsRow, User } from '../types'
import { Constellation } from './Constellation'
import { Protostar } from './Protostar'
import { cloudTexture } from './textures'
import { add, myGoalOrigin, otherUserOrigin, type Vec3 } from './layout'

/**
 * Other players only share points, so their constellation is drawn from those numbers:
 * more stars as they bank verified time, more of them lit, brighter overall with points.
 */
function playerConstellation(p: PointsRow): Goal {
  const count = 3 + Math.min(4, Math.floor(p.points / 300))
  const lit = Math.min(count, Math.floor(p.focusedMinutes / 120))
  return {
    id: p.id,
    title: p.goalTitle ?? '',
    why: '',
    successLooksLike: '',
    deadline: null,
    createdAt: p.createdAt,
    brightness: Math.min(1, 0.22 + p.points / 1600 + (p.live ? 0.15 : 0)),
    milestones: Array.from({ length: count }, (_, i) => ({
      id: `${p.id}-${i}`, title: '', done: i < lit, order: i, brightness: i < lit ? 1 : 0.18,
    })),
  }
}

export type View = 'sky' | 'cosmos'

type Props = {
  me: User | null
  myGoals: Goal[]
  bornAt: Record<string, number>
  focusIndex: number
  discovering: boolean
  understanding: number
  view: View
  others: PointsRow[]
  myScore: number
  focusing: string | null
  nav?: boolean
}

function Nebula() {
  const clouds = useMemo(() => [
    { pos: [-160, 40, -260] as Vec3, scale: 360, color: '#3b2a7a', seed: 3, opacity: 0.55 },
    { pos: [220, -30, -300] as Vec3, scale: 420, color: '#123a6b', seed: 11, opacity: 0.5 },
    { pos: [30, 120, -340] as Vec3, scale: 300, color: '#5a1f4f', seed: 23, opacity: 0.3 },
    { pos: [-260, -90, 120] as Vec3, scale: 380, color: '#0f4a52', seed: 31, opacity: 0.35 },
    { pos: [260, 60, 200] as Vec3, scale: 340, color: '#2a2370', seed: 47, opacity: 0.4 },
  ], [])
  return (
    <>
      {clouds.map(c => (
        <sprite key={c.seed} position={c.pos} scale={[c.scale, c.scale, 1]}>
          <spriteMaterial map={cloudTexture(c.seed)} color={c.color} transparent opacity={c.opacity}
            depthWrite={false} blending={THREE.AdditiveBlending} />
        </sprite>
      ))}
    </>
  )
}

const reducedMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

function CameraRig({ view, focus, panel, nav }: { view: View; focus: Vec3; panel: boolean; nav: boolean }) {
  const { camera, size } = useThree()
  const look = useRef(new THREE.Vector3(...focus))
  const target = useMemo(() => new THREE.Vector3(), [])
  const lookTarget = useMemo(() => new THREE.Vector3(), [])
  useFrame((state, dt) => {
    const t = reducedMotion ? 0 : state.clock.elapsedTime
    const px = reducedMotion ? 0 : state.pointer.x
    const py = reducedMotion ? 0 : state.pointer.y
    const narrow = size.width < 760
    if (view === 'sky') {
      // Frame the star in the open sky: above the chat dock, and right of the goal panel when it is shown.
      const dist = narrow ? 30 : 24
      const shiftX = narrow ? 0 : (panel ? -6.5 : 0) + (nav ? -2.4 : 0)
      const shiftY = narrow ? -5 : -3
      target.set(focus[0] + shiftX + px * 1.4, focus[1] + 1.4 + shiftY + py * 0.9, focus[2] + dist)
      lookTarget.set(focus[0] + shiftX, focus[1] + shiftY, focus[2])
    } else {
      const a = t * 0.03
      const dist = narrow ? 150 : 108
      target.set(Math.sin(a) * dist + px * 8, 46 + py * 6, Math.cos(a) * dist)
      lookTarget.set(0, -4, 0)
    }
    const k = 1 - Math.exp(-dt * (view === 'sky' ? 1.5 : 0.9))
    camera.position.lerp(target, k)
    look.current.lerp(lookTarget, k)
    camera.lookAt(look.current)
  })
  return null
}

function UserLabel({ position, name, goal, score, color, visible, you, live }: {
  position: Vec3; name: string; goal?: string | null; score: number; color: string; visible: boolean; you?: boolean; live?: boolean
}) {
  return (
    <Html position={position} center zIndexRange={[5, 0]} style={{ pointerEvents: 'none' }}>
      <div className={`star-label ${visible ? 'is-visible' : ''} ${you ? 'is-you' : ''}`}>
        <span className={`star-label-dot ${live ? 'is-live' : ''}`} style={{ background: color, boxShadow: `0 0 10px ${color}` }} />
        <span className="star-label-text">
          <span className="star-label-name">{you ? 'You' : name}<span className="star-label-score">{score.toLocaleString()}</span></span>
          {goal && <span className="star-label-goal">{goal}</span>}
        </span>
      </div>
    </Html>
  )
}

export function Universe({ me, myGoals, bornAt, focusIndex, discovering, understanding, view, others, myScore, focusing, nav = false }: Props) {
  const color = me?.color ?? '#cfe2ff'
  const focus = myGoalOrigin(focusIndex)
  const cosmos = view === 'cosmos'

  return (
    <Canvas
      className="universe"
      dpr={[1, 2]}
      camera={{ fov: 50, near: 0.1, far: 3000, position: [0, 30, 60] }}
      gl={{ antialias: false, powerPreference: 'high-performance' }}
    >
      <color attach="background" args={['#020309']} />
      <fog attach="fog" args={['#020309', 160, 520]} />
      <Stars radius={260} depth={160} count={9000} factor={5} saturation={0.15} fade speed={0.35} />
      <Nebula />
      <CameraRig view={view} focus={focus} panel={!discovering && myGoals.length > 0} nav={nav} />

      {myGoals.map((g, i) => (
        <Constellation key={g.id} goal={g} color={color} origin={myGoalOrigin(i)} bornAt={bornAt[g.id]}
          scale={g.status === 'brainstorm' ? 0.7 : 1}
          listening={!discovering && i === focusIndex} pulse={focusing === g.id} />
      ))}
      <Protostar position={myGoalOrigin(myGoals.length)} understanding={understanding} active={discovering} color={color} />

      {others.map((p, k) => {
        const origin = otherUserOrigin(k + 1, p.id)
        return (
          <group key={p.id}>
            <Constellation goal={playerConstellation(p)} color={p.color} origin={origin}
              dim={cosmos ? 0.95 : 0.4} scale={0.9} pulse={p.live} />
            <UserLabel position={add(origin, [0, 5.2, 0])} name={p.name} goal={p.goalTitle} score={p.points}
              color={p.color} visible={cosmos} live={p.live} />
          </group>
        )
      })}
      {me && (
        <UserLabel position={[0, 5.2, 0]} name={me.name} score={myScore} color={color} visible={cosmos && myGoals.length > 0} you />
      )}

      <EffectComposer multisampling={0}>
        <Bloom mipmapBlur intensity={1.25} luminanceThreshold={0.18} luminanceSmoothing={0.35} radius={0.75} />
        <Noise opacity={0.028} />
        <Vignette offset={0.22} darkness={0.78} />
      </EffectComposer>
    </Canvas>
  )
}
