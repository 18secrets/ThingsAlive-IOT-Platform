import React, { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { SiteTwinZone } from '../../lib/api';

/**
 * The people and the work on a demo site: workers on their rounds, a tower crane lifting
 * on the building, dust at the quarry face, the batching plant's drum turning, a roller
 * on the road being laid.
 *
 * Simulation, and only ever drawn for the demo tenant (`simulated` on the twin, labelled
 * on screen). Nothing in the platform tracks a person or a crane hook, so a real
 * account's twin never shows any of this: it would be a picture of work nobody observed.
 */

const VEST = ['#f97316', '#facc15', '#f97316', '#84cc16'];

/** A stable pseudo-random sequence, so the crowd does not reshuffle on every render. */
function rng(seed: number) {
  let s = seed % 2147483647 || 1;
  return () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
}

/** One worker: boots, hi-vis vest, helmet — 1.7 m, readable when the camera is close. */
const Worker: React.FC<{ vest: string; helmet: string }> = ({ vest, helmet }) => (
  <group>
    <mesh position={[0, 0.45, 0]} castShadow>
      <boxGeometry args={[0.36, 0.9, 0.24]} />
      <meshStandardMaterial color="#1e3a8a" />
    </mesh>
    <mesh position={[0, 1.15, 0]} castShadow>
      <boxGeometry args={[0.46, 0.55, 0.3]} />
      <meshStandardMaterial color={vest} emissive={vest} emissiveIntensity={0.25} />
    </mesh>
    <mesh position={[0, 1.55, 0]}>
      <sphereGeometry args={[0.15, 10, 8]} />
      <meshStandardMaterial color="#d6a27a" />
    </mesh>
    <mesh position={[0, 1.66, 0]} castShadow>
      <sphereGeometry args={[0.19, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2]} />
      <meshStandardMaterial color={helmet} />
    </mesh>
  </group>
);

interface Round { cx: number; cz: number; rx: number; rz: number; speed: number; phase: number; vest: string; helmet: string; still: boolean }

/** Workers walking loops inside each zone; at the breakdown bay and the gate they stand. */
const Workers: React.FC<{ zones: SiteTwinZone[] }> = ({ zones }) => {
  const rounds = useMemo(() => {
    const out: Round[] = [];
    zones.forEach((z, zi) => {
      if (z.kind === 'road' && (z.progressPct ?? 100) >= 100) return;
      const r = rng(zi * 977 + Math.round(z.x * 13 + z.z * 7));
      const still = z.kind === 'maintenance_workshop' || z.kind === 'gate';
      const n = z.kind === 'gate' ? 1 : Math.max(2, Math.min(7, Math.round((z.widthM * z.depthM) / 220)));
      for (let i = 0; i < n; i += 1) {
        out.push({
          cx: z.x + (r() - 0.5) * z.widthM * 0.5, cz: z.z + (r() - 0.5) * z.depthM * 0.5,
          rx: 1.5 + r() * Math.min(8, z.widthM * 0.25), rz: 1 + r() * Math.min(6, z.depthM * 0.25),
          speed: 0.9 + r() * 0.5, phase: r() * Math.PI * 2,
          vest: VEST[Math.floor(r() * VEST.length)], helmet: r() > 0.8 ? '#ffffff' : '#facc15', still,
        });
      }
    });
    return out;
  }, [zones]);
  const refs = useRef<THREE.Group[]>([]);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    rounds.forEach((w, i) => {
      const g = refs.current[i];
      if (!g) return;
      if (w.still) {
        g.position.set(w.cx, 0, w.cz);
        g.rotation.y = w.phase + 0.3 * Math.sin(t * 0.4 + i);
        return;
      }
      // Walk an ellipse at walking pace: angular speed is speed / mean radius.
      const a = w.phase + (t * w.speed) / ((w.rx + w.rz) / 2);
      g.position.set(w.cx + w.rx * Math.cos(a), Math.abs(Math.sin(t * 8 + i)) * 0.04, w.cz + w.rz * Math.sin(a));
      g.rotation.y = Math.atan2(-w.rz * Math.cos(a), -w.rx * Math.sin(a)) + Math.PI / 2;
    });
  });
  return (
    <group>
      {rounds.map((w, i) => (
        <group key={i} ref={(g) => { if (g) refs.current[i] = g; }}>
          <Worker vest={w.vest} helmet={w.helmet} />
        </group>
      ))}
    </group>
  );
};

/** A tower crane beside the building: its jib slews, the hook rises with a load and drops back. */
const TowerCrane: React.FC<{ zone: SiteTwinZone }> = ({ zone }) => {
  const floors = zone.floors ?? 6;
  const mast = floors * 3.3 + 12;
  const jib = Math.max(22, zone.widthM * 0.9);
  const slew = useRef<THREE.Group>(null);
  const hook = useRef<THREE.Group>(null);
  const x = zone.x + zone.widthM * 0.42; const z = zone.z - zone.depthM * 0.42;
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    if (slew.current) slew.current.rotation.y = 0.9 * Math.sin(t * 0.12) - 0.6;
    if (hook.current) {
      const lift = (Math.sin(t * 0.25) + 1) / 2;
      hook.current.position.set(-jib * (0.45 + 0.3 * Math.sin(t * 0.07)), mast - 3 - (1 - lift) * (mast - 6), 0);
    }
  });
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, mast / 2, 0]} castShadow>
        <boxGeometry args={[1.6, mast, 1.6]} />
        <meshStandardMaterial color="#f59e0b" wireframe={false} />
      </mesh>
      <group ref={slew} position={[0, mast, 0]}>
        <mesh position={[-jib / 2 + 6, 0.6, 0]} castShadow>
          <boxGeometry args={[jib, 1.1, 1.1]} />
          <meshStandardMaterial color="#f59e0b" />
        </mesh>
        <mesh position={[8, 0.3, 0]} castShadow>
          <boxGeometry args={[4, 2, 2.2]} />
          <meshStandardMaterial color="#475569" />
        </mesh>
        <mesh position={[0, 2.2, 0]}>
          <boxGeometry args={[2, 2, 2]} />
          <meshStandardMaterial color="#e2e8f0" />
        </mesh>
        <group ref={hook}>
          <mesh position={[0, -0.4, 0]}>
            <boxGeometry args={[2.4, 0.8, 1.4]} />
            <meshStandardMaterial color="#64748b" />
          </mesh>
        </group>
      </group>
    </group>
  );
};

/** Dust at the quarry face: puffs rising where boulders are being broken. */
const Dust: React.FC<{ zone: SiteTwinZone }> = ({ zone }) => {
  const puffs = useRef<THREE.Mesh[]>([]);
  const seeds = useMemo(() => Array.from({ length: 8 }, (_, i) => ({
    x: zone.x + (((i * 37) % 10) / 10 - 0.5) * zone.widthM * 0.7,
    z: zone.z - zone.depthM * 0.15 + (((i * 53) % 10) / 10 - 0.5) * zone.depthM * 0.3,
    p: i / 8,
  })), [zone]);
  useFrame(({ clock }) => {
    seeds.forEach((s, i) => {
      const m = puffs.current[i];
      if (!m) return;
      const t = (clock.elapsedTime * 0.25 + s.p) % 1;
      m.position.set(s.x + t * 2, 0.5 + t * 7, s.z);
      m.scale.setScalar(1 + t * 3);
      (m.material as THREE.MeshBasicMaterial).opacity = 0.35 * (1 - t);
    });
  });
  return (
    <group>
      {seeds.map((_, i) => (
        <mesh key={i} ref={(m) => { if (m) puffs.current[i] = m; }}>
          <sphereGeometry args={[1, 10, 8]} />
          <meshBasicMaterial color="#d6c2a1" transparent opacity={0.3} depthWrite={false} />
        </mesh>
      ))}
    </group>
  );
};

/** The batching plant's mixer drum turning beside the tower. */
const Mixer: React.FC<{ zone: SiteTwinZone }> = ({ zone }) => {
  const drum = useRef<THREE.Mesh>(null);
  useFrame((_, dt) => { if (drum.current) drum.current.rotation.x += dt * 1.6; });
  return (
    <mesh ref={drum} position={[zone.x + zone.widthM * 0.12, 3, zone.z + zone.depthM * 0.32]} rotation={[0, 0, Math.PI / 2]} castShadow>
      <cylinderGeometry args={[1.4, 1.8, 4.5, 12]} />
      <meshStandardMaterial color="#e5e7eb" flatShading />
    </mesh>
  );
};

/** A roller working the face of a road section being laid: back and forth across it. */
const Roller: React.FC<{ zone: SiteTwinZone }> = ({ zone }) => {
  const ref = useRef<THREE.Group>(null);
  const alongX = zone.widthM >= zone.depthM;
  const L = alongX ? zone.widthM : zone.depthM;
  const face = -L / 2 + L * ((zone.progressPct ?? 0) / 100);
  useFrame(({ clock }) => {
    if (!ref.current) return;
    const s = face - 6 + 5 * Math.sin(clock.elapsedTime * 0.35);
    ref.current.position.set(alongX ? zone.x + s : zone.x, 0, alongX ? zone.z : zone.z + s);
  });
  return (
    <group ref={ref} rotation={[0, alongX ? 0 : Math.PI / 2, 0]}>
      <mesh position={[1.4, 0.75, 0]} rotation={[Math.PI / 2, 0, 0]} castShadow>
        <cylinderGeometry args={[0.75, 0.75, 2.1, 16]} />
        <meshStandardMaterial color="#475569" />
      </mesh>
      <mesh position={[-0.6, 1.1, 0]} castShadow>
        <boxGeometry args={[2.6, 1.2, 1.9]} />
        <meshStandardMaterial color="#facc15" />
      </mesh>
      <mesh position={[-0.9, 2.1, 0]} castShadow>
        <boxGeometry args={[1.1, 0.9, 1.3]} />
        <meshStandardMaterial color="#1f2937" />
      </mesh>
    </group>
  );
};

const SiteLife: React.FC<{ zones: SiteTwinZone[] }> = ({ zones }) => (
  <group>
    <Workers zones={zones} />
    {zones.filter((z) => z.kind === 'building' && (z.progressPct ?? 0) < 100).map((z) => <TowerCrane key={z.key} zone={z} />)}
    {zones.filter((z) => z.kind === 'quarry').map((z) => <Dust key={z.key} zone={z} />)}
    {zones.filter((z) => z.kind === 'batching_plant').map((z) => <Mixer key={z.key} zone={z} />)}
    {zones.filter((z) => z.kind === 'road' && (z.progressPct ?? 100) > 0 && (z.progressPct ?? 100) < 100).map((z) => <Roller key={z.key} zone={z} />)}
  </group>
);

export default SiteLife;
