import React, { Suspense, useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { CameraControls, Html, useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import type { SiteTwin, SiteTwinActivity, SiteTwinStatus, SiteTwinZone, SiteZoneKind } from '../../lib/api';
import { AREA_KINDS, Structure } from './SiteStructures';
import SiteLife from './SiteLife';

/**
 * The site's digital twin, drawn. Loaded lazily (SiteTwinCard), so three.js is fetched
 * only by someone who opens a site page.
 *
 * One frame for everything: metres, origin at the site's centre, x east, z south, Y up —
 * the frame the class models are already in, so a model is placed, never rescaled.
 */

export const STATUS_COLOUR: Record<SiteTwinStatus, string> = {
  alert: '#e11d48', live: '#16a34a', no_data: '#f59e0b', blocked: '#7c3aed', not_configured: '#94a3b8',
};

/** Ground colour under each kind. A structure's pad is drawn paler than an area. */
export const ZONE_COLOUR: Record<SiteZoneKind, string> = {
  work_area: '#86efac', material_yard: '#fcd34d', parking: '#c4b5fd', restricted: '#fca5a5',
  head_office: '#bfdbfe', site_office: '#a5f3fc', batching_plant: '#e7e5e4', maintenance_workshop: '#e2e8f0',
  gate: '#cbd5e1', road: '#a8a29e', building: '#e7e5e4', substation: '#d4d4d8', quay: '#bae6fd',
  container_yard: '#e2e8f0', quay_crane_berth: '#bae6fd',
  generator_room: '#e5e7eb', compressor_house: '#e5e7eb', quarry: '#d6a77a',
};

export interface SceneMachine {
  key: string;
  name: string;
  classSlug: string | null;
  status: SiteTwinStatus;
  x: number; z: number; headingDeg: number;
  /** False for a machine drawn in the "not yet placed" lane. */
  placed: boolean;
  activity: SiteTwinActivity;
  /** The points it shuttles between while working, starting from where it is placed. */
  path: [number, number][];
  /** Label of the zone it is engaged at. */
  engagedLabel: string | null;
  breakdown: boolean;
}

export interface SceneFocus { x: number; z: number; widthM: number; depthM: number }

export type DragTarget = { kind: 'machine'; key: string } | { kind: 'zone'; index: number };

export interface SiteTwinSceneProps {
  extent: SiteTwin['extent'];
  zones: SiteTwinZone[];
  machines: SceneMachine[];
  classModels: SiteTwin['classModels'];
  showLabels: boolean;
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  editing: boolean;
  onDrag: (target: DragTarget, x: number, z: number) => void;
  focus: SceneFocus;
  /** Bumped by the toolbar to zoom: +1 in, -1 out, 0 reset. */
  zoomCommand: { n: number; dir: -1 | 0 | 1 };
  autoRotate: boolean;
  /** Demo tenant: animate every machine at a work front, whatever its data says. */
  simulated?: boolean;
}

// Seen from the south and a little east, about 40° above the ground: the long side of a
// site runs across the screen, three faces of every structure show, the ground reads.
const AZIMUTH = 0.12;
const POLAR = 0.86;
const FOV = 35;

/** A zone's name painted on the ground, as a canvas texture — a road marking, not a
 * floating label, and with no font to fetch. */
function useGroundLabel(text: string) {
  const label = useMemo(() => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    const font = 'bold 64px Inter, system-ui, sans-serif';
    ctx.font = font;
    const w = Math.ceil(ctx.measureText(text).width) + 48;
    canvas.width = w; canvas.height = 96;
    ctx.font = font;
    ctx.fillStyle = 'rgba(15, 23, 42, 0.72)';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(text, w / 2, 50);
    const texture = new THREE.CanvasTexture(canvas);
    texture.anisotropy = 4;
    return { texture, aspect: w / 96 };
  }, [text]);
  // A label is redrawn on every keystroke while a zone is renamed; free the old one.
  useEffect(() => () => label.texture.dispose(), [label]);
  return label;
}

const GroundLabel: React.FC<{ text: string; x: number; z: number; maxWidth: number; y?: number }> = ({ text, x, z, maxWidth, y = 0.32 }) => {
  const { texture, aspect } = useGroundLabel(text.toUpperCase());
  // About 5 m tall letters, so a zone name reads at the overview, shrunk to fit its zone.
  const width = Math.min(maxWidth, aspect * 5);
  return (
    <mesh position={[x, y, z]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={2}>
      <planeGeometry args={[width, width / aspect]} />
      <meshBasicMaterial map={texture} transparent depthWrite={false} />
    </mesh>
  );
};

const Zone: React.FC<{ zone: SiteTwinZone; index: number; editing: boolean; onGrab: (t: DragTarget) => void }> = ({ zone, index, editing, onGrab }) => {
  const area = AREA_KINDS.has(zone.kind);
  return (
    <group>
      <mesh
        position={[zone.x, area ? 0.12 : 0.06, zone.z]}
        receiveShadow
        onPointerDown={editing ? (e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); onGrab({ kind: 'zone', index }); } : undefined}
      >
        <boxGeometry args={[zone.widthM, area ? 0.2 : 0.08, zone.depthM]} />
        <meshStandardMaterial color={ZONE_COLOUR[zone.kind]} transparent opacity={area ? 0.85 : 0.7} />
      </mesh>
      {zone.kind === 'restricted' && (
        <lineSegments position={[zone.x, 0.24, zone.z]}>
          <edgesGeometry args={[new THREE.BoxGeometry(zone.widthM, 0.02, zone.depthM)]} />
          <lineBasicMaterial color="#b91c1c" />
        </lineSegments>
      )}
      {!area && <group position={[zone.x, 0, zone.z]}><Structure zone={zone} /></group>}
      {/* Areas carry their name on the ground; a structure's would sit under its walls,
          so it goes on the front edge instead. */}
      <GroundLabel
        text={zone.label}
        x={zone.x}
        z={area || zone.kind === 'road' ? zone.z : zone.z + zone.depthM / 2 + 2.5}
        maxWidth={Math.max(zone.widthM * 0.85, 12)}
        y={zone.kind === 'road' ? 0.4 : 0.32}
      />
    </group>
  );
};

/** The site slab, its perimeter fence and a 10 m grid, so distance reads at a glance. */
const SiteGround: React.FC<{ widthM: number; depthM: number; onEmptyClick: () => void }> = ({ widthM, depthM, onEmptyClick }) => {
  const fence = 1.8;
  const posts = useMemo(() => {
    const out: [number, number][] = [];
    for (let x = -widthM / 2; x <= widthM / 2 + 0.01; x += 10) { out.push([x, -depthM / 2], [x, depthM / 2]); }
    for (let z = -depthM / 2 + 10; z < depthM / 2; z += 10) { out.push([-widthM / 2, z], [widthM / 2, z]); }
    return out;
  }, [widthM, depthM]);
  // Square 10 m cells whatever the site's proportions, so a cell is a unit of distance.
  const grid = useMemo(() => {
    const pts: number[] = [];
    for (let x = -widthM / 2 + 10; x < widthM / 2; x += 10) pts.push(x, 0, -depthM / 2, x, 0, depthM / 2);
    for (let z = -depthM / 2 + 10; z < depthM / 2; z += 10) pts.push(-widthM / 2, 0, z, widthM / 2, 0, z);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return g;
  }, [widthM, depthM]);
  useEffect(() => () => grid.dispose(), [grid]);
  // Trees outside the fence, a stable scatter: the site sits in a landscape, not a void.
  const trees = useMemo(() => {
    const out: { x: number; z: number; h: number; tone: number }[] = [];
    let seed = Math.round(widthM * 7 + depthM * 13);
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const ring = Math.max(widthM, depthM) * 0.45;
    for (let i = 0; i < 90; i += 1) {
      const side = i % 4;
      const along = rnd() - 0.5;
      const out_ = 8 + rnd() * ring;
      const x = side < 2 ? along * (widthM + 2 * ring) : (side === 2 ? -1 : 1) * (widthM / 2 + out_);
      const z = side < 2 ? (side === 0 ? -1 : 1) * (depthM / 2 + out_) : along * (depthM + 2 * ring);
      out.push({ x, z, h: 5 + rnd() * 6, tone: rnd() });
    }
    return out;
  }, [widthM, depthM]);
  return (
    <group>
      {/* Grass beyond the site, wide enough to reach the haze at the horizon. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.08, 0]} receiveShadow>
        <planeGeometry args={[widthM * 12, depthM * 12]} />
        <meshStandardMaterial color="#9cb380" />
      </mesh>
      {/* A worn verge round the fence, where trucks have turned. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.04, 0]} receiveShadow>
        <planeGeometry args={[widthM + 16, depthM + 16]} />
        <meshStandardMaterial color="#c9b48f" />
      </mesh>
      {/* The site floor: graded murram, the dusty laterite of an Indian site. */}
      <mesh position={[0, 0, 0]} receiveShadow onClick={(e) => { if (e.delta < 5) onEmptyClick(); }}>
        <boxGeometry args={[widthM, 0.06, depthM]} />
        <meshStandardMaterial color="#dcc7a1" roughness={1} />
      </mesh>
      <lineSegments position={[0, 0.04, 0]} geometry={grid}>
        <lineBasicMaterial color="#cdb48a" transparent opacity={0.6} />
      </lineSegments>
      {trees.map((t, i) => (
        <group key={i} position={[t.x, 0, t.z]}>
          <mesh position={[0, t.h * 0.2, 0]} castShadow>
            <cylinderGeometry args={[0.25, 0.35, t.h * 0.4, 6]} />
            <meshStandardMaterial color="#6b4f35" />
          </mesh>
          <mesh position={[0, t.h * 0.62, 0]} castShadow>
            <coneGeometry args={[t.h * 0.28, t.h * 0.75, 7]} />
            <meshStandardMaterial color={t.tone > 0.5 ? '#3f7d3a' : '#4d8f45'} flatShading />
          </mesh>
        </group>
      ))}
      {/* Site hoarding: blue along the north edge, which tells which way is up, and
          green-and-white mesh round the rest. */}
      <mesh position={[0, fence / 2, -depthM / 2]} castShadow>
        <boxGeometry args={[widthM, fence, 0.25]} />
        <meshStandardMaterial color="#1d4ed8" />
      </mesh>
      {[[-1, 0], [1, 0]].map(([sx]) => (
        <mesh key={sx} position={[(sx * widthM) / 2, fence / 2, 0]}>
          <boxGeometry args={[0.15, fence, depthM]} />
          <meshStandardMaterial color="#15803d" transparent opacity={0.45} />
        </mesh>
      ))}
      <mesh position={[0, fence / 2, depthM / 2]}>
        <boxGeometry args={[widthM, fence, 0.15]} />
        <meshStandardMaterial color="#15803d" transparent opacity={0.3} />
      </mesh>
      {posts.map(([x, z], i) => (
        <mesh key={i} position={[x, fence / 2 + 0.1, z]}>
          <boxGeometry args={[0.3, fence + 0.2, 0.3]} />
          <meshStandardMaterial color="#e5e7eb" />
        </mesh>
      ))}
    </group>
  );
};

const ClassModel: React.FC<{ url: string }> = ({ url }) => {
  const { scene } = useGLTF(url);
  // One mesh per class, cloned per machine: every machine of the class shares the bytes.
  const clone = useMemo(() => {
    const c = scene.clone(true);
    c.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    return c;
  }, [scene]);
  return <primitive object={clone} />;
};

/** What a machine whose class has no model looks like: a block with a cab, not a
 * pretend excavator. Honest about being a stand-in. */
const StandIn: React.FC<{ colour: string }> = ({ colour }) => (
  <group>
    <mesh position={[0, 1, 0]} castShadow>
      <boxGeometry args={[5, 1.6, 2.4]} />
      <meshStandardMaterial color="#facc15" />
    </mesh>
    <mesh position={[1.4, 2.3, 0]} castShadow>
      <boxGeometry args={[1.6, 1.2, 2]} />
      <meshStandardMaterial color="#334155" />
    </mesh>
    <mesh position={[-0.6, 1.85, 0]}>
      <boxGeometry args={[2.5, 0.1, 2.42]} />
      <meshStandardMaterial color={colour} />
    </mesh>
  </group>
);

const StatusRing: React.FC<{ status: SiteTwinStatus; radius: number; selected: boolean; placed: boolean }> = ({ status, radius, selected, placed }) => {
  const ref = useRef<THREE.Mesh>(null);
  // An alert pulses. Nothing else moves: movement is reserved for what needs a person.
  useFrame(({ clock }) => {
    if (!ref.current) return;
    const s = status === 'alert' ? 1 + 0.12 * Math.sin(clock.elapsedTime * 4) : 1;
    ref.current.scale.set(s, s, 1);
  });
  return (
    <mesh ref={ref} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.3, 0]} renderOrder={3}>
      <ringGeometry args={[radius * 0.82, radius, 48]} />
      <meshBasicMaterial color={selected ? '#0284c7' : STATUS_COLOUR[status]} transparent opacity={placed ? 0.95 : 0.45} depthWrite={false} />
    </mesh>
  );
};

/** Travel speed along an illustrative route, m/s: a loaded tipper on a site road. */
const SPEED = 4;

export const ACTIVITY_LABEL: Record<SiteTwinActivity, string> = {
  productive: 'Working', idle: 'Idling', 'running-unclassified': 'Engine on', off: 'Engine off', unknown: 'No activity data',
};

/** Where along a back-and-forth trip over `path` the machine is after `d` metres, and
 * which way it faces. */
function along(path: [number, number][], d: number): { x: number; z: number; dx: number; dz: number; back: boolean; leg: number } {
  const legs: number[] = [];
  for (let i = 1; i < path.length; i += 1) legs.push(Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
  const one = legs.reduce((a, b) => a + b, 0);
  if (one < 0.01) return { x: path[0][0], z: path[0][1], dx: 1, dz: 0, back: false, leg: 0 };
  let t = d % (2 * one);
  const back = t > one;
  if (back) t = 2 * one - t;
  for (let i = 0; i < legs.length; i += 1) {
    if (t <= legs[i] || i === legs.length - 1) {
      const f = legs[i] ? Math.min(1, t / legs[i]) : 0;
      const [ax, az] = path[i]; const [bx, bz] = path[i + 1];
      const dx = (bx - ax) * (back ? -1 : 1); const dz = (bz - az) * (back ? -1 : 1);
      return { x: ax + (bx - ax) * f, z: az + (bz - az) * f, dx, dz, back, leg: i };
    }
    t -= legs[i];
  }
  return { x: path[0][0], z: path[0][1], dx: 1, dz: 0, back: false, leg: 0 };
}

/** How a working machine of this class moves, from its slug: a generator or compressor
 * stands and exhausts, a piling rig works its mast, everything else slews and shuffles
 * as an excavator, a crane or a pump at work does. Travel is the route's, for any class. */
type Motion = 'exhaust' | 'drill' | 'haul' | 'slew';
const motionOf = (slug: string | null): Motion =>
  /generat|genset|compress/i.test(slug ?? '') ? 'exhaust'
    : /tipper|dumper|truck|transport|haul|transit/i.test(slug ?? '') ? 'haul'
      : /pil(e|ing)|drill|vibro|rig/i.test(slug ?? '') ? 'drill' : 'slew';

/** A mobile crane's lift: a steel beam on a cable from the boom tip, rising and lowering
 * as the crane slews it across. Demo only — nothing reports a hook. */
const CraneLift: React.FC<{ seed: number }> = ({ seed }) => {
  const cable = useRef<THREE.Mesh>(null);
  const load = useRef<THREE.Group>(null);
  const tipX = 7.5; const tipY = 11;
  useFrame(({ clock }) => {
    const t = clock.elapsedTime * 0.3 + seed * 0.01;
    const drop = 3 + 6 * (Math.sin(t) + 1) / 2;
    if (cable.current) { cable.current.scale.y = drop; cable.current.position.set(tipX, tipY - drop / 2, 0); }
    if (load.current) { load.current.position.set(tipX, tipY - drop - 0.3, 0); load.current.rotation.y = 0.6 * Math.sin(t * 0.7); }
  });
  return (
    <group>
      <mesh ref={cable}>
        <cylinderGeometry args={[0.05, 0.05, 1, 4]} />
        <meshBasicMaterial color="#111827" />
      </mesh>
      <group ref={load}>
        <mesh castShadow>
          <boxGeometry args={[5, 0.5, 0.5]} />
          <meshStandardMaterial color="#b45309" />
        </mesh>
        <mesh position={[0, 0.5, 0]}>
          <boxGeometry args={[0.3, 0.5, 0.3]} />
          <meshStandardMaterial color="#facc15" />
        </mesh>
      </group>
    </group>
  );
};

/** A tipper's load: a heap of broken stone in the bed. */
const Load: React.FC<{ visible: React.MutableRefObject<boolean> }> = ({ visible }) => {
  const ref = useRef<THREE.Mesh>(null);
  useFrame(() => { if (ref.current) ref.current.visible = visible.current; });
  return (
    <mesh ref={ref} position={[-1.4, 3.1, 0]} castShadow>
      <coneGeometry args={[1.5, 1.3, 7]} />
      <meshStandardMaterial color="#8d7b68" flatShading />
    </mesh>
  );
};

/** A stable phase per machine, so a fleet on one route is spread along it. */
const phaseOf = (key: string) => {
  let h = 7;
  for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) % 100_003;
  return h;
};

/** Exhaust from a running engine: three puffs rising and thinning, on a loop. */
const Exhaust: React.FC<{ height: number; seed: number }> = ({ height, seed }) => {
  const puffs = useRef<THREE.Mesh[]>([]);
  useFrame(({ clock }) => {
    puffs.current.forEach((p, i) => {
      if (!p) return;
      const t = ((clock.elapsedTime * 0.5 + i / 3 + seed * 0.013) % 1);
      p.position.set(0.4 * Math.sin(t * 5 + i), height + t * 5, 0.3 * t);
      p.scale.setScalar(0.4 + t * 1.4);
      (p.material as THREE.MeshBasicMaterial).opacity = 0.45 * (1 - t);
    });
  });
  return (
    <group>
      {[0, 1, 2].map((i) => (
        <mesh key={i} ref={(m) => { if (m) puffs.current[i] = m; }}>
          <sphereGeometry args={[0.6, 10, 10]} />
          <meshBasicMaterial color="#94a3b8" transparent opacity={0.4} depthWrite={false} />
        </mesh>
      ))}
    </group>
  );
};

const Machine: React.FC<{
  m: SceneMachine; modelUrl: string | null; radius: number; showLabel: boolean; selected: boolean;
  editing: boolean; onSelect: (key: string) => void; onGrab: (t: DragTarget) => void;
  /** 0, 1 or 2: how many steps up its label sits, so neighbours' labels do not stack. */
  lift: number;
  simulated: boolean;
}> = ({ m, modelUrl, radius, showLabel, selected, editing, onSelect, onGrab, lift, simulated }) => {
  const outer = useRef<THREE.Group>(null);
  const body = useRef<THREE.Group>(null);
  const [hovered, setHovered] = React.useState(false);
  const phase = phaseOf(m.key);
  const isCrane = /crane/i.test(m.classSlug ?? '');
  const motion = motionOf(m.classSlug);
  // Start somewhere along the route, not all at its first stop.
  const travelled = useRef(phase % 400);
  // Motion follows the machine's own data: it travels its route, or slews in place,
  // only while duty-cycle classifies it as working. Never while the layout is edited.
  // It moves while its data is live and nothing says it is stopped: working, or engine on
  // with no load signal to say how hard. Idle, off, silent, alerting or broken down stand.
  // In the demo every machine at a work front works; one in the breakdown bay does not.
  const inBay = /breakdown|maintenance/i.test(m.engagedLabel ?? '');
  const working = !editing && m.placed && !m.breakdown && (simulated
    ? !inBay
    : m.activity === 'productive' || (m.status === 'live' && m.activity !== 'idle' && m.activity !== 'off'));
  // Loaded from the first stop (the quarry) on the way out, empty on the way back.
  const loaded = useRef(false);
  const travels = working && m.path.length > 1;
  const home = (-m.headingDeg * Math.PI) / 180;

  useFrame(({ clock }, dt) => {
    if (!outer.current || !body.current) return;
    const t = clock.elapsedTime + phase * 0.01;
    if (travels) {
      travelled.current += dt * SPEED;
      const p = along(m.path, travelled.current);
      loaded.current = motion === 'haul' && !p.back && p.leg >= 1;
      outer.current.position.set(p.x, 0, p.z);
      body.current.rotation.y = Math.atan2(-p.dz, p.dx);
      body.current.position.y = 0;
      return;
    }
    loaded.current = false;
    if (!working) {
      outer.current.position.set(m.x, 0, m.z);
      body.current.rotation.y = home;
      body.current.position.y = 0;
      return;
    }
    if (isCrane) {
      // A crane stands and slews its load across slowly, a wide arc, pausing at each end.
      outer.current.position.set(m.x, 0, m.z);
      body.current.rotation.y = home + 1.1 * Math.tanh(2 * Math.sin(t * 0.18));
      body.current.position.y = 0;
    } else if (motion === 'slew') {
      // Dig, swing to dump, swing back, and creep along the face now and then.
      const shuffle = 1.6 * Math.sin(t * 0.12);
      outer.current.position.set(m.x + shuffle * Math.cos(home), 0, m.z - shuffle * Math.sin(home));
      body.current.rotation.y = home + 0.6 * Math.sin(t * 0.8) * Math.max(0, Math.sin(t * 0.25) + 0.4);
      body.current.position.y = 0;
    } else if (motion === 'drill') {
      outer.current.position.set(m.x, 0, m.z);
      body.current.rotation.y = home;
      body.current.position.y = 0.12 * Math.abs(Math.sin(t * 3));
    } else {
      outer.current.position.set(m.x, 0, m.z);
      body.current.rotation.y = home;
      // A running engine shudders, a little.
      body.current.position.y = 0.02 * Math.sin(t * 40);
    }
  });

  return (
    <group ref={outer} position={[m.x, 0, m.z]}>
      <group
        ref={body}
        // Heading is clockwise from east, seen from above, so it reads like a compass.
        rotation={[0, home, 0]}
        onClick={(e: ThreeEvent<MouseEvent>) => { if (e.delta < 5) { e.stopPropagation(); onSelect(m.key); } }}
        onPointerDown={editing ? (e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); onSelect(m.key); onGrab({ kind: 'machine', key: m.key }); } : undefined}
        onPointerOver={() => { setHovered(true); document.body.style.cursor = editing ? 'grab' : 'pointer'; }}
        onPointerOut={() => { setHovered(false); document.body.style.cursor = ''; }}
      >
        {modelUrl
          ? <Suspense fallback={<StandIn colour={STATUS_COLOUR[m.status]} />}><ClassModel url={modelUrl} /></Suspense>
          : <StandIn colour={STATUS_COLOUR[m.status]} />}
        {motion === 'haul' && <Load visible={loaded} />}
        {simulated && working && isCrane && <CraneLift seed={phase} />}
      </group>
      <StatusRing status={m.status} radius={radius} selected={selected} placed={m.placed} />
      {working && motion === 'exhaust' && <Exhaust height={3.2} seed={phase} />}
      {(showLabel || selected || hovered) && (
        // Inline styles, not utility classes: the label must read the same wherever the
        // scene is mounted, and two short lines never wrap into a third.
        <Html position={[0, 7 + (selected ? 0 : lift * 4), 0]} center zIndexRange={selected ? [30, 25] : [20, 0]} style={{ pointerEvents: 'none' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', whiteSpace: 'nowrap', fontFamily: 'Inter, system-ui, sans-serif' }}>
            <div style={{
              background: selected ? '#0284c7' : 'rgba(255,255,255,0.96)', color: selected ? '#fff' : '#0f172a',
              borderRadius: 8, padding: '3px 8px', boxShadow: '0 1px 4px rgba(15,23,42,0.25)', lineHeight: 1.25,
            }}>
              <div style={{ fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 8, height: 8, borderRadius: 4, background: STATUS_COLOUR[m.status], display: 'inline-block' }} />
                {m.name.length > 28 ? `${m.name.slice(0, 26)}…` : m.name}
              </div>
              {/* At the overview a site of thirty machines is thirty names; what each is
                  doing and where shows for the one selected, and in the zone strip. */}
              {selected && (
                <div style={{ fontSize: 10, opacity: 0.85 }}>
                  {m.breakdown ? 'Breakdown' : ACTIVITY_LABEL[m.activity]}{m.engagedLabel ? ` · ${m.engagedLabel}` : ''}
                </div>
              )}
            </div>
            <span style={{ width: 2, height: 10, background: selected ? '#0284c7' : '#64748b' }} />
          </div>
        </Html>
      )}
    </group>
  );
};

/** A route, dashed on the ground: where this machine shuttles when it works. Drawn as
 * illustrative, because nothing here knows the real track. */
const RoutePath: React.FC<{ path: [number, number][]; active: boolean }> = ({ path, active }) => {
  const line = useMemo(() => {
    const g = new THREE.BufferGeometry().setFromPoints(path.map(([x, z]) => new THREE.Vector3(x, 0.45, z)));
    const l = new THREE.Line(g, new THREE.LineDashedMaterial({ color: active ? '#0284c7' : '#94a3b8', dashSize: 2, gapSize: 1.5 }));
    l.computeLineDistances();
    return l;
  }, [path, active]);
  useEffect(() => () => { line.geometry.dispose(); (line.material as THREE.Material).dispose(); }, [line]);
  return <primitive object={line} />;
};

/** Turns a pointer anywhere on the canvas into a point on the ground while a drag is on.
 * Raycasting the y = 0 plane directly, rather than relying on a mesh under the pointer,
 * keeps the drag alive when it crosses a machine, a zone or the edge of the slab. */
const GroundDrag: React.FC<{ target: React.MutableRefObject<DragTarget | null>; onDrag: SiteTwinSceneProps['onDrag']; onEnd: () => void }> = ({ target, onDrag, onEnd }) => {
  const { camera, gl } = useThree();
  useEffect(() => {
    const el = gl.domElement;
    const ray = new THREE.Raycaster();
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hit = new THREE.Vector3();
    const move = (e: PointerEvent) => {
      if (!target.current) return;
      const r = el.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
      if (ray.ray.intersectPlane(plane, hit)) onDrag(target.current, hit.x, hit.z);
    };
    const up = () => { if (target.current) { target.current = null; onEnd(); } };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, [camera, gl, onDrag, onEnd, target]);
  return null;
};

const SiteTwinScene: React.FC<SiteTwinSceneProps> = (props) => {
  const { extent, zones, machines, classModels, showLabels, selectedKey, onSelect, editing, onDrag, focus, zoomCommand, autoRotate } = props;
  const simulated = !!props.simulated;
  const controls = useRef<CameraControls>(null);
  const drag = useRef<DragTarget | null>(null);
  const span = Math.max(extent.widthM, extent.depthM);

  const grab = (t: DragTarget) => {
    drag.current = t;
    if (controls.current) controls.current.enabled = false;
  };
  const endDrag = React.useCallback(() => { if (controls.current) controls.current.enabled = true; }, []);

  const { size } = useThree();
  // Fly to the focused area at the fixed angle, at the distance that fits it on screen.
  // Computed rather than `fitToBox`, whose result depends on where the camera already was.
  const flyTo = React.useCallback((f: SceneFocus, animate: boolean) => {
    const c = controls.current;
    if (!c) return;
    const half = Math.tan((FOV * Math.PI) / 360);
    const aspect = size.width / Math.max(1, size.height);
    // The depth is foreshortened by the tilt; the width is not.
    const fit = Math.max(f.widthM / aspect, f.depthM * Math.cos(POLAR) + 12 * Math.sin(POLAR));
    const dist = (fit / (2 * half)) * 1.22;
    const p = new THREE.Vector3(Math.sin(POLAR) * Math.sin(AZIMUTH), Math.cos(POLAR), Math.sin(POLAR) * Math.cos(AZIMUTH))
      .multiplyScalar(dist).add(new THREE.Vector3(f.x, 0, f.z));
    void c.setLookAt(p.x, p.y, p.z, f.x, 0, f.z, animate);
  }, [size.width, size.height]);

  const first = useRef(true);
  useEffect(() => {
    flyTo(focus, !first.current);
    first.current = false;
  }, [focus.x, focus.z, focus.widthM, focus.depthM, flyTo]);

  useEffect(() => {
    const c = controls.current;
    if (!c || zoomCommand.n === 0) return;
    if (zoomCommand.dir === 0) { flyTo(focus, true); return; }
    void c.dolly(zoomCommand.dir * span * 0.15, true);
  }, [zoomCommand.n]);

  useFrame((_, dt) => {
    if (autoRotate && controls.current && !drag.current) controls.current.azimuthAngle += dt * 0.08;
  });

  return (
    <>
      {/* Sky, and haze toward the horizon so the grass fades out instead of ending. */}
      <color attach="background" args={['#cfe3f3']} />
      <fog attach="fog" args={['#cfe3f3', span * 1.6, span * 4.5]} />
      <hemisphereLight args={['#f8fbff', '#a3b18a', 0.85]} />
      <directionalLight
        position={[span * 0.4, span * 0.8, span * 0.3]}
        intensity={1.6}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-span * 0.7}
        shadow-camera-right={span * 0.7}
        shadow-camera-top={span * 0.7}
        shadow-camera-bottom={-span * 0.7}
        shadow-camera-far={span * 3}
        shadow-bias={-0.0005}
      />
      <SiteGround widthM={extent.widthM} depthM={extent.depthM} onEmptyClick={() => onSelect(null)} />
      {zones.map((z, i) => <Zone key={z.id ?? i} zone={z} index={i} editing={editing} onGrab={grab} />)}
      {/* People and work, demo only: nothing tracks a worker or a crane hook. */}
      {simulated && !editing && <SiteLife zones={zones} extent={extent} />}
      {machines.some((m) => !m.placed) && (
        <GroundLabel text="Not yet placed" x={0} z={extent.depthM / 2 + 5} maxWidth={span * 0.3} y={0.05} />
      )}
      {/* One line per distinct route: a fleet of ten on one route is one road, not ten. */}
      {!editing && [...new Map(machines.filter((m) => m.placed && m.path.length > 1)
        .map((m) => [m.path.slice(1).map((p) => p.join(',')).join(';'), m])).values()].map((m) => (
          <RoutePath key={`route-${m.key}`} path={m.path} active={simulated || m.activity === 'productive'} />
      ))}
      {machines.map((m, i) => {
        const model = m.classSlug ? classModels[m.classSlug] : null;
        const b = model?.bounds;
        const radius = b ? Math.max(Math.hypot(b.max[0] - b.min[0], b.max[2] - b.min[2]) / 2 + 0.8, 2.5) : 3.6;
        return (
          <Machine
            key={m.key} m={m} modelUrl={model?.modelUrl ?? null} radius={radius}
            showLabel={showLabels} selected={selectedKey === m.key}
            editing={editing} onSelect={onSelect} onGrab={grab} lift={i % 3} simulated={simulated}
          />
        );
      })}
      <GroundDrag target={drag} onDrag={onDrag} onEnd={endDrag} />
      <CameraControls
        ref={controls}
        makeDefault
        minPolarAngle={0.15}
        maxPolarAngle={Math.PI / 2.15}
        minDistance={8}
        maxDistance={span * 3}
      />
    </>
  );
};

const SiteTwinCanvas: React.FC<SiteTwinSceneProps> = (props) => (
  <Canvas shadows camera={{ fov: FOV, near: 0.5, far: 20000, position: [150, 150, 150] }} dpr={[1, 2]}>
    <SiteTwinScene {...props} />
  </Canvas>
);

export default SiteTwinCanvas;
