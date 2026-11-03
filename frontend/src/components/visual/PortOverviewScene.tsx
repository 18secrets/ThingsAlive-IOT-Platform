import React, { useEffect, useMemo, useRef } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { CameraControls } from '@react-three/drei';
import * as THREE from 'three';
import type { PortTwin, SiteTwinZone } from '../../lib/api';
import { GroundLabel, Machine, RoutePath, SiteGround, Zone, type SceneMachine } from './SiteTwinScene';
import SiteLife, { Port } from './SiteLife';

/**
 * Every site of the account together, along one waterfront: each drawn from its own
 * twin exactly as its page draws it, so the overview and a site's page cannot disagree.
 * Sites go in rows behind the quay, the first row on it. Click a site to open its page.
 */

const GAP = 40;
const FOV = 35;
const POLAR = 0.9;
const AZIMUTH = 0.1;

interface Placed { site: PortTwin['sites'][number]; x: number; z: number }

/** Rows of sites, about one and a half times as wide as deep, the first row's north
 * edge on the quay at z = 0. */
export function arrangeSites(sites: PortTwin['sites']): { placed: Placed[]; width: number; depth: number } {
  const cols = Math.max(1, Math.min(sites.length, Math.ceil(Math.sqrt(sites.length * 1.5))));
  const placed: Placed[] = [];
  let z = 0; let width = 0;
  for (let r = 0; r * cols < sites.length; r += 1) {
    const row = sites.slice(r * cols, (r + 1) * cols);
    const rowW = row.reduce((a, s) => a + s.extent.widthM, 0) + GAP * (row.length - 1);
    const rowD = Math.max(...row.map((s) => s.extent.depthM));
    let x = -rowW / 2;
    for (const s of row) {
      placed.push({ site: s, x: x + s.extent.widthM / 2, z: z + s.extent.depthM / 2 });
      x += s.extent.widthM + GAP;
    }
    width = Math.max(width, rowW);
    z += rowD + GAP;
  }
  return { placed, width, depth: z - GAP };
}

const sceneMachines = (site: PortTwin['sites'][number]): SceneMachine[] => {
  const byKey = new Map(site.zones.map((z) => [z.key, z]));
  return site.machines.filter((m) => m.placement).map((m) => {
    const p = m.placement!;
    const stops = p.route.map((k) => byKey.get(k)).filter((zn): zn is SiteTwinZone => !!zn);
    return {
      key: `${m.sourceSystem}/${m.externalId}`, name: m.name ?? m.externalId, classSlug: m.classSlug, status: m.status,
      placed: true, x: p.x, z: p.z, headingDeg: p.headingDeg, activity: m.activity,
      path: stops.length ? [[p.x, p.z] as [number, number], ...stops.map((zn) => [zn.x, zn.z] as [number, number])] : [],
      engagedLabel: m.engagedAt ? byKey.get(m.engagedAt)?.label ?? null : null, breakdown: m.breakdown,
    };
  });
};

const Fit: React.FC<{ width: number; depth: number; reset: number }> = ({ width, depth, reset }) => {
  const controls = useRef<CameraControls>(null);
  const { size } = useThree();
  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    const half = Math.tan((FOV * Math.PI) / 360);
    const aspect = size.width / Math.max(1, size.height);
    // The quay and ship sit north of z = 0; frame them too.
    const d = depth + 70;
    const fit = Math.max(width / aspect, d * Math.cos(POLAR) + 30 * Math.sin(POLAR));
    const dist = (fit / (2 * half)) * 1.35;
    const cz = depth / 2 - 35;
    const p = new THREE.Vector3(Math.sin(POLAR) * Math.sin(AZIMUTH), Math.cos(POLAR), Math.sin(POLAR) * Math.cos(AZIMUTH))
      .multiplyScalar(dist).add(new THREE.Vector3(0, 0, cz));
    void c.setLookAt(p.x, p.y, p.z, 0, 0, cz, reset > 0);
  }, [width, depth, size.width, size.height, reset]);
  return <CameraControls ref={controls} makeDefault minPolarAngle={0.15} maxPolarAngle={Math.PI / 2.15} minDistance={20} maxDistance={Math.max(width, depth) * 4} />;
};

const PortOverviewScene: React.FC<{
  port: PortTwin; showLabels: boolean; onOpenSite: (plantId: string) => void; reset: number;
}> = ({ port, showLabels, onOpenSite, reset }) => {
  const { placed, width, depth } = useMemo(() => arrangeSites(port.sites), [port.sites]);
  const span = Math.max(width, depth);
  const noop = () => undefined;
  return (
    <Canvas shadows camera={{ fov: FOV, near: 1, far: 40000, position: [0, span, span] }} dpr={[1, 2]}>
      <color attach="background" args={['#cfe3f3']} />
      <fog attach="fog" args={['#cfe3f3', span * 1.4, span * 4]} />
      <hemisphereLight args={['#f8fbff', '#a3b18a', 0.85]} />
      <directionalLight
        position={[span * 0.3, span * 0.8, span * 0.4]} intensity={1.5} castShadow shadow-mapSize={[4096, 4096]}
        shadow-camera-left={-span * 0.7} shadow-camera-right={span * 0.7}
        shadow-camera-top={span * 0.7} shadow-camera-bottom={-span * 0.7} shadow-camera-far={span * 3}
      />
      {port.simulated && <Port widthM={width + 120} depthM={0} />}
      {placed.map(({ site, x, z }) => {
        const machines = sceneMachines(site);
        return (
          <group key={site.site.plantId} position={[x, 0, z]}>
            <SiteGround widthM={site.extent.widthM} depthM={site.extent.depthM} onEmptyClick={() => onOpenSite(site.site.plantId)} />
            {site.zones.map((zn, i) => <Zone key={zn.key} zone={zn} index={i} editing={false} onGrab={noop} />)}
            {port.simulated && <SiteLife zones={site.zones} extent={site.extent} withPort={false} />}
            {[...new Map(machines.filter((m) => m.path.length > 1).map((m) => [m.path.slice(1).join(';'), m])).values()].map((m) => (
              <RoutePath key={`r-${m.key}`} path={m.path} active />
            ))}
            {machines.map((m, i) => {
              const model = m.classSlug ? site.classModels[m.classSlug] : null;
              return (
                <Machine
                  key={m.key} m={m} modelUrl={model?.modelUrl ?? null} radius={3.4}
                  showLabel={showLabels} selected={false} editing={false} onSelect={() => onOpenSite(site.site.plantId)}
                  onGrab={noop} lift={i % 3} simulated={port.simulated}
                />
              );
            })}
            {/* The site's name on the ground before its south fence, big enough to read
                from the whole port. */}
            <GroundLabel text={`${site.site.code} · ${site.site.name}`} x={0} z={site.extent.depthM / 2 + 12} maxWidth={site.extent.widthM * 0.9} y={0.05} />
          </group>
        );
      })}
      <Fit width={width} depth={depth} reset={reset} />
    </Canvas>
  );
};

export default PortOverviewScene;
