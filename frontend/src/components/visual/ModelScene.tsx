import React, { Suspense } from 'react';
import { Canvas, type ThreeEvent } from '@react-three/fiber';
import { Bounds, Html, OrbitControls, useGLTF } from '@react-three/drei';
import type { ModelAnchor, ModelBounds } from '../../lib/api';

/**
 * The class's 3-D model with its signal markers. Loaded lazily (ModelAnchorEditor), so
 * three.js is fetched only by someone who opens a model.
 *
 * The model is drawn exactly as stored — no centring or scaling — because a marker's
 * x, y, z are in the model's own units, checked against the box measured at upload.
 * The camera is fitted to it instead.
 */
export interface SceneMarker extends ModelAnchor {
  tone: 'normal' | 'selected' | 'recheck';
}

// A pointer that travelled further than this between press and release was turning the
// view, not choosing a point.
const DRAG_PX = 5;

const Model: React.FC<{ url: string; onPlace?: (point: [number, number, number]) => void }> = ({ url, onPlace }) => {
  const { scene } = useGLTF(url);
  return (
    <primitive
      object={scene}
      onClick={(e: ThreeEvent<MouseEvent>) => {
        if (!onPlace || e.delta > DRAG_PX) return;
        e.stopPropagation();
        const p = e.point;
        onPlace([round(p.x), round(p.y), round(p.z)]);
      }}
    />
  );
};

const round = (n: number) => Math.round(n * 1000) / 1000;

const TONE = { normal: '#f43f5e', selected: '#0284c7', recheck: '#d97706' };

const ModelScene: React.FC<{
  url: string;
  bounds: ModelBounds | null;
  markers: SceneMarker[];
  onPlace?: (point: [number, number, number]) => void;
}> = ({ url, bounds, markers, onPlace }) => {
  // Markers sized to the model, so a 2 m genset and a 20 m crane both read.
  const diag = bounds
    ? Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2])
    : 1;
  const radius = Math.max(diag * 0.012, 0.001);
  return (
    // Bounds keeps the camera's direction when it fits the model, so starting at an angle
    // shows three faces rather than one.
    <Canvas camera={{ fov: 45, near: 0.01, far: 100000, position: [1.2, 0.9, 1.5] }} style={{ cursor: onPlace ? 'crosshair' : 'grab' }}>
      <ambientLight intensity={0.8} />
      <directionalLight position={[5, 10, 7]} intensity={1.2} />
      <Suspense fallback={null}>
        <Bounds fit clip observe margin={1.25}>
          <Model url={url} onPlace={onPlace} />
        </Bounds>
        {markers.map((m) => (
          <group key={m.signal} position={[m.x, m.y, m.z]}>
            <mesh>
              <sphereGeometry args={[radius, 16, 16]} />
              <meshBasicMaterial color={TONE[m.tone]} />
            </mesh>
            <Html center distanceFactor={undefined} style={{ pointerEvents: 'none', transform: 'translateY(-18px)' }}>
              <span
                className={`px-1.5 py-0.5 rounded text-[10px] font-semibold whitespace-nowrap shadow ${
                  m.tone === 'selected' ? 'bg-sky-600 text-white' : m.tone === 'recheck' ? 'bg-amber-500 text-white' : 'bg-white/90 text-slate-800'
                }`}
              >
                {m.label || m.signal}
              </span>
            </Html>
          </group>
        ))}
      </Suspense>
      <OrbitControls makeDefault />
    </Canvas>
  );
};

export default ModelScene;
