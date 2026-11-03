import React, { useMemo } from 'react';
import * as THREE from 'three';
import type { SiteTwinZone } from '../../lib/api';

/**
 * The site's structures, drawn from boxes and cylinders inside each zone's own
 * rectangle — a head office is as big as the admin drew it, not a fixed prop.
 *
 * Progress is drawn only from what the site reported (`progressPct`). Where nothing was
 * reported the structure is a pale outline of what is planned, never a finished
 * building: a twin shown to an inspector must not complete work that is not done.
 */

type Kind = SiteTwinZone['kind'];
const CONCRETE = '#a8a29e';
const STEEL = '#475569';
const PLANNED = '#cbd5e1';

/** A stable small number from a string, so a container yard's colours and a site
 * office's cabins do not reshuffle on every render. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return Math.abs(h);
}

const B: React.FC<{ p: [number, number, number]; s: [number, number, number]; c: string; o?: number; cast?: boolean }> = ({ p, s, c, o, cast = true }) => (
  <mesh position={p} castShadow={cast} receiveShadow>
    <boxGeometry args={s} />
    <meshStandardMaterial color={c} transparent={o !== undefined} opacity={o ?? 1} />
  </mesh>
);

const Cyl: React.FC<{ p: [number, number, number]; r: number; h: number; c: string; r2?: number }> = ({ p, r, h, c, r2 }) => (
  <mesh position={p} castShadow receiveShadow>
    <cylinderGeometry args={[r, r2 ?? r, h, 20]} />
    <meshStandardMaterial color={c} />
  </mesh>
);

/** Ghost of the planned volume, wireframe on a faint fill. */
const Planned: React.FC<{ w: number; d: number; h: number }> = ({ w, d, h }) => {
  const edges = useMemo(() => new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d)), [w, d, h]);
  return (
    <group position={[0, h / 2, 0]}>
      <mesh><boxGeometry args={[w, h, d]} /><meshBasicMaterial color={PLANNED} transparent opacity={0.12} depthWrite={false} /></mesh>
      <lineSegments geometry={edges}><lineBasicMaterial color="#64748b" transparent opacity={0.6} /></lineSegments>
    </group>
  );
};

const HeadOffice: React.FC<{ w: number; d: number }> = ({ w, d }) => {
  const floors = 3; const fh = 3.6;
  return (
    <group>
      {Array.from({ length: floors }, (_, i) => (
        <group key={i}>
          <B p={[0, i * fh + fh / 2, 0]} s={[w * 0.8, fh * 0.7, d * 0.7]} c="#60a5fa" o={0.85} />
          <B p={[0, i * fh + fh - 0.15, 0]} s={[w * 0.84, 0.3, d * 0.74]} c="#f1f5f9" />
        </group>
      ))}
      <B p={[0, floors * fh + 0.4, 0]} s={[w * 0.3, 0.8, d * 0.3]} c="#e2e8f0" />
      <B p={[w * 0.42, 0.6, 0]} s={[0.3, 1.2, d * 0.3]} c="#1e3a8a" />
    </group>
  );
};

const SiteOffice: React.FC<{ w: number; d: number; seed: number }> = ({ w, d, seed }) => {
  // Portacabins: 6 m x 2.5 m units in a row, as many as fit, stacked two high if wide.
  const n = Math.max(1, Math.min(6, Math.floor((w * 0.9) / 6.4)));
  const two = d >= 8 && seed % 2 === 0;
  return (
    <group>
      {Array.from({ length: n }, (_, i) => {
        const x = (i - (n - 1) / 2) * 6.4;
        return (
          <group key={i} position={[x, 0, 0]}>
            <B p={[0, 1.35, 0]} s={[6, 2.6, 2.5]} c="#f8fafc" />
            <B p={[0, 2.7, 0]} s={[6.1, 0.12, 2.6]} c="#0f766e" />
            <B p={[0, 1.4, 1.26]} s={[1.4, 0.8, 0.05]} c="#38bdf8" cast={false} />
            {two && <B p={[0, 4.05, 0]} s={[6, 2.6, 2.5]} c="#f8fafc" />}
            {two && <B p={[0, 5.4, 0]} s={[6.1, 0.12, 2.6]} c="#0f766e" />}
          </group>
        );
      })}
    </group>
  );
};

const BatchingPlant: React.FC<{ w: number; d: number }> = ({ w, d }) => {
  const silos = Math.max(2, Math.min(4, Math.floor(w / 6)));
  return (
    <group>
      {/* Cement silos on legs, with a cone at the bottom. */}
      {Array.from({ length: silos }, (_, i) => {
        const x = -w * 0.3 + i * 3.6;
        return (
          <group key={i} position={[x, 0, -d * 0.2]}>
            <Cyl p={[0, 13, 0]} r={1.5} h={12} c="#e5e7eb" />
            <Cyl p={[0, 6.2, 0]} r={0.25} h={1.6} c="#e5e7eb" r2={1.5} />
            {[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([a, b], k) => <B key={k} p={[a, 3, b]} s={[0.2, 6, 0.2]} c={STEEL} />)}
          </group>
        );
      })}
      {/* Mixer tower, the conveyor up to it, and the aggregate bins. */}
      <B p={[w * 0.12, 5, 0]} s={[4, 10, 4]} c="#f59e0b" />
      <B p={[w * 0.12, 10.5, 0]} s={[4.4, 1, 4.4]} c="#334155" />
      <mesh position={[w * 0.3, 4, d * 0.1]} rotation={[0, 0, -0.55]} castShadow>
        <boxGeometry args={[12, 0.6, 1.2]} />
        <meshStandardMaterial color={STEEL} />
      </mesh>
      {[0, 1, 2].map((i) => (
        <B key={i} p={[w * 0.38 - i * 0.1, 1.5, d * 0.3 - i * 3.2]} s={[3, 3, 3]} c={['#a16207', '#78716c', '#d6d3d1'][i]} />
      ))}
    </group>
  );
};

const Workshop: React.FC<{ w: number; d: number }> = ({ w, d }) => {
  const sw = w * 0.85; const sd = d * 0.75; const h = 6;
  return (
    <group>
      <B p={[0, h / 2, -sd / 2 + 0.2]} s={[sw, h, 0.3]} c="#94a3b8" />
      <B p={[-sw / 2, h / 2, 0]} s={[0.3, h, sd]} c="#94a3b8" />
      <B p={[sw / 2, h / 2, 0]} s={[0.3, h, sd]} c="#94a3b8" />
      {/* Open-fronted bays: roof on posts, so the machine inside is visible. */}
      {[-1, 1].map((sgn) => (
        <mesh key={sgn} position={[0, h + 1, (sgn * sd) / 4]} rotation={[sgn * 0.25, 0, 0]} castShadow>
          <boxGeometry args={[sw + 1, 0.2, sd / 2 + 0.6]} />
          <meshStandardMaterial color="#b91c1c" />
        </mesh>
      ))}
      {(() => {
        const posts = Math.max(2, Math.floor(sw / 8)) + 1;
        return Array.from({ length: posts }, (_, i) => (
          <B key={i} p={[-sw / 2 + (i * sw) / (posts - 1), h / 2, sd / 2]} s={[0.3, h, 0.3]} c={STEEL} />
        ));
      })()}
      <B p={[sw * 0.3, 0.6, sd / 2 + 2]} s={[2, 1.2, 1]} c="#facc15" />
    </group>
  );
};

const Gate: React.FC<{ w: number; d: number }> = ({ w, d }) => {
  const span = Math.max(w, d) * 0.8;
  const alongX = w >= d;
  return (
    <group rotation={[0, alongX ? 0 : Math.PI / 2, 0]}>
      <B p={[-span / 2, 2.5, 0]} s={[1, 5, 1]} c="#1e3a8a" />
      <B p={[span / 2, 2.5, 0]} s={[1, 5, 1]} c="#1e3a8a" />
      <B p={[0, 5.3, 0]} s={[span + 1, 0.8, 1]} c="#1d4ed8" />
      {/* Boom barrier, red and white, lowered across half the gate. */}
      {Array.from({ length: 6 }, (_, i) => (
        <B key={i} p={[-span / 2 + 0.8 + i * (span / 12), 1.1, 1.2]} s={[span / 12, 0.18, 0.18]} c={i % 2 ? '#ffffff' : '#dc2626'} />
      ))}
      <B p={[span / 2 + 2.2, 1.4, 1.5]} s={[2.2, 2.8, 2.2]} c="#f1f5f9" />
      <B p={[span / 2 + 2.2, 2.9, 1.5]} s={[2.6, 0.2, 2.6]} c="#1e3a8a" />
    </group>
  );
};

/** A road along its long side. Laid asphalt with markings up to the reported progress,
 * graded earth beyond it. */
const Road: React.FC<{ w: number; d: number; progress: number | null }> = ({ w, d, progress }) => {
  const alongX = w >= d;
  const L = alongX ? w : d; const W = alongX ? d : w;
  const laid = progress === null ? 0 : L * progress;
  const dashes = Math.floor(laid / 6);
  return (
    <group rotation={[0, alongX ? 0 : Math.PI / 2, 0]}>
      <B p={[0, 0.1, 0]} s={[L, 0.12, W]} c="#a16207" o={0.75} cast={false} />
      {laid > 0 && <B p={[-L / 2 + laid / 2, 0.2, 0]} s={[laid, 0.12, W]} c="#334155" cast={false} />}
      {Array.from({ length: dashes }, (_, i) => (
        <B key={i} p={[-L / 2 + 3 + i * 6, 0.28, 0]} s={[3, 0.02, 0.2]} c="#f8fafc" cast={false} />
      ))}
      {laid > 0 && laid < L && (
        // Where the asphalt stops: the working face, with cones across it.
        [-1, 0, 1].map((k) => <Cyl key={k} p={[-L / 2 + laid + 0.6, 0.5, (k * W) / 3]} r={0.05} r2={0.3} h={0.8} c="#f97316" />)
      )}
    </group>
  );
};

/** A building rising floor by floor: finished floors in concrete, the floor in progress
 * as columns and scaffold, the rest of the planned height as an outline. */
const Building: React.FC<{ w: number; d: number; floors: number; progress: number | null }> = ({ w, d, floors, progress }) => {
  const fh = 3.3; const bw = w * 0.8; const bd = d * 0.8;
  const done = progress === null ? 0 : progress * floors;
  const full = Math.floor(done);
  const partial = done - full;
  const cols = useMemo(() => {
    const out: [number, number][] = [];
    const nx = Math.max(2, Math.round(bw / 6)); const nz = Math.max(2, Math.round(bd / 6));
    for (let i = 0; i <= nx; i += 1) for (let j = 0; j <= nz; j += 1) {
      if (i === 0 || j === 0 || i === nx || j === nz) out.push([-bw / 2 + (i * bw) / nx, -bd / 2 + (j * bd) / nz]);
    }
    return out;
  }, [bw, bd]);
  return (
    <group>
      <Planned w={bw} d={bd} h={floors * fh} />
      {Array.from({ length: full }, (_, i) => (
        <group key={i}>
          <B p={[0, i * fh + 0.15, 0]} s={[bw, 0.3, bd]} c={CONCRETE} />
          <B p={[0, i * fh + fh / 2 + 0.15, 0]} s={[bw * 0.96, fh - 0.3, bd * 0.96]} c="#d6d3d1" />
        </group>
      ))}
      <B p={[0, full * fh + 0.15, 0]} s={[bw, 0.3, bd]} c={CONCRETE} />
      {partial > 0 && cols.map(([x, z], k) => (
        <B key={k} p={[x, full * fh + (fh * partial) / 2 + 0.3, z]} s={[0.45, fh * partial, 0.45]} c="#78716c" />
      ))}
      {(full > 0 || partial > 0) && (
        // Scaffold on the front face, up to the working level.
        <B p={[0, (full * fh + fh * partial) / 2, bd / 2 + 0.9]} s={[bw, full * fh + fh * partial, 0.12]} c="#f59e0b" o={0.35} cast={false} />
      )}
    </group>
  );
};

const Substation: React.FC<{ w: number; d: number; progress: number | null }> = ({ w, d, progress }) => {
  const bays = Math.max(2, Math.min(5, Math.floor(w / 8)));
  const built = progress === null ? 0 : Math.round(bays * progress);
  return (
    <group>
      <B p={[0, 0.1, 0]} s={[w * 0.95, 0.15, d * 0.95]} c="#d4d4d8" cast={false} />
      {/* Fence. */}
      {[[0, d * 0.47, w * 0.95, 0.08], [0, -d * 0.47, w * 0.95, 0.08], [w * 0.47, 0, 0.08, d * 0.95], [-w * 0.47, 0, 0.08, d * 0.95]].map(([x, z, sx, sz], i) => (
        <B key={i} p={[x, 1.2, z]} s={[sx, 2.4, sz]} c="#64748b" o={0.5} cast={false} />
      ))}
      {Array.from({ length: bays }, (_, i) => {
        const x = -w * 0.35 + (i * w * 0.7) / Math.max(1, bays - 1);
        const isBuilt = i < built;
        return (
          <group key={i} position={[x, 0, 0]}>
            {isBuilt ? (
              <>
                <B p={[0, 1.4, -d * 0.15]} s={[3, 2.8, 2.2]} c="#4b5563" />
                {[-1, 0, 1].map((k) => <Cyl key={k} p={[k * 0.8, 3.4, -d * 0.15]} r={0.12} h={1.2} c="#b45309" />)}
                <B p={[0, 4, d * 0.18]} s={[0.25, 8, 0.25]} c={STEEL} />
                <B p={[0, 8, d * 0.18]} s={[4, 0.25, 0.25]} c={STEEL} />
              </>
            ) : (
              <Planned w={3} d={2.2} h={2.8} />
            )}
          </group>
        );
      })}
    </group>
  );
};

/** A quay: concrete deck along its long side, water off the front, bollards on the edge.
 * The deck is laid up to the reported progress; beyond it, piles only. */
const Quay: React.FC<{ w: number; d: number; progress: number | null }> = ({ w, d, progress }) => {
  const alongX = w >= d;
  const L = alongX ? w : d; const W = alongX ? d : w;
  const laid = progress === null ? 0 : L * progress;
  return (
    <group rotation={[0, alongX ? 0 : Math.PI / 2, 0]}>
      <mesh position={[0, -0.4, W / 2 + 20]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[L + 40, 40]} />
        <meshStandardMaterial color="#38bdf8" transparent opacity={0.8} />
      </mesh>
      {laid > 0 && <B p={[-L / 2 + laid / 2, 0.6, 0]} s={[laid, 1.2, W]} c="#d6d3d1" />}
      {Array.from({ length: Math.floor((L - laid) / 4) }, (_, i) => (
        <Cyl key={i} p={[-L / 2 + laid + 2 + i * 4, 0.3, W / 2 - 1]} r={0.35} h={1.6} c={STEEL} />
      ))}
      {Array.from({ length: Math.floor(laid / 10) }, (_, i) => (
        <Cyl key={`b${i}`} p={[-L / 2 + 5 + i * 10, 1.5, W / 2 - 0.6]} r={0.3} h={0.6} c="#111827" />
      ))}
    </group>
  );
};

const CONTAINER = ['#dc2626', '#2563eb', '#16a34a', '#f59e0b', '#0891b2', '#7c3aed', '#ea580c'];
const ContainerYard: React.FC<{ w: number; d: number; seed: number }> = ({ w, d, seed }) => {
  const rows = Math.max(1, Math.floor(d / 3.4)); const cols = Math.max(1, Math.floor(w / 6.8));
  return (
    <group>
      {Array.from({ length: rows * cols }, (_, k) => {
        const i = k % cols; const j = Math.floor(k / cols);
        const height = ((seed >> (k % 24)) % 3) + 1;
        return Array.from({ length: height }, (_, h) => (
          <B
            key={`${k}-${h}`}
            p={[-w / 2 + 3.4 + i * 6.8, 1.3 + h * 2.6, -d / 2 + 1.7 + j * 3.4]}
            s={[6.1, 2.55, 2.44]}
            c={CONTAINER[(seed + k * 7 + h * 3) % CONTAINER.length]}
          />
        ));
      })}
    </group>
  );
};

/** A ship-to-shore crane: two A-frame legs, the boom out over the water. A structure,
 * not a telemetry machine — a crane with a logger is placed as a machine instead. */
const QuayCrane: React.FC<{ w: number; d: number }> = ({ w, d }) => {
  const alongX = w >= d;
  return (
    <group rotation={[0, alongX ? 0 : Math.PI / 2, 0]}>
      {[-1, 1].map((s) => (
        <group key={s} position={[s * 6, 0, 0]}>
          <B p={[0, 14, -4]} s={[0.8, 28, 0.8]} c="#dc2626" />
          <B p={[0, 14, 4]} s={[0.8, 28, 0.8]} c="#dc2626" />
          <B p={[0, 0.5, 0]} s={[1.2, 1, 10]} c="#334155" />
        </group>
      ))}
      <B p={[0, 28.5, 8]} s={[13, 1.4, 44]} c="#dc2626" />
      <B p={[0, 31, -2]} s={[13, 2.5, 5]} c="#f1f5f9" />
    </group>
  );
};

export const AREA_KINDS: ReadonlySet<Kind> = new Set(['work_area', 'material_yard', 'parking', 'restricted']);

/** The structure for a zone, or null for a flat area. Positioned by the caller. */
export const Structure: React.FC<{ zone: SiteTwinZone }> = ({ zone }) => {
  const w = zone.widthM; const d = zone.depthM;
  const progress = zone.progressPct === null || zone.progressPct === undefined ? null : zone.progressPct / 100;
  const seed = hash(zone.key);
  switch (zone.kind) {
    case 'head_office': return <HeadOffice w={w} d={d} />;
    case 'site_office': return <SiteOffice w={w} d={d} seed={seed} />;
    case 'batching_plant': return <BatchingPlant w={w} d={d} />;
    case 'maintenance_workshop': return <Workshop w={w} d={d} />;
    case 'gate': return <Gate w={w} d={d} />;
    case 'road': return <Road w={w} d={d} progress={progress} />;
    case 'building': return <Building w={w} d={d} floors={zone.floors ?? 4} progress={progress} />;
    case 'substation': return <Substation w={w} d={d} progress={progress} />;
    case 'quay': return <Quay w={w} d={d} progress={progress} />;
    case 'container_yard': return <ContainerYard w={w} d={d} seed={seed} />;
    case 'quay_crane_berth': return <QuayCrane w={w} d={d} />;
    default: return null;
  }
};
