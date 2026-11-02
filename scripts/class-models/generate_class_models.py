#!/usr/bin/env python3
"""
Low-poly digital-twin models for the equipment classes, written as .glb with nothing but
the standard library, so anyone can regenerate them without Blender or an npm package.

    python3 scripts/class-models/generate_class_models.py <out_dir>

Writes <out_dir>/<class-slug>.glb for every class below, plus <out_dir>/manifest.json
holding each model's bounding box and the marker position of each signal. The bounds are
what the console would measure at upload, and every marker is checked against them here,
because the API refuses a marker outside the box (model-anchor-rules.ts).

Conventions, matching how three.js draws a glTF as stored (ModelScene does no centring or
scaling): metres, Y up, ground at y = 0, the machine's front towards +X.

These are stand-ins with the right silhouette and proportions, not CAD. When a real model
arrives, upload it through the class's 3-D model panel instead; see README.md here.
"""
import json
import math
import os
import struct
import sys

# ----------------------------------------------------------------- colours (linear RGB)

def hex_rgb(h):
    h = h.lstrip('#')
    # glTF baseColorFactor is linear; the hex values below are sRGB as a designer picks them.
    return [((int(h[i:i + 2], 16) / 255) ** 2.2) for i in (0, 2, 4)]

YELLOW = '#f2b705'
ORANGE = '#e8710a'
RED = '#c62828'
WHITE = '#e9edf1'
STEEL = '#8a8f98'
DARK = '#2b2d31'
BLACK = '#141518'
GLASS = '#6fa8c9'
BLUE = '#1f5fa8'
GREEN = '#2e7d32'

# ------------------------------------------------------------------ geometry builders

def rot_matrix(rx=0.0, ry=0.0, rz=0.0):
    """Rotation in degrees, applied X then Y then Z."""
    ax, ay, az = (math.radians(a) for a in (rx, ry, rz))
    cx, sx, cy, sy, cz, sz = math.cos(ax), math.sin(ax), math.cos(ay), math.sin(ay), math.cos(az), math.sin(az)
    rxm = [[1, 0, 0], [0, cx, -sx], [0, sx, cx]]
    rym = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]]
    rzm = [[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]]
    mul = lambda a, b: [[sum(a[i][k] * b[k][j] for k in range(3)) for j in range(3)] for i in range(3)]
    return mul(rzm, mul(rym, rxm))


def apply(m, v):
    return [m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
            m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
            m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2]]


class Model:
    """Parts are baked into world space and grouped by colour: one mesh per colour keeps the
    file small and the draw calls few, and nothing in the twin animates a part on its own."""

    def __init__(self, slug):
        self.slug = slug
        self.groups = {}  # colour -> (positions, normals, indices)
        self.anchors = {}

    def _add(self, color, verts, norms, idx, pos, rot):
        m = rot_matrix(*rot)
        g = self.groups.setdefault(color, ([], [], []))
        base = len(g[0]) // 3
        for v in verts:
            w = apply(m, v)
            g[0].extend([w[0] + pos[0], w[1] + pos[1], w[2] + pos[2]])
        for n in norms:
            g[1].extend(apply(m, n))
        g[2].extend(i + base for i in idx)

    def box(self, color, size, pos, rot=(0, 0, 0), pivot=(0, 0, 0)):
        """A box of size (sx, sy, sz) centred on `pivot` in its own frame, so a boom can
        be built from its root: pivot (-L/2, 0, 0) puts the root at `pos`."""
        sx, sy, sz = (s / 2 for s in size)
        px, py, pz = (-p for p in pivot)
        faces = [
            ((1, 0, 0), [(sx, -sy, -sz), (sx, sy, -sz), (sx, sy, sz), (sx, -sy, sz)]),
            ((-1, 0, 0), [(-sx, -sy, sz), (-sx, sy, sz), (-sx, sy, -sz), (-sx, -sy, -sz)]),
            ((0, 1, 0), [(-sx, sy, -sz), (-sx, sy, sz), (sx, sy, sz), (sx, sy, -sz)]),
            ((0, -1, 0), [(-sx, -sy, sz), (-sx, -sy, -sz), (sx, -sy, -sz), (sx, -sy, sz)]),
            ((0, 0, 1), [(-sx, -sy, sz), (sx, -sy, sz), (sx, sy, sz), (-sx, sy, sz)]),
            ((0, 0, -1), [(sx, -sy, -sz), (-sx, -sy, -sz), (-sx, sy, -sz), (sx, sy, -sz)]),
        ]
        verts, norms, idx = [], [], []
        for n, quad in faces:
            b = len(verts)
            verts += [(x + px, y + py, z + pz) for x, y, z in quad]
            norms += [n] * 4
            idx += [b, b + 1, b + 2, b, b + 2, b + 3]
        self._add(color, verts, norms, idx, pos, rot)

    def cylinder(self, color, radius, length, pos, axis='y', rot=(0, 0, 0), segments=20):
        """Along `axis` and centred on `pos`; axis 'z' is a wheel on an axle across the machine."""
        h = length / 2
        verts, norms, idx = [], [], []
        ring = [(math.cos(2 * math.pi * i / segments), math.sin(2 * math.pi * i / segments)) for i in range(segments)]
        for c, s in ring:
            verts += [(radius * c, -h, radius * s), (radius * c, h, radius * s)]
            norms += [(c, 0, s), (c, 0, s)]
        for i in range(segments):
            a, b = 2 * i, 2 * ((i + 1) % segments)
            idx += [a, b + 1, b, a, a + 1, b + 1]
        for y, ny in ((h, 1), (-h, -1)):
            centre = len(verts)
            verts.append((0, y, 0))
            norms.append((0, ny, 0))
            for c, s in ring:
                verts.append((radius * c, y, radius * s))
                norms.append((0, ny, 0))
            for i in range(segments):
                a, b = centre + 1 + i, centre + 1 + (i + 1) % segments
                idx += [centre, b, a] if ny > 0 else [centre, a, b]
        pre = {'y': (0, 0, 0), 'x': (0, 0, -90), 'z': (90, 0, 0)}[axis]
        m = rot_matrix(*pre)
        verts = [apply(m, v) for v in verts]
        norms = [apply(m, n) for n in norms]
        self._add(color, verts, norms, idx, pos, rot)

    def wheel(self, x, z, radius, width=0.5):
        self.cylinder(BLACK, radius, width, (x, radius, z), axis='z')
        self.cylinder(STEEL, radius * 0.5, width + 0.02, (x, radius, z), axis='z')

    def track(self, length, z, height=0.9, width=0.6):
        self.box(DARK, (length, height, width), (0, height / 2, z))
        for x in (-length / 2 + height / 2, length / 2 - height / 2):
            self.cylinder(BLACK, height / 2, width + 0.02, (x, height / 2, z), axis='z')

    def anchor(self, signal, label, x, y, z):
        self.anchors[signal] = {'label': label, 'pos': [round(x, 3), round(y, 3), round(z, 3)]}

    def standard_anchors(self, engine, hydraulic, step=0.4):
        """The three signals every class in the demo declares. Coolant sits at the radiator
        end of the engine bay, oil pressure lower on the same face of the block, hydraulic
        oil at the tank. `step` is how far apart the two engine markers sit; kept on the
        face rather than across it, so neither ends up in the air beside the machine."""
        ex, ey, ez = engine
        self.anchor('engine_coolant_temperature', 'Coolant Temp', ex, ey, ez)
        self.anchor('engine_oil_pressure', 'Oil Pressure', ex - step, ey - step * 0.6, ez)
        self.anchor('hydraulic_oil_temperature', 'Hydraulic Oil Temp', *hydraulic)


def truck_cab(m, x, color=WHITE, width=2.4):
    m.box(color, (1.8, 1.9, width), (x, 2.05, 0))
    m.box(GLASS, (0.05, 0.8, width * 0.85), (x + 0.91, 2.45, 0))


def truck_chassis(m, length, axles, cab_color=WHITE, width=2.4):
    m.box(DARK, (length, 0.35, 1.0), (0, 1.0, 0))
    truck_cab(m, length / 2 - 0.9, cab_color, width)
    for x in axles:
        for z in (-width / 2 + 0.25, width / 2 - 0.25):
            m.wheel(x, z, 0.55, 0.45)


def boom_chain(m, color, root, segments, thickness=0.45):
    """Segments as (length, angle in degrees from horizontal), each starting at the
    previous tip; returns the tip, so a bucket or a hook can hang from it."""
    x, y, z = root
    for length, angle in segments:
        m.box(color, (length, thickness, thickness), (x, y, z), rot=(0, 0, angle), pivot=(-length / 2, 0, 0))
        x += length * math.cos(math.radians(angle))
        y += length * math.sin(math.radians(angle))
        thickness *= 0.85
    return x, y, z

# ---------------------------------------------------------------------- the classes

def excavator(slug):
    m = Model(slug)
    for z in (-1.1, 1.1):
        m.track(4.4, z)
    m.cylinder(DARK, 0.7, 0.3, (0, 1.05, 0))
    m.box(YELLOW, (3.0, 1.1, 2.5), (-0.4, 1.75, 0))          # upper structure
    m.box(DARK, (0.8, 1.0, 2.5), (-2.2, 1.7, 0))              # counterweight
    m.box(YELLOW, (1.1, 1.6, 0.95), (0.5, 3.1, 0.75))         # cab
    m.box(GLASS, (0.05, 1.0, 0.8), (1.06, 3.2, 0.75))
    m.cylinder(BLACK, 0.08, 0.6, (-1.3, 2.6, -0.8))           # exhaust
    tip = boom_chain(m, YELLOW, (0.9, 2.1, -0.3), [(3.4, 42), (2.6, -62)])
    m.box(DARK, (0.9, 0.8, 1.0), (tip[0] + 0.2, max(tip[1] - 0.2, 0.4), -0.3))   # bucket
    m.standard_anchors(engine=(-1.3, 2.3, -0.6), hydraulic=(-0.2, 2.3, -1.25))
    return m


def backhoe_loader():
    m = Model('backhoe-loader')
    m.box(YELLOW, (4.2, 0.9, 2.1), (0, 1.3, 0))
    m.box(YELLOW, (1.5, 0.8, 1.6), (1.4, 2.1, 0))              # engine hood
    m.box(YELLOW, (1.5, 1.6, 1.9), (-0.4, 2.55, 0))           # cab
    m.box(GLASS, (0.05, 1.0, 1.6), (0.36, 2.7, 0))
    for x, r in ((1.6, 0.55), (-1.3, 0.8)):
        for z in (-1.05, 1.05):
            m.wheel(x, z, r, 0.45)
    boom_chain(m, YELLOW, (1.8, 1.6, 0), [(1.4, -20)], 0.3)
    m.box(DARK, (0.7, 0.8, 2.4), (3.6, 0.6, 0))               # loader bucket
    tip = boom_chain(m, YELLOW, (-2.1, 1.8, 0), [(2.2, 50), (2.0, -70)], 0.35)
    m.box(DARK, (0.5, 0.5, 0.6), (tip[0], max(tip[1], 0.35), 0))
    m.standard_anchors(engine=(1.6, 2.3, 0.6), hydraulic=(0.6, 1.5, 1.06))
    return m


def motor_grader():
    m = Model('motor-grader')
    m.box(YELLOW, (4.5, 0.45, 0.6), (1.6, 1.6, 0))            # long front frame
    m.box(YELLOW, (2.6, 1.3, 2.2), (-1.8, 1.65, 0))           # engine bay
    m.box(YELLOW, (1.4, 1.5, 1.8), (-0.1, 2.75, 0))           # cab
    m.box(GLASS, (0.05, 1.0, 1.6), (0.61, 2.9, 0))
    m.box(STEEL, (0.3, 0.6, 3.6), (1.2, 0.35, 0), rot=(0, 25, 0))   # blade
    for z in (-1.0, 1.0):
        m.wheel(3.7, z, 0.65)
        m.wheel(-1.2, z, 0.65)
        m.wheel(-2.7, z, 0.65)
    m.standard_anchors(engine=(-2.6, 2.1, 0.7), hydraulic=(-1.0, 1.9, -1.11))
    return m


def rock_tipper_truck():
    m = Model('rock-tipper-truck')
    truck_chassis(m, 8.0, (3.0, -1.4, -2.9), cab_color=ORANGE, width=2.5)
    m.box(YELLOW, (5.4, 1.6, 2.5), (-1.3, 2.25, 0), rot=(0, 0, 4))   # dump body
    m.standard_anchors(engine=(3.6, 1.6, 0.9), hydraulic=(1.2, 1.4, -0.6))
    return m


def truck_mounted_crane():
    m = Model('truck-mounted-crane')
    truck_chassis(m, 9.0, (3.4, 1.9, -2.0, -3.4), cab_color=RED, width=2.5)
    m.box(DARK, (5.5, 0.6, 2.4), (-1.2, 1.45, 0))
    m.cylinder(DARK, 0.9, 0.5, (-1.5, 2.0, 0))
    m.box(RED, (1.8, 1.0, 2.0), (-1.9, 2.7, 0))               # superstructure
    tip = boom_chain(m, YELLOW, (-1.5, 3.0, 0), [(10.0, 35)], 0.6)
    m.cylinder(STEEL, 0.02, 2.0, (tip[0], tip[1] - 1.0, 0))
    m.standard_anchors(engine=(4.0, 1.7, 0.9), hydraulic=(-2.6, 2.6, 1.01))
    return m


def tyre_mounted_crane():
    m = Model('tyre-mounted-crane')
    m.box(YELLOW, (7.0, 1.0, 2.6), (0, 1.5, 0))
    for x in (2.4, -2.4):
        for z in (-1.1, 1.1):
            m.wheel(x, z, 0.75, 0.6)
    for x in (3.2, -3.2):                                     # outriggers
        m.box(DARK, (0.3, 0.2, 5.0), (x, 1.2, 0))
        for z in (-2.4, 2.4):
            m.box(DARK, (0.4, 1.2, 0.4), (x, 0.6, z))
    m.cylinder(DARK, 1.0, 0.4, (-0.5, 2.2, 0))
    m.box(YELLOW, (3.2, 1.2, 2.4), (-1.0, 2.9, 0))
    m.box(YELLOW, (1.0, 1.3, 0.9), (0.9, 3.1, -1.0))          # cab
    tip = boom_chain(m, YELLOW, (0.2, 3.4, 0.4), [(12.0, 40)], 0.75)
    m.cylinder(STEEL, 0.02, 3.0, (tip[0], tip[1] - 1.5, 0.4))
    m.standard_anchors(engine=(-2.2, 3.2, 1.21), hydraulic=(-0.4, 2.6, -1.21))
    return m


def pick_and_carry_crane():
    m = Model('pick-and-carry-crane')
    m.box(YELLOW, (6.0, 1.0, 2.4), (-0.5, 1.4, 0))
    m.box(YELLOW, (1.4, 1.4, 1.2), (-2.6, 2.6, 0.5))          # engine/cab block
    m.box(GLASS, (0.05, 0.9, 1.0), (-1.89, 2.7, 0.5))
    for x in (1.6, -2.6):
        for z in (-1.0, 1.0):
            m.wheel(x, z, 0.65, 0.55)
    tip = boom_chain(m, YELLOW, (-1.6, 2.0, -0.4), [(8.0, 28)], 0.6)
    m.cylinder(STEEL, 0.02, 2.5, (tip[0], tip[1] - 1.25, -0.4))
    m.standard_anchors(engine=(-2.2, 2.6, 1.11), hydraulic=(-0.5, 1.7, 1.21))
    return m


def heavy_crawler_crane():
    m = Model('heavy-crawler-crane')
    for z in (-2.3, 2.3):
        m.track(8.5, z, height=1.2, width=1.2)
    m.box(DARK, (2.2, 0.6, 3.4), (0, 1.0, 0))
    m.cylinder(DARK, 1.4, 0.4, (0, 1.5, 0))
    m.box(RED, (6.0, 2.2, 3.6), (-1.2, 2.8, 0))               # superstructure
    m.box(DARK, (1.4, 2.0, 3.4), (-4.6, 2.7, 0))              # counterweight
    m.box(RED, (1.4, 1.6, 1.0), (1.6, 3.6, -2.0))             # cab
    # Lattice boom drawn as two chords and the gaps between them; the open frame is what
    # tells a crawler crane apart from a telescopic one at a glance.
    for z in (-0.6, 0.6):
        boom_chain(m, YELLOW, (1.2, 3.4, z), [(28.0, 68)], 0.35)
    for i in range(1, 9):
        d = 28.0 * i / 9
        bx, by = 1.2 + d * math.cos(math.radians(68)), 3.4 + d * math.sin(math.radians(68))
        m.box(YELLOW, (0.15, 0.15, 1.2), (bx, by, 0))
    m.standard_anchors(engine=(-2.4, 3.4, 1.81), hydraulic=(-0.2, 2.2, -1.81))
    return m


def rotary_piling_rig():
    m = Model('rotary-piling-rig')
    for z in (-1.8, 1.8):
        m.track(6.0, z, height=1.0, width=0.9)
    m.cylinder(DARK, 1.0, 0.4, (0, 1.2, 0))
    m.box(YELLOW, (4.5, 1.6, 3.0), (-0.8, 2.2, 0))
    m.box(DARK, (1.0, 1.4, 3.0), (-3.4, 2.1, 0))              # counterweight
    m.box(YELLOW, (1.2, 1.5, 1.0), (1.0, 3.6, -1.0))          # cab
    m.box(YELLOW, (0.7, 20.0, 0.7), (2.2, 10.5, 0))           # mast
    m.cylinder(STEEL, 0.25, 16.0, (2.8, 9.0, 0))              # kelly bar
    m.box(DARK, (1.0, 1.0, 1.2), (2.8, 3.0, 0))               # rotary drive
    m.standard_anchors(engine=(-2.4, 2.8, 1.51), hydraulic=(-0.6, 2.2, -1.51))
    return m


def concrete_pump():
    m = Model('concrete-pump')
    truck_chassis(m, 10.0, (3.9, -1.2, -2.6, -3.9), cab_color=WHITE, width=2.5)
    m.box(STEEL, (6.0, 0.9, 2.2), (-1.5, 1.6, 0))
    m.box(DARK, (1.2, 1.0, 2.0), (-4.3, 1.5, 0))              # hopper
    for x in (1.5, -3.5):                                     # outriggers
        m.box(DARK, (0.3, 0.2, 6.0), (x, 1.1, 0), rot=(0, 20 if x > 0 else -20, 0))
    m.cylinder(DARK, 0.6, 0.6, (1.0, 2.3, 0))
    # Folded Z of the placing boom, the pump's signature shape.
    boom_chain(m, ORANGE, (1.0, 2.6, 0), [(7.0, 55), (6.0, 15), (5.0, -35)], 0.5)
    m.standard_anchors(engine=(4.5, 1.7, 0.9), hydraulic=(-2.5, 2.1, 1.11))
    return m


def concrete_placer_boom():
    m = Model('concrete-placer-boom')
    m.box(DARK, (4.0, 0.3, 0.4), (0, 0.15, 0))                # cross base
    m.box(DARK, (0.4, 0.3, 4.0), (0, 0.15, 0))
    m.box(STEEL, (0.7, 12.0, 0.7), (0, 6.3, 0))               # column
    m.cylinder(DARK, 0.6, 0.6, (0, 12.6, 0))                  # slewing ring
    m.box(ORANGE, (1.6, 1.2, 1.2), (-0.8, 13.4, 0))           # power unit
    boom_chain(m, ORANGE, (0.3, 13.4, 0), [(8.0, 8), (7.0, -4), (5.0, -40)], 0.45)
    m.box(DARK, (1.4, 1.4, 1.4), (-1.6, 12.6, 0))             # counterweight
    m.standard_anchors(engine=(-1.2, 13.9, 0.61), hydraulic=(-0.4, 12.9, 0.61))
    return m


def vibro_hammer():
    m = Model('vibro-hammer')
    # The power pack is where the engine and oil live; the hammer itself is hydraulic.
    m.box(BLUE, (3.0, 1.8, 1.5), (-2.5, 1.0, 0))
    m.box(DARK, (3.2, 0.15, 1.6), (-2.5, 0.075, 0))
    m.cylinder(BLACK, 0.07, 0.6, (-3.4, 2.2, 0.3))
    m.box(BLUE, (1.0, 2.2, 1.6), (1.5, 1.6, 0))               # vibrator housing
    m.box(DARK, (0.6, 0.6, 1.2), (1.5, 0.3, 0))               # clamp
    m.box(STEEL, (0.4, 0.8, 0.4), (1.5, 3.1, 0))              # suspension
    for z in (-0.3, 0.3):
        m.cylinder(BLACK, 0.05, 3.2, (-0.4, 1.4, z), axis='x')   # hoses
    m.standard_anchors(engine=(-3.3, 1.5, 0.76), hydraulic=(-1.4, 1.3, 0.76))
    return m


def prime_diesel_generator():
    m = Model('prime-diesel-generator')
    m.box(DARK, (5.0, 0.3, 1.8), (0, 0.15, 0))                # skid
    m.box(GREEN, (4.8, 2.1, 1.7), (0, 1.35, 0))               # acoustic canopy
    for x in (-1.5, -0.5, 0.5):
        m.box(DARK, (0.6, 1.2, 0.02), (x, 1.4, 0.86))         # louvres
    m.box(DARK, (0.05, 1.6, 1.4), (2.42, 1.35, 0))            # radiator grille
    m.cylinder(BLACK, 0.12, 0.8, (-1.6, 2.8, 0))              # exhaust stack
    m.standard_anchors(engine=(2.0, 1.9, 0.86), hydraulic=(-1.8, 0.8, 0.86))
    return m


def screw_air_compressor():
    m = Model('screw-air-compressor')
    m.box(DARK, (3.2, 0.25, 1.5), (0, 0.65, 0))
    m.box(YELLOW, (3.0, 1.2, 1.5), (0, 1.4, 0))               # canopy
    m.box(DARK, (0.02, 0.8, 1.2), (1.51, 1.4, 0))
    for z in (-0.85, 0.85):
        m.wheel(-0.3, z, 0.4, 0.25)
    m.box(DARK, (1.6, 0.1, 0.1), (2.3, 0.6, 0))               # drawbar
    m.box(DARK, (0.1, 0.5, 0.1), (3.0, 0.3, 0))               # jockey leg
    m.standard_anchors(engine=(1.2, 1.7, 0.76), hydraulic=(-1.0, 1.2, 0.76))
    return m


def shutter_converter():
    m = Model('shutter-converter')
    # A frequency converter for internal vibrators: a cased unit in a tubular frame, not a
    # vehicle. It is small, which is why the twin's camera fits to the box.
    m.box(BLUE, (0.6, 0.5, 0.45), (0, 0.4, 0))
    for x in (-0.33, 0.33):
        for z in (-0.25, 0.25):
            m.box(STEEL, (0.03, 0.75, 0.03), (x, 0.375, z))
    m.box(STEEL, (0.7, 0.03, 0.03), (0, 0.75, -0.25))         # handle
    m.box(STEEL, (0.7, 0.03, 0.03), (0, 0.75, 0.25))
    for x in (-0.15, 0.0, 0.15):
        m.cylinder(DARK, 0.04, 0.05, (x, 0.45, 0.24), axis='z')   # outlets
    m.standard_anchors(engine=(-0.1, 0.6, 0.23), hydraulic=(0.2, 0.3, 0.23), step=0.12)
    return m


CLASSES = [
    excavator('hydraulic-excavator'), excavator('demo-excavator'), backhoe_loader(), motor_grader(),
    rock_tipper_truck(), truck_mounted_crane(), tyre_mounted_crane(), pick_and_carry_crane(),
    heavy_crawler_crane(), rotary_piling_rig(), concrete_pump(), concrete_placer_boom(), vibro_hammer(),
    prime_diesel_generator(), screw_air_compressor(), shutter_converter(),
]

# ------------------------------------------------------------------------ GLB writer

def write_glb(model, path):
    bin_chunk = bytearray()
    buffer_views, accessors, meshes, nodes, materials = [], [], [], [], []
    lo, hi = [math.inf] * 3, [-math.inf] * 3

    def view(data, target):
        while len(bin_chunk) % 4:
            bin_chunk.append(0)
        buffer_views.append({'buffer': 0, 'byteOffset': len(bin_chunk), 'byteLength': len(data), 'target': target})
        bin_chunk.extend(data)
        return len(buffer_views) - 1

    for color, (pos, nrm, idx) in model.groups.items():
        vmin = [min(pos[i::3]) for i in range(3)]
        vmax = [max(pos[i::3]) for i in range(3)]
        lo = [min(a, b) for a, b in zip(lo, vmin)]
        hi = [max(a, b) for a, b in zip(hi, vmax)]
        count = len(pos) // 3
        pv = view(struct.pack(f'<{len(pos)}f', *pos), 34962)
        nv = view(struct.pack(f'<{len(nrm)}f', *nrm), 34962)
        iv = view(struct.pack(f'<{len(idx)}I', *idx), 34963)
        accessors += [
            {'bufferView': pv, 'componentType': 5126, 'count': count, 'type': 'VEC3', 'min': vmin, 'max': vmax},
            {'bufferView': nv, 'componentType': 5126, 'count': count, 'type': 'VEC3'},
            {'bufferView': iv, 'componentType': 5125, 'count': len(idx), 'type': 'SCALAR'},
        ]
        a = len(accessors) - 3
        materials.append({'pbrMetallicRoughness': {
            'baseColorFactor': hex_rgb(color) + [1.0],
            'metallicFactor': 0.6 if color in (STEEL, BLACK) else 0.1,
            'roughnessFactor': 0.25 if color == GLASS else 0.6,
        }})
        meshes.append({'primitives': [{'attributes': {'POSITION': a, 'NORMAL': a + 1}, 'indices': a + 2,
                                       'material': len(materials) - 1}]})
        nodes.append({'mesh': len(meshes) - 1})

    gltf = {
        'asset': {'version': '2.0', 'generator': 'things-alive generate_class_models.py'},
        'scene': 0,
        'scenes': [{'nodes': list(range(len(nodes)))}],
        'nodes': nodes, 'meshes': meshes, 'materials': materials,
        'accessors': accessors, 'bufferViews': buffer_views,
        'buffers': [{'byteLength': len(bin_chunk)}],
    }
    js = json.dumps(gltf, separators=(',', ':')).encode()
    js += b' ' * (-len(js) % 4)
    bin_chunk += b'\0' * (-len(bin_chunk) % 4)
    total = 12 + 8 + len(js) + 8 + len(bin_chunk)
    with open(path, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, total))
        f.write(struct.pack('<II', len(js), 0x4E4F534A) + js)
        f.write(struct.pack('<II', len(bin_chunk), 0x004E4942) + bin_chunk)
    # Rounded outward, so a marker on a face is never refused for a float's last digit.
    return {'min': [math.floor(v * 1000) / 1000 for v in lo], 'max': [math.ceil(v * 1000) / 1000 for v in hi]}


def main(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    manifest, problems = {}, []
    for m in CLASSES:
        path = os.path.join(out_dir, f'{m.slug}.glb')
        bounds = write_glb(m, path)
        for signal, a in m.anchors.items():
            for i, axis in enumerate('xyz'):
                if not bounds['min'][i] <= a['pos'][i] <= bounds['max'][i]:
                    problems.append(f'{m.slug}: {signal} {axis}={a["pos"][i]} is outside {bounds["min"][i]}..{bounds["max"][i]}')
        manifest[m.slug] = {'file': f'{m.slug}.glb', 'sizeBytes': os.path.getsize(path), 'bounds': bounds,
                            'anchors': [{'signal': s, 'label': a['label'], 'x': a['pos'][0], 'y': a['pos'][1], 'z': a['pos'][2]}
                                        for s, a in sorted(m.anchors.items())]}
        print(f'{m.slug:24} {os.path.getsize(path):>8} bytes  {bounds["min"]} .. {bounds["max"]}')
    with open(os.path.join(out_dir, 'manifest.json'), 'w', encoding='utf-8') as f:
        json.dump(manifest, f, indent=2)
    if problems:
        print('\n'.join(problems), file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'class-models-out')
