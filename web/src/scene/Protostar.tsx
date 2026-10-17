import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { dotTexture, glowTexture, rng } from './textures'
import type { Vec3 } from './layout'
import { voiceLevel } from '../voice'

const COUNT = 1400

/**
 * A cloud of faint dust that slowly gathers as the agent understands the goal.
 * At understanding 0 it is almost invisible; near 1 it is a tight, glowing swirl.
 * When `active` turns false it collapses into its centre (the star is born there).
 */
export function Protostar({ position, understanding, active, color }: {
  position: Vec3; understanding: number; active: boolean; color: string
}) {
  const points = useRef<THREE.Points>(null)
  const glow = useRef<THREE.Sprite>(null)
  const u = useRef(0)
  const life = useRef(0)
  const tint = useMemo(() => new THREE.Color(color), [color])

  const { base, positions, colors } = useMemo(() => {
    const rand = rng(7)
    const base = new Float32Array(COUNT * 4) // radius, angle, height, speed
    const positions = new Float32Array(COUNT * 3)
    const colors = new Float32Array(COUNT * 3)
    for (let i = 0; i < COUNT; i++) {
      const r = 1 + Math.pow(rand(), 0.7) * 9
      base[i * 4] = r
      base[i * 4 + 1] = rand() * Math.PI * 2
      base[i * 4 + 2] = (rand() - 0.5) * (0.6 + r * 0.18)
      base[i * 4 + 3] = (0.35 + rand() * 0.3) / Math.sqrt(r)
      const warm = rand()
      colors[i * 3] = 0.75 + warm * 0.25
      colors[i * 3 + 1] = 0.8 + warm * 0.12
      colors[i * 3 + 2] = 1
    }
    return { base, positions, colors }
  }, [])

  useFrame((state, dt) => {
    const k = Math.min(1, dt * 1.4)
    u.current += (understanding - u.current) * k
    life.current += ((active ? 1 : 0) - life.current) * Math.min(1, dt * (active ? 0.8 : 3.2))
    const t = state.clock.elapsedTime
    const contract = (1 - 0.82 * u.current) * life.current
    const arr = positions
    for (let i = 0; i < COUNT; i++) {
      const r = base[i * 4] * contract
      const a = base[i * 4 + 1] + t * base[i * 4 + 3] * (1 + u.current * 2.5)
      arr[i * 3] = Math.cos(a) * r
      arr[i * 3 + 1] = base[i * 4 + 2] * contract * (1 - u.current * 0.5)
      arr[i * 3 + 2] = Math.sin(a) * r
    }
    const geo = points.current?.geometry
    if (geo) geo.attributes.position.needsUpdate = true
    const mat = points.current?.material as THREE.PointsMaterial | undefined
    if (mat) {
      mat.opacity = (0.06 + u.current * 0.7) * life.current
      mat.size = 0.05 + u.current * 0.05
      mat.color.copy(tint).lerp(new THREE.Color('#ffffff'), 0.6).multiplyScalar(1 + u.current * 1.5)
    }
    // While the user talks, the cloud breathes with their voice.
    const v = voiceLevel.current * life.current
    if (mat) mat.opacity = Math.min(1, mat.opacity + v * 0.5)
    if (glow.current) {
      const g = Math.max(u.current * u.current, v * 0.6) * life.current
      glow.current.scale.setScalar(0.6 + g * 3.2 + Math.sin(t * 2.2) * 0.08 * g)
      glow.current.material.opacity = g * 0.55
    }
  })

  return (
    <group position={position} rotation={[0.35, 0, 0.12]}>
      <points ref={points}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[positions, 3]} />
          <bufferAttribute attach="attributes-color" args={[colors, 3]} />
        </bufferGeometry>
        <pointsMaterial map={dotTexture()} vertexColors transparent depthWrite={false}
          blending={THREE.AdditiveBlending} sizeAttenuation toneMapped={false} opacity={0} />
      </points>
      <sprite ref={glow}>
        <spriteMaterial map={glowTexture()} color={tint} transparent depthWrite={false}
          blending={THREE.AdditiveBlending} toneMapped={false} opacity={0} />
      </sprite>
    </group>
  )
}
