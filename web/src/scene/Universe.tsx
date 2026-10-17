import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { Line, Stars } from '@react-three/drei'
import { Bloom, EffectComposer, Noise, Vignette } from '@react-three/postprocessing'
import * as THREE from 'three'
import type { Goal, PointsRow, PublicGoal, User } from '../types'
import { Constellation, DETAIL_TINT, Star, detailPosition } from './Constellation'
import { Protostar } from './Protostar'
import { cloudTexture, hash, rng } from './textures'
import { add, milestonePositions, myGoalOrigin, otherUserOrigin, type Vec3 } from './layout'

export type View = 'sky' | 'cosmos'

/** Screen insets (px) of the UI around the open sky; the scene is centred in what is left. */
export type Frame = { left: number; right: number; top: number; bottom: number }

type Props = {
  me: User | null
  myGoals: Goal[]
  bornAt: Record<string, number>
  /** The goal whose full constellation is shown; null = overview (one star per goal). */
  focusGoalId: string | null
  forgeIndex: number
  discovering: boolean
  understanding: number
  view: View
  others: PointsRow[]
  myScore: number
  focusing: string | null
  frame: Frame
  onPickGoal?: (goalId: string) => void
  onPickPlayer?: (playerId: string) => void
}

const reducedMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

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

/** Progressive resistance past a limit, so the camera never hits a hard wall. */
function rubberband(value: number, min: number, max: number, softness: number) {
  if (value < min) return min - (softness * (min - value)) / (softness + (min - value))
  if (value > max) return max + (softness * (value - max)) / (softness + (value - max))
  return value
}

type Home = { center: Vec3; distance: number; pitch: number; key: string }

/**
 * Orbit camera you can grab: drag to orbit (1:1), right-drag or shift-drag to pan, wheel to zoom,
 * momentum after a flick, soft limits, double-click to recentre. The projection is offset so the
 * scene's centre lands in the middle of the open sky between the panels.
 */
function CameraRig({ home, frame, autoRotate }: { home: Home; frame: Frame; autoRotate: boolean }) {
  const { camera, gl, size } = useThree()
  const cam = camera as THREE.PerspectiveCamera
  const s = useRef({
    yaw: 0, pitch: home.pitch, zoom: 1, zoomTarget: 1,
    pan: new THREE.Vector3(), velYaw: 0, velPitch: 0,
    dragging: false, mode: 'orbit' as 'orbit' | 'pan', lastX: 0, lastY: 0, lastT: 0, moved: 0,
    idleSince: performance.now(), offX: 0, offY: 0,
    center: new THREE.Vector3(...home.center), distance: home.distance,
  })

  // A new home (other goal, other view) gently resets the user's orbit.
  useEffect(() => {
    const st = s.current
    st.yaw = 0; st.pitch = home.pitch; st.zoomTarget = 1; st.pan.set(0, 0, 0); st.velYaw = 0; st.velPitch = 0
  }, [home.key, home.pitch])

  useEffect(() => {
    const el = gl.domElement
    const st = s.current
    const down = (e: PointerEvent) => {
      if (e.button !== 0 && e.button !== 2) return
      st.dragging = true
      st.mode = e.button === 2 || e.shiftKey ? 'pan' : 'orbit'
      st.lastX = e.clientX; st.lastY = e.clientY; st.lastT = performance.now(); st.moved = 0
      st.velYaw = 0; st.velPitch = 0
      el.setPointerCapture(e.pointerId)
    }
    const move = (e: PointerEvent) => {
      if (!st.dragging) return
      const now = performance.now()
      const dx = e.clientX - st.lastX
      const dy = e.clientY - st.lastY
      const dt = Math.max(1, now - st.lastT)
      st.moved += Math.abs(dx) + Math.abs(dy)
      st.lastX = e.clientX; st.lastY = e.clientY; st.lastT = now
      st.idleSince = now
      if (st.moved > 4) el.style.cursor = 'grabbing'
      if (st.mode === 'orbit') {
        const dYaw = -dx * 0.0055
        const dPitch = dy * 0.0045
        st.yaw += dYaw
        st.pitch = rubberband(st.pitch + dPitch, -1.1, 1.25, 0.25)
        // Smoothed velocity (rad/ms) for the hand-off at release.
        st.velYaw = st.velYaw * 0.6 + (dYaw / dt) * 0.4
        st.velPitch = st.velPitch * 0.6 + (dPitch / dt) * 0.4
      } else {
        const scale = (st.distance * st.zoom) / size.height * 1.1
        const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0)
        const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1)
        st.pan.addScaledVector(right, -dx * scale).addScaledVector(up, dy * scale)
      }
    }
    const up = (e: PointerEvent) => {
      if (!st.dragging) return
      st.dragging = false
      el.style.cursor = ''
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
      // A short flick keeps spinning; a slow release just stops.
      if (performance.now() - st.lastT > 80) { st.velYaw = 0; st.velPitch = 0 }
    }
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      st.idleSince = performance.now()
      // ~30% per wheel notch; line-based wheels (deltaMode 1) report rows, not pixels.
      const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY
      st.zoomTarget = rubberband(st.zoomTarget * Math.exp(delta * 0.0026), 0.3, 3.2, 0.4)
    }
    const dbl = () => { st.yaw = 0; st.pitch = home.pitch; st.zoomTarget = 1; st.pan.set(0, 0, 0); st.velYaw = 0; st.velPitch = 0 }
    const menu = (e: MouseEvent) => e.preventDefault()
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
    el.addEventListener('wheel', wheel, { passive: false })
    el.addEventListener('dblclick', dbl)
    el.addEventListener('contextmenu', menu)
    return () => {
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      el.removeEventListener('wheel', wheel)
      el.removeEventListener('dblclick', dbl)
      el.removeEventListener('contextmenu', menu)
    }
  }, [gl, cam, size.height, home.pitch])

  const target = useMemo(() => new THREE.Vector3(), [])
  const lookAt = useMemo(() => new THREE.Vector3(), [])
  useFrame((_, dt) => {
    const st = s.current
    const k = 1 - Math.exp(-dt * 3.2)
    if (!st.dragging) {
      // Momentum: exponential decay (0.998 per ms), then soft limits spring back.
      st.yaw += st.velYaw * dt * 1000
      st.pitch += st.velPitch * dt * 1000
      const decay = Math.pow(0.998, dt * 1000)
      st.velYaw *= decay; st.velPitch *= decay
      const clamped = Math.min(1.25, Math.max(-1.1, st.pitch))
      st.pitch += (clamped - st.pitch) * (1 - Math.exp(-dt * 10))
      st.zoomTarget += (Math.min(3.2, Math.max(0.3, st.zoomTarget)) - st.zoomTarget) * (1 - Math.exp(-dt * 10))
      if (autoRotate && !reducedMotion && performance.now() - st.idleSince > 4000) st.yaw += dt * 0.03
    }
    st.zoom += (st.zoomTarget - st.zoom) * (1 - Math.exp(-dt * 12))
    st.center.lerp(new THREE.Vector3(...home.center), k)
    st.distance += (home.distance - st.distance) * k

    const r = st.distance * st.zoom
    lookAt.copy(st.center).add(st.pan)
    target.set(
      lookAt.x + r * Math.sin(st.yaw) * Math.cos(st.pitch),
      lookAt.y + r * Math.sin(st.pitch),
      lookAt.z + r * Math.cos(st.yaw) * Math.cos(st.pitch),
    )
    cam.position.copy(target)
    cam.lookAt(lookAt)

    // Centre the scene in the open sky: shift the projection, not the camera.
    const wantX = (frame.left - frame.right) / 2
    const wantY = (frame.top - frame.bottom) / 2
    st.offX += (wantX - st.offX) * (1 - Math.exp(-dt * 6))
    st.offY += (wantY - st.offY) * (1 - Math.exp(-dt * 6))
    cam.setViewOffset(size.width, size.height, -st.offX, -st.offY, size.width, size.height)
  })
  return null
}

type LabelSpec = { key: string; position: Vec3; visible: boolean; onClick?: () => void; title?: string; node: ReactNode }

/**
 * Projects label anchors to the screen every frame and moves plain DOM labels there.
 * (One overlay, no React root per label, so nothing races on unmount.)
 */
function Projector({ specs, els }: { specs: LabelSpec[]; els: React.MutableRefObject<Map<string, HTMLDivElement>> }) {
  const { camera, size } = useThree()
  const v = useMemo(() => new THREE.Vector3(), [])
  useFrame(() => {
    // The camera moved earlier this frame, but its world matrix only refreshes at render time;
    // refresh it now so labels use this frame's view and stay glued to their stars.
    camera.updateMatrixWorld()
    for (const spec of specs) {
      const el = els.current.get(spec.key)
      if (!el) continue
      v.set(spec.position[0], spec.position[1], spec.position[2]).project(camera)
      const behind = v.z > 1
      const x = (v.x * 0.5 + 0.5) * size.width
      const y = (-v.y * 0.5 + 0.5) * size.height
      el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -50%)`
      el.style.visibility = behind ? 'hidden' : 'visible'
    }
  })
  return null
}

/** Ignore clicks that were really the end of a drag. */
const isTap = (e: ThreeEvent<MouseEvent>) => e.delta < 6

/** A player's constellation: one star per public goal, joined in order. */
function GoalStars({ goals, color, origin, dim, pulse, seed, onClick }: {
  goals: { id: string; brightness: number; status: string }[]; color: string; origin: Vec3; dim: number
  pulse?: boolean; seed: string; onClick?: () => void
}) {
  const points = useMemo(() => {
    const rand = rng(hash(seed))
    const n = Math.max(1, goals.length)
    const start = rand() * Math.PI * 2
    const r = n === 1 ? 0 : 2.6 + n * 0.45
    return goals.map((_, i) => {
      const a = start + (i / n) * Math.PI * 2 + (rand() - 0.5) * 0.5
      return [Math.cos(a) * r, (rand() - 0.5) * 1.6, Math.sin(a) * r * 0.8] as Vec3
    })
  }, [goals.length, seed]) // eslint-disable-line react-hooks/exhaustive-deps
  const ring = goals.length >= 3 ? [...points, points[0]] : points
  return (
    <group position={origin}>
      {goals.map((g, i) => (
        <Star key={g.id} position={points[i]} color={color} brightness={Math.max(0.2, g.brightness)}
          size={g.status === 'brainstorm' ? 0.7 : 1} dim={dim} seed={i + 1} pulse={pulse && i === 0} />
      ))}
      {ring.length > 1 && (
        <Line points={ring} color={color} lineWidth={1} transparent opacity={0.22 * dim} depthWrite={false} toneMapped={false} />
      )}
      {onClick && (
        <mesh onClick={e => { if (!isTap(e)) return; e.stopPropagation(); onClick() }}
          onPointerOver={() => { document.body.style.cursor = 'pointer' }} onPointerOut={() => { document.body.style.cursor = '' }}>
          <sphereGeometry args={[4.6, 12, 12]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}
    </group>
  )
}

function asPublic(goals: Goal[]): PublicGoal[] {
  return goals.filter(g => g.public !== false).map(g => ({
    id: g.id, title: g.title, status: g.status ?? 'ready', brightness: g.brightness,
    milestonesDone: g.milestones.filter(m => m.done).length, milestonesTotal: g.milestones.length,
  }))
}

const DETAIL_WORD: Record<string, string> = {
  motivation: 'Why', on_track: 'On track', obstacle: 'In the way', distraction: 'Distraction', subgoal: 'Sub-goal', action: 'Action',
}

function SkyLegend({ color }: { color: string }) {
  return (
    <div className="sky-legend glass" aria-label="What the stars mean">
      <div className="lg-row"><span className="lg-dot lg-goal" style={{ background: color }} />Your goal</div>
      <div className="lg-row"><span className="lg-dot" style={{ background: color }} />Milestone <span className="lg-hint">lit when done</span></div>
      <div className="lg-row"><span className="lg-dot lg-small" style={{ background: color }} />Sub-goal or action</div>
      <div className="lg-row"><span className="lg-dot lg-small" style={{ background: '#ffd59e' }} />Why it matters</div>
      <div className="lg-row"><span className="lg-dot lg-small" style={{ background: '#8dffc7' }} />What working on it looks like</div>
      <div className="lg-row"><span className="lg-dot lg-small" style={{ background: '#ff8fa3' }} />Obstacle or distraction</div>
    </div>
  )
}

export function Universe({ me, myGoals, bornAt, focusGoalId, forgeIndex, discovering, understanding, view, others,
  myScore, focusing, frame, onPickGoal, onPickPlayer }: Props) {
  const labelEls = useRef(new Map<string, HTMLDivElement>())
  const labels: LabelSpec[] = []
  // Focus mode keeps the sky quiet: only the next milestone is named; any other star shows its name on hover.
  const [hovered, setHovered] = useState<string | null>(null)
  const hoverTargets: { key: string; position: Vec3 }[] = []
  const color = me?.color ?? '#cfe2ff'
  const cosmos = view === 'cosmos'
  const focusIndex = focusGoalId ? myGoals.findIndex(g => g.id === focusGoalId) : -1
  const focusGoal = focusIndex >= 0 ? myGoals[focusIndex] : null

  // Where the camera rests: the focused constellation, all my stars, or the whole cosmos.
  const home = useMemo<Home>(() => {
    if (cosmos) return { center: [0, -2, 0], distance: 112, pitch: 0.42, key: 'cosmos' }
    if (focusGoal && !discovering) return { center: myGoalOrigin(focusIndex), distance: 25, pitch: 0.06, key: `goal:${focusGoal.id}` }
    const pts = myGoals.map((_, i) => myGoalOrigin(i))
    if (discovering) pts.push(myGoalOrigin(forgeIndex))
    if (pts.length === 0) return { center: [0, 0, 0], distance: 20, pitch: 0.06, key: 'empty' }
    const c = pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length, a[2] + p[2] / pts.length], [0, 0, 0]) as Vec3
    const extent = Math.max(...pts.map(p => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2])))
    return { center: c, distance: Math.max(20, extent * 2.6 + 12), pitch: 0.1, key: discovering ? `forge:${forgeIndex}` : 'overview' }
  }, [cosmos, focusGoal?.id, focusIndex, discovering, forgeIndex, myGoals.length]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!cosmos && (!focusGoal || discovering)) {
    myGoals.forEach((g, i) => labels.push({
      key: `mine:${g.id}`, position: add(myGoalOrigin(i), [0, -2.2, 0]), visible: true, onClick: () => onPickGoal?.(g.id),
      title: 'Open this star', node: <span className="star-label-goal-title">{g.title}</span>,
    }))
  }
  if (!cosmos && focusGoal && !discovering) {
    const origin = myGoalOrigin(focusIndex)
    const scale = focusGoal.status === 'brainstorm' ? 0.8 : 1
    const ms = [...focusGoal.milestones].sort((a, b) => a.order - b.order)
    const nextId = ms.find(m => !m.done)?.id
    const mPos = milestonePositions(focusGoal.id, ms.length)
    ms.forEach((m, i) => {
      const key = `m:${m.id}`
      const star = add(origin, [mPos[i][0] * scale, mPos[i][1] * scale, mPos[i][2] * scale])
      hoverTargets.push({ key, position: star })
      labels.push({
        key, position: add(star, [0, -0.85, 0]), visible: key === hovered || m.id === nextId,
        node: <span className={`sky-tag ${m.done ? 'is-done' : ''} ${m.id === nextId ? 'is-next' : ''}`}>{m.id === nextId ? 'Next · ' : ''}{m.title}</span>,
      })
    })
    const details = focusGoal.details ?? []
    details.forEach((d, i) => {
      const key = `d:${d.id}`
      const star = add(origin, detailPosition(i, details.length, scale))
      hoverTargets.push({ key, position: star })
      labels.push({
        key, position: add(star, [0, -0.6, 0]), visible: key === hovered,
        node: <span className="sky-tag is-detail" style={{ ['--tint' as string]: DETAIL_TINT[d.kind] ?? color }}>{DETAIL_WORD[d.kind]} · {d.text}</span>,
      })
    })
  }
  if (cosmos && me) {
    labels.push({
      key: 'me', position: [0, 5.4, 0], visible: myGoals.length > 0,
      node: <>
        <span className="star-label-dot" style={{ background: color, boxShadow: `0 0 10px ${color}` }} />
        <span className="star-label-text"><span className="star-label-name">You<span className="star-label-score">{myScore.toLocaleString()}</span></span></span>
      </>,
    })
  }
  others.forEach((p, k) => labels.push({
    key: `player:${p.id}`, position: add(otherUserOrigin(k + 1, p.id), [0, 5.6, 0]), visible: cosmos, onClick: () => onPickPlayer?.(p.id),
    title: `See ${p.name}'s goals`,
    node: <>
      <span className={`star-label-dot ${p.live ? 'is-live' : ''}`} style={{ background: p.color, boxShadow: `0 0 10px ${p.color}` }} />
      <span className="star-label-text">
        <span className="star-label-name">{p.name}<span className="star-label-score">{p.points.toLocaleString()}</span></span>
        <span className="star-label-goal">{p.goals && p.goals.length > 1 ? `${p.goals.length} goals` : (p.goals?.[0]?.title ?? p.goalTitle ?? '')}</span>
      </span>
    </>,
  }))

  return (
    <>
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
      <CameraRig home={home} frame={frame} autoRotate={cosmos} />

      {/* My sky: focus = one full constellation; overview = one big star per goal. In the cosmos: my public goals. */}
      {!cosmos && focusGoal && !discovering && (
        <Constellation key={focusGoal.id} goal={focusGoal} color={color} origin={myGoalOrigin(focusIndex)} bornAt={bornAt[focusGoal.id]}
          scale={focusGoal.status === 'brainstorm' ? 0.8 : 1} listening pulse={focusing === focusGoal.id} />
      )}
      {!cosmos && (!focusGoal || discovering) && myGoals.map((g, i) => (
        <group key={g.id}>
          <Star position={myGoalOrigin(i)} color={color} brightness={Math.max(0.2, g.brightness)} size={g.status === 'brainstorm' ? 0.75 : 1.1}
            dim={1} seed={i + 1} bornAt={bornAt[g.id]} shockwave={bornAt[g.id] !== undefined} pulse={focusing === g.id} />
          <mesh position={myGoalOrigin(i)} onClick={e => { if (!isTap(e)) return; e.stopPropagation(); onPickGoal?.(g.id) }}
            onPointerOver={() => { document.body.style.cursor = 'pointer' }} onPointerOut={() => { document.body.style.cursor = '' }}>
            <sphereGeometry args={[1.8, 10, 10]} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} />
          </mesh>
        </group>
      ))}
      <Protostar position={myGoalOrigin(forgeIndex)} understanding={understanding} active={discovering && !cosmos} color={color} />

      {cosmos && me && (
        <>
          <GoalStars goals={asPublic(myGoals)} color={color} origin={[0, 0, 0]} dim={1} seed={me.id} pulse={!!focusing} />
        </>
      )}

      {others.map((p, k) => {
        const origin = otherUserOrigin(k + 1, p.id)
        const goals = p.goals && p.goals.length > 0
          ? p.goals
          : [{ id: p.id, brightness: Math.min(1, 0.22 + p.points / 1600), status: 'ready' }]
        return (
          <group key={p.id}>
            <GoalStars goals={goals} color={p.color} origin={origin} dim={cosmos ? 0.95 : 0.35} pulse={p.live} seed={p.id}
              onClick={cosmos ? () => onPickPlayer?.(p.id) : undefined} />
          </group>
        )
      })}

      {hoverTargets.map(t => (
        <mesh key={t.key} position={t.position}
          onPointerOver={e => { e.stopPropagation(); setHovered(t.key) }}
          onPointerOut={() => setHovered(h => (h === t.key ? null : h))}>
          <sphereGeometry args={[0.75, 8, 8]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      ))}
      <Projector specs={labels} els={labelEls} />

      <EffectComposer multisampling={0}>
        <Bloom mipmapBlur intensity={1.25} luminanceThreshold={0.18} luminanceSmoothing={0.35} radius={0.75} />
        <Noise opacity={0.028} />
        <Vignette offset={0.22} darkness={0.78} />
      </EffectComposer>
    </Canvas>
    {!cosmos && focusGoal && !discovering && <SkyLegend color={color} />}
    <div className="label-layer" aria-hidden={false}>
      {labels.map(l => (
        <div key={l.key} className="label-anchor" style={{ visibility: 'hidden' }}
          ref={el => { if (el) labelEls.current.set(l.key, el); else labelEls.current.delete(l.key) }}>
          <div className={`star-label ${l.visible ? 'is-visible' : ''} ${l.onClick ? 'is-clickable' : ''}`}
            onClick={l.visible ? l.onClick : undefined} role={l.onClick ? 'button' : undefined} title={l.title}
            style={{ pointerEvents: l.visible && l.onClick ? 'auto' : 'none' }}>
            {l.node}
          </div>
        </div>
      ))}
    </div>
    </>
  )
}
