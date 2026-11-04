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

interface Hand { cx: number; cz: number; y: number; rx: number; rz: number; speed: number; phase: number; walks: boolean }

const VEST_COLOURS = VEST.map((c) => new THREE.Color(c));
const SKIN = ['#c68e6a', '#a8714f', '#8d5a3b', '#d4a07c'].map((c) => new THREE.Color(c));
type Part = 'legL' | 'legR' | 'torso' | 'armL' | 'armR' | 'head' | 'helmet' | 'brim';
const PARTS: Part[] = ['legL', 'legR', 'torso', 'armL', 'armR', 'head', 'helmet', 'brim'];
const HELMETS = [new THREE.Color('#facc15'), new THREE.Color('#ffffff'), new THREE.Color('#facc15')];

/**
 * The workforce, as one instanced crowd so a big site can carry hundreds: about half walk
 * their rounds, the rest work where they stand — bending to the job and straightening, as
 * a man tying rebar or swinging a hammer does. Denser where the work is: the building, the
 * quarry, the road face; a few at the offices and the gate; a handful at the bay.
 */
const Workers: React.FC<{ zones: SiteTwinZone[] }> = ({ zones }) => {
  const hands = useMemo(() => {
    const out: Hand[] = [];
    zones.forEach((z, zi) => {
      if (z.kind === 'road' && ((z.progressPct ?? 100) >= 100 || (z.progressPct ?? 0) <= 0)) return;
      const r = rng(zi * 977 + Math.round(z.x * 13 + z.z * 7) + 11);
      const dense = ['building', 'quarry', 'work_area', 'batching_plant', 'road', 'substation', 'quay'].includes(z.kind);
      // Calm enough to read: a crew at each front, not confetti across the site.
      const per = dense ? 70 : z.kind === 'gate' ? 400 : 260;
      const n = Math.max(2, Math.min(dense ? 60 : 6, Math.round((z.widthM * z.depthM) / per)));
      // On a building the crew is up on the slab being cast, inside its footprint.
      const onSlab = z.kind === 'building';
      const y = onSlab ? (z.floors ?? 4) * 3.3 * ((z.progressPct ?? 0) / 100) + 0.3 : 0;
      const spread = onSlab ? 0.6 : 0.85;
      for (let i = 0; i < n; i += 1) {
        const walks = r() < (dense ? 0.4 : 0.7);
        out.push({
          cx: z.x + (r() - 0.5) * z.widthM * spread, cz: z.z + (r() - 0.5) * z.depthM * spread, y,
          rx: walks ? 1.5 + r() * Math.min(onSlab ? 4 : 8, z.widthM * 0.15) : 0, rz: walks ? 1 + r() * Math.min(onSlab ? 3 : 6, z.depthM * 0.15) : 0,
          speed: 0.9 + r() * 0.5, phase: r() * Math.PI * 2, walks,
        });
      }
    });
    return out.slice(0, 3000);
  }, [zones]);

  // One instanced mesh per body part. Each part is placed from the worker's root by its
  // own joint (hip, shoulder), so a walker swings legs and arms and a worker at the job
  // bends at the hips with arms working — a person, not a post.
  const parts = useRef<Record<Part, THREE.InstancedMesh | null>>({} as Record<Part, THREE.InstancedMesh | null>);
  React.useLayoutEffect(() => {
    hands.forEach((_, i) => {
      parts.current.torso?.setColorAt(i, VEST_COLOURS[i % VEST_COLOURS.length]);
      parts.current.helmet?.setColorAt(i, HELMETS[i % HELMETS.length]);
      parts.current.brim?.setColorAt(i, HELMETS[i % HELMETS.length]);
      parts.current.head?.setColorAt(i, SKIN[i % SKIN.length]);
    });
    for (const k of ['torso', 'helmet', 'brim', 'head'] as Part[]) {
      const m = parts.current[k];
      if (m?.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }, [hands]);

  const root = useMemo(() => new THREE.Matrix4(), []);
  const work = useMemo(() => ({ a: new THREE.Matrix4(), b: new THREE.Matrix4(), q: new THREE.Quaternion(), e: new THREE.Euler(), v: new THREE.Vector3(), one: new THREE.Vector3(1, 1, 1) }), []);
  /** root · translate(joint) · rotate(x, z) · translate(offset), into `out`. */
  const place = (out: THREE.Matrix4, joint: [number, number, number], rx: number, rz: number, offset: [number, number, number]) => {
    work.e.set(rx, 0, rz);
    work.q.setFromEuler(work.e);
    work.a.compose(work.v.set(...joint), work.q, work.one);
    work.b.makeTranslation(...offset);
    out.copy(root).multiply(work.a).multiply(work.b);
  };

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const m = new THREE.Matrix4();
    hands.forEach((w, i) => {
      let x = w.cx; let z = w.cz; let yaw = w.phase; let bend = 0; let swing = 0; let armWork = 0;
      if (w.walks) {
        const a = w.phase + (t * w.speed) / ((w.rx + w.rz) / 2);
        x = w.cx + w.rx * Math.cos(a); z = w.cz + w.rz * Math.sin(a);
        // The figure faces +X; turn it to face where it is walking.
        yaw = Math.atan2(-(w.rz * Math.cos(a)), -w.rx * Math.sin(a));
        swing = 0.55 * Math.sin(t * 6 * w.speed + w.phase);
      } else {
        // At the job: bend forward and straighten, arms swinging down to the work.
        const k = Math.max(0, Math.sin(t * 2.2 + w.phase));
        bend = 0.7 * k; armWork = 0.6 + 0.9 * k;
      }
      work.e.set(0, yaw, 0); work.q.setFromEuler(work.e);
      root.compose(work.v.set(x, w.y, z), work.q, work.one);
      const P = parts.current;
      // Legs from the hips, swinging opposite each other.
      // Swing about Z: the figure faces +X, so that is forward and back.
      place(m, [0, 0.9, 0.11], 0, swing, [0, -0.45, 0]); P.legL?.setMatrixAt(i, m);
      place(m, [0, 0.9, -0.11], 0, -swing, [0, -0.45, 0]); P.legR?.setMatrixAt(i, m);
      // The upper body pivots at the hips; arms, head and hat ride on it.
      const upper = new THREE.Matrix4();
      place(upper, [0, 0.9, 0], 0, -bend, [0, 0, 0]);
      const onUpper = (joint: [number, number, number], rx: number, rz: number, offset: [number, number, number]) => {
        work.e.set(rx, 0, rz); work.q.setFromEuler(work.e);
        work.a.compose(work.v.set(...joint), work.q, work.one);
        work.b.makeTranslation(...offset);
        return m.copy(upper).multiply(work.a).multiply(work.b);
      };
      P.torso?.setMatrixAt(i, onUpper([0, 0.33, 0], 0, 0, [0, 0, 0]));
      P.armL?.setMatrixAt(i, onUpper([0, 0.6, 0.27], 0, -swing + armWork, [0, -0.3, 0]));
      P.armR?.setMatrixAt(i, onUpper([0, 0.6, -0.27], 0, swing + armWork, [0, -0.3, 0]));
      P.head?.setMatrixAt(i, onUpper([0, 0.82, 0], 0, 0, [0, 0, 0]));
      P.helmet?.setMatrixAt(i, onUpper([0, 0.93, 0], 0, 0, [0, 0, 0]));
      P.brim?.setMatrixAt(i, onUpper([0, 0.9, 0], 0, 0, [0, 0, 0]));
    });
    for (const k of PARTS) { const mesh = parts.current[k]; if (mesh) mesh.instanceMatrix.needsUpdate = true; }
  });

  if (!hands.length) return null;
  const n = hands.length;
  const set = (k: Part) => (mesh: THREE.InstancedMesh | null) => { parts.current[k] = mesh; };
  return (
    <group>
      {/* Legs: work trousers to the boot. */}
      <instancedMesh ref={set('legL')} args={[undefined, undefined, n]} castShadow>
        <boxGeometry args={[0.17, 0.9, 0.17]} />
        <meshStandardMaterial color="#1e3a5f" />
      </instancedMesh>
      <instancedMesh ref={set('legR')} args={[undefined, undefined, n]} castShadow>
        <boxGeometry args={[0.17, 0.9, 0.17]} />
        <meshStandardMaterial color="#1e3a5f" />
      </instancedMesh>
      {/* Torso in a hi-vis vest. */}
      <instancedMesh ref={set('torso')} args={[undefined, undefined, n]} castShadow>
        <boxGeometry args={[0.28, 0.66, 0.46]} />
        <meshStandardMaterial roughness={0.6} />
      </instancedMesh>
      {/* Arms, sleeves in work blue, from the shoulders. */}
      <instancedMesh ref={set('armL')} args={[undefined, undefined, n]} castShadow>
        <boxGeometry args={[0.12, 0.62, 0.12]} />
        <meshStandardMaterial color="#2b4c7e" />
      </instancedMesh>
      <instancedMesh ref={set('armR')} args={[undefined, undefined, n]} castShadow>
        <boxGeometry args={[0.12, 0.62, 0.12]} />
        <meshStandardMaterial color="#2b4c7e" />
      </instancedMesh>
      <instancedMesh ref={set('head')} args={[undefined, undefined, n]} castShadow>
        <sphereGeometry args={[0.13, 12, 10]} />
        <meshStandardMaterial roughness={0.8} />
      </instancedMesh>
      {/* Hard hat: dome and brim. */}
      <instancedMesh ref={set('helmet')} args={[undefined, undefined, n]} castShadow>
        <sphereGeometry args={[0.16, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshStandardMaterial roughness={0.4} />
      </instancedMesh>
      <instancedMesh ref={set('brim')} args={[undefined, undefined, n]}>
        <cylinderGeometry args={[0.2, 0.2, 0.025, 14]} />
        <meshStandardMaterial roughness={0.4} />
      </instancedMesh>
    </group>
  );
};

/**
 * The port beyond the north fence: water, a quay with container stacks, a container ship
 * alongside, and ship-to-shore cranes working it — a trolley running out over the ship
 * and back with a box. Scenery for the demo, outside the site and labelled with it.
 */
// Weathered shipping colours, not a rainbow: the eye should go to the work, not the boxes.
const PORT_BOX = ['#9f4a3c', '#3f6e8f', '#5f7f5a', '#b8893f', '#4f7c86', '#7a8691', '#8a5a44', '#56606b'];
export const Port: React.FC<{ widthM: number; depthM: number }> = ({ widthM, depthM }) => {
  const edge = -depthM / 2;
  const quayD = 28;
  const quayZ = edge - 6 - quayD / 2;
  const shipZ = edge - 6 - quayD - 16;
  const shipL = Math.min(widthM * 0.8, 180);
  const cranes = Math.max(2, Math.min(4, Math.floor(shipL / 45)));
  const trolleys = useRef<THREE.Group[]>([]);
  const boxes = useMemo(() => {
    const out: { x: number; y: number; z: number; c: string }[] = [];
    const r = rng(Math.round(widthM * 31));
    // Containers on deck, in bays across the ship.
    for (let bx = 0; bx < Math.floor(shipL / 7) - 2; bx += 1) {
      for (let row = 0; row < 4; row += 1) {
        const tiers = 1 + Math.floor(r() * 3);
        for (let tier = 0; tier < tiers; tier += 1) {
          out.push({ x: -shipL / 2 + 10 + bx * 7, y: 4.5 + tier * 2.6, z: shipZ - 4.5 + row * 3, c: PORT_BOX[Math.floor(r() * PORT_BOX.length)] });
        }
      }
    }
    // Stacks on the quay apron, behind the crane legs.
    for (let bx = 0; bx < Math.floor((widthM - 20) / 7); bx += 1) {
      if (r() < 0.35) continue;
      const tiers = 1 + Math.floor(r() * 3);
      for (let tier = 0; tier < tiers; tier += 1) {
        out.push({ x: -widthM / 2 + 12 + bx * 7, y: 1.3 + tier * 2.6, z: quayZ + 8 + (bx % 2) * 3, c: PORT_BOX[Math.floor(r() * PORT_BOX.length)] });
      }
    }
    return out;
  }, [widthM, shipL, shipZ, quayZ]);
  useFrame(({ clock }) => {
    trolleys.current.forEach((g, i) => {
      if (!g) return;
      // Out over the ship and back, lowering at each end.
      const t = clock.elapsedTime * 0.12 + i * 0.37;
      const f = (Math.sin(t * Math.PI * 2) + 1) / 2;
      g.position.set(0, 0, -6 - f * 30);
      const hoist = g.children[1] as THREE.Object3D | undefined;
      if (hoist) hoist.position.y = -6 - 10 * Math.pow(Math.abs(Math.cos(t * Math.PI * 2)), 4);
    });
  });
  return (
    <group>
      {/* Above the grass (which sits at -0.08 and runs out under everything), so the
          sea is not hidden by the land around the sites. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, edge - 6 - quayD - 130]}>
        <planeGeometry args={[widthM * 8, 260]} />
        <meshStandardMaterial color="#2b7fb5" roughness={0.35} metalness={0.1} />
      </mesh>
      <mesh position={[0, 0.6, quayZ]} receiveShadow>
        <boxGeometry args={[widthM + 40, 1.4, quayD]} />
        <meshStandardMaterial color="#c8c3b8" />
      </mesh>
      {/* The ship: hull, superstructure aft. */}
      <mesh position={[0, 1.2, shipZ]} castShadow>
        <boxGeometry args={[shipL, 6, 16]} />
        <meshStandardMaterial color="#1e3a5f" />
      </mesh>
      <mesh position={[0, -1.4, shipZ]}>
        <boxGeometry args={[shipL + 0.2, 1.2, 16.2]} />
        <meshStandardMaterial color="#9f1239" />
      </mesh>
      <mesh position={[shipL / 2 - 10, 10, shipZ]} castShadow>
        <boxGeometry args={[10, 12, 14]} />
        <meshStandardMaterial color="#f8fafc" />
      </mesh>
      {boxes.map((b, i) => (
        <mesh key={i} position={[b.x, b.y, b.z]} castShadow>
          <boxGeometry args={[6.1, 2.5, 2.4]} />
          <meshStandardMaterial color={b.c} />
        </mesh>
      ))}
      {/* Ship-to-shore cranes on the quay edge. */}
      {Array.from({ length: cranes }, (_, i) => {
        const x = -shipL / 2 + (shipL / (cranes + 1)) * (i + 1) - 10;
        return (
          <group key={i} position={[x, 0, quayZ - quayD / 2 + 4]}>
            {[[-5, 0], [5, 0], [-5, 14], [5, 14]].map(([lx, lz], k) => (
              <mesh key={k} position={[lx, 14, lz]} castShadow>
                <boxGeometry args={[1, 28, 1]} />
                <meshStandardMaterial color="#c2410c" />
              </mesh>
            ))}
            <mesh position={[0, 28.5, -10]} castShadow>
              <boxGeometry args={[11, 1.4, 52]} />
              <meshStandardMaterial color="#c2410c" />
            </mesh>
            <group position={[0, 27.6, 0]} ref={(g) => { if (g) trolleys.current[i] = g; }}>
              <mesh>
                <boxGeometry args={[4, 1.2, 3]} />
                <meshStandardMaterial color="#334155" />
              </mesh>
              <mesh position={[0, -6, 0]} castShadow>
                <boxGeometry args={[6.1, 2.5, 2.4]} />
                <meshStandardMaterial color={PORT_BOX[i % PORT_BOX.length]} />
              </mesh>
            </group>
          </group>
        );
      })}
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

const SiteLife: React.FC<{ zones: SiteTwinZone[]; extent: { widthM: number; depthM: number }; withPort?: boolean }> = ({ zones, extent, withPort = true }) => (
  <group>
    {withPort && <Port widthM={extent.widthM} depthM={extent.depthM} />}
    <Workers zones={zones} />
    {zones.filter((z) => z.kind === 'building' && (z.progressPct ?? 0) < 100).map((z) => <TowerCrane key={z.key} zone={z} />)}
    {zones.filter((z) => z.kind === 'quarry').map((z) => <Dust key={z.key} zone={z} />)}
    {zones.filter((z) => z.kind === 'batching_plant').map((z) => <Mixer key={z.key} zone={z} />)}
    {zones.filter((z) => z.kind === 'road' && (z.progressPct ?? 100) > 0 && (z.progressPct ?? 100) < 100).map((z) => <Roller key={z.key} zone={z} />)}
  </group>
);

export default SiteLife;
