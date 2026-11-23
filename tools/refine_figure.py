"""Refine data/raw/astra_figure.stl into the base mesh for tools/body_from_stl.py.

The source mesh (made by GPT-6 Astra, see README) is one watertight shell, but
its limbs and waist are thinner than a real man's, its head is small and its
neck is a plain cylinder on flat shoulders. This script measures cross-section
perimeters along the legs, torso and arms and scales each part radially toward
a target perimeter, scales the head up, adds a neck flare and trapezius,
smooths, and voxel-remeshes so the result is still one closed skin. Run it
from the repo root:

  /Applications/Blender.app/Contents/MacOS/Blender -b -P tools/refine_figure.py -- \\
      data/raw/astra_figure.stl figure/refined.stl --report

Parts are never scaled thinner: where the mesh already meets its target it is
left alone. Output is Z up, facing -Y, centimetres, soles at z=0, 178 cm to
the top of the fists. figure/ is git-ignored; the refined STL is rebuilt, not
committed. Exits non-zero if the result is not one manifold shell.
"""
import argparse
import json
import os
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from body_from_stl import (ELBOW_L, ELBOW_R, JOINT_FRAME_CM, SHOULDER_L,  # noqa: E402
                           SHOULDER_R, WRIST_L, WRIST_R, fit_height, import_stl)

CROTCH_Z = 77.0         # legs are separate loops below this
TORSO_TOP_Z = 130.0     # above it the arms join the horizontal slices
MIDLINE_X = 0.65        # body midline in the fitted frame, from the torso loop centres
ARMS = {"R": (SHOULDER_R, ELBOW_R, WRIST_R), "L": (SHOULDER_L, ELBOW_L, WRIST_L)}
NECK_AXIS = (-0.1, 4.3)  # x, y of the neck's centre line
HEAD_PIVOT = Vector((0.0, 4.3, 151.0))
HEAD_CENTRE, HEAD_RADII = (0.0, 1.8, 162.0), (8.5, 8.5, 10.5)
HEAD_SCALE = 1.08
# Added volumes, merged by the voxel remesh: the neck flares into the
# shoulders, and the upper trapezius slopes from behind the neck to each
# shoulder. (start, end, radius at start, radius at end), cm.
NECK_FLARE = ((NECK_AXIS[0], NECK_AXIS[1], 142.5), (NECK_AXIS[0], NECK_AXIS[1], 149.5), 7.2, 5.4)
TRAPS = [((1.0 * s, 7.2, 146.8), (15.0 * s, 5.8, 140.8), 4.0, 3.6) for s in (1, -1)]

# Target perimeters in cm: estimates for a muscular 178 cm man, not taken from
# a survey. (height z, perimeter) for each leg and the torso from hips to
# chest, (t along the bone, perimeter) for the upper arms and forearms.
LEG_TARGET = [(9, 22), (16, 25.5), (22, 30.5), (28, 36), (34, 39.5), (40, 37.5), (44, 34.5),
              (49, 35), (54, 40), (60, 49), (66, 55), (72, 58.5), (76, 60)]
TORSO_TARGET = [(80, 95), (88, 89), (96, 80), (102, 73), (108, 72), (114, 78),
                (120, 88), (126, 99), (130, 103)]
UPPER_TARGET = [(0.2, 41), (0.35, 40), (0.5, 39.5), (0.65, 38.5), (0.8, 35), (0.95, 31)]
FORE_TARGET = [(0.1, 30), (0.25, 30), (0.4, 28.5), (0.55, 26.5), (0.7, 23.5),
               (0.85, 20.5), (0.95, 18.5)]
MAX_SCALE = 1.40


def parse_args():
    """Read the options that follow Blender's '--'.

    Exits with a usage message when a path is missing or an option is out of
    range.

    Returns:
        argparse.Namespace with the input and output paths and settings.
    """
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("stl", help="the source figure, data/raw/astra_figure.stl")
    p.add_argument("out", help="where to write the refined STL")
    p.add_argument("--dense", type=float, default=0.35, help="voxel size before deforming, cm")
    p.add_argument("--voxel", type=float, default=0.4, help="voxel size after deforming, cm")
    p.add_argument("--tris", type=int, default=60000)
    p.add_argument("--report", action="store_true", help="print perimeters before and after")
    a = p.parse_args(argv)
    if not os.path.isfile(a.stl):
        p.error("no such STL: %s" % a.stl)
    if a.dense <= 0 or a.voxel <= 0:
        p.error("voxel sizes must be > 0")
    if a.tris < 1000:
        p.error("--tris must be >= 1000")
    return a


def walk_components(nodes, neighbours):
    """Split a graph into connected components by depth-first search.

    Args:
        nodes: iterable of hashable nodes.
        neighbours: function from a node to the nodes it touches.

    Returns:
        List of components, each a list of nodes.
    """
    seen, out = set(), []
    for start in nodes:
        if start in seen:
            continue
        stack, comp = [start], [start]
        seen.add(start)
        while stack:
            for o in neighbours(stack.pop()):
                if o not in seen:
                    seen.add(o)
                    stack.append(o)
                    comp.append(o)
        out.append(comp)
    return out


def cut_loops(me, co, no):
    """Cut the mesh with a plane and return each closed loop's centre and perimeter.

    Args:
        me: the mesh (not changed).
        co, no: a point on the plane and its normal.

    Returns:
        List of (centre Vector, perimeter float).
    """
    bm = bmesh.new()
    bm.from_mesh(me)
    r = bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:],
                               plane_co=co, plane_no=no)
    adj = {}
    for e in r["geom_cut"]:
        if isinstance(e, bmesh.types.BMEdge):
            a, b = e.verts
            ln = e.calc_length()
            adj.setdefault(a, []).append((b, ln))
            adj.setdefault(b, []).append((a, ln))
    out = []
    for comp in walk_components(adj, lambda v: [o for o, _ in adj[v]]):
        per = sum(ln for v in comp for _, ln in adj[v]) / 2
        out.append((sum((p.co for p in comp), Vector()) / len(comp), per))
    bm.free()
    return out


def interp(x, table):
    """Look up x in a sorted (x, y) table, piecewise linear and clamped at the ends.

    Args:
        x: a number or array.
        table: list of (x, y) pairs sorted by x.

    Returns:
        The interpolated y, same shape as x.
    """
    xs, ys = zip(*table)
    return np.interp(x, xs, ys)


def smoothstep(e0, e1, x):
    """Step smoothly from 0 at e0 to 1 at e1 (Hermite), elementwise.

    Args:
        e0, e1: the edges of the step.
        x: a number or array.

    Returns:
        Values in 0..1, same shape as x.
    """
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def scale_to_target(actual, target):
    """Give the radial scale that takes an actual perimeter to its target.

    Args:
        actual: measured perimeter, cm.
        target: wanted perimeter, cm.

    Returns:
        A float between 1 and MAX_SCALE; never below 1, so nothing gets thinner.
    """
    return float(min(MAX_SCALE, max(1.0, target / actual))) if actual > 0 else 1.0


def measure(me, report):
    """Measure the leg, torso and arm sections and turn them into scale profiles.

    Args:
        me: the fitted mesh.
        report: collect the measured perimeters for printing.

    Returns:
        (profiles dict, report dict). Leg and torso profiles are lists of
        (z, centre x, centre y, scale); arm profiles are lists of (t, scale).
    """
    rep = {"legs": [], "torso": [], "arms": {}}
    legs = {1: [], -1: []}
    for z in np.arange(8, CROTCH_Z + 0.1, 2.0):
        for c, per in cut_loops(me, (0, 0, z), (0, 0, 1)):
            if abs(c.x) > 25:
                continue
            side = 1 if c.x > MIDLINE_X else -1
            legs[side].append((z, c.x, c.y, scale_to_target(per, interp(z, LEG_TARGET))))
            if report and side == 1:
                rep["legs"].append((float(z), round(per, 1)))
    torso = []
    for z in np.arange(CROTCH_Z + 2, TORSO_TOP_Z + 0.1, 2.0):
        loops = [(c, p) for c, p in cut_loops(me, (0, 0, z), (0, 0, 1)) if abs(c.x) < 10]
        if loops:
            c, per = max(loops, key=lambda q: q[1])
            torso.append((z, c.x, c.y, scale_to_target(per, interp(z, TORSO_TARGET))))
            if report:
                rep["torso"].append((float(z), round(per, 1)))
    if not (legs[1] and legs[-1] and torso):
        sys.exit("no leg or torso sections found: is the STL a standing figure, Z up, "
                 "soles at the bottom?")
    arms = {}
    for side, (sh, el, wr) in ARMS.items():
        prof = {}
        for name, a, b, table in (("upper", sh, el, UPPER_TARGET), ("fore", el, wr, FORE_TARGET)):
            d = (b - a).normalized()
            rows = []
            for t, tgt in table:
                p = a + (b - a) * t
                loops = sorted(cut_loops(me, p, d), key=lambda q: (q[0] - p).length)
                if loops and (loops[0][0] - p).length < 4:
                    rows.append((t, scale_to_target(loops[0][1], tgt)))
                    if report:
                        rep["arms"].setdefault(side + " " + name, []).append(
                            (t, round(loops[0][1], 1)))
            if not rows:
                sys.exit("no %s %s-arm sections near the joints in body_from_stl.py; "
                         "were they measured on this figure?" % (side, name))
            prof[name] = rows
        arms[side] = prof
    return {"legs": legs, "torso": torso, "arms": arms}, rep


def profile_at(rows, z):
    """Read a (z, centre x, centre y, scale) profile at heights z.

    The scales are averaged with their neighbours first, so one odd section
    does not make a bump.

    Args:
        rows: profile rows from measure().
        z: array of heights.

    Returns:
        (centre x, centre y, scale - 1) arrays, same shape as z.
    """
    rows = sorted(rows)
    zs = [r[0] for r in rows]
    s = [r[3] for r in rows]
    s = [sum(s[max(0, i - 1):i + 2]) / len(s[max(0, i - 1):i + 2]) for i in range(len(s))]
    return (np.interp(z, zs, [r[1] for r in rows]), np.interp(z, zs, [r[2] for r in rows]),
            np.interp(z, zs, s) - 1)


def head_distance(co):
    """Measure each point's distance from the head's centre, in head radii.

    Args:
        co: (N, 3) array of points.

    Returns:
        (N,) array: below 1 inside the head ellipsoid, above 1 outside.
    """
    return np.sqrt((((co - np.array(HEAD_CENTRE)) / np.array(HEAD_RADII)) ** 2).sum(1))


def displace(co, prof):
    """Move the dense mesh's vertices by the blended scale fields.

    Legs and torso scale about the loop centre at each height; the legs add
    less on the inner thigh, to keep a gap, and more on the calf and quads.
    The torso adds less front to back than side to side. Arms scale about
    their bones and the head uniformly about the top of the neck.

    Args:
        co: (N, 3) vertex array in the 178 cm frame.
        prof: profiles from measure().

    Returns:
        The displaced (N, 3) array.
    """
    x, y, z = co[:, 0], co[:, 1], co[:, 2]
    disp = np.zeros_like(co)

    # legs, below the crotch, blended into the torso field across it
    leg_d = np.zeros_like(co)
    for side in (1, -1):
        cx, cy, s = profile_at(prof["legs"][side], z)
        s *= smoothstep(5.0, 9.0, z)                         # leave the feet alone
        mine = (x > MIDLINE_X) if side == 1 else (x <= MIDLINE_X)
        u = (x - cx) * side                                  # + is the outer side
        w = -(y - cy)                                        # + is the front
        inner = np.interp(z, [8, 26, 38, 46, 50, 58, 66, 78], [1.0, 1.25, 1.25, 1.0, 1.0, 0.6, 0.35, 0.2])
        outer = np.interp(z, [8, 26, 38, 46, 56, 70, 78], [1.0, 0.85, 0.85, 1.0, 1.15, 1.15, 1.0])
        front = np.interp(z, [8, 50, 56, 70, 78], [0.8, 1.0, 1.15, 1.15, 1.0])
        back = np.interp(z, [8, 22, 30, 38, 46, 78], [1.0, 1.0, 1.35, 1.35, 1.0, 1.0])
        du = u * s * np.where(u > 0, outer, inner)
        dw = w * s * np.where(w > 0, front, back)
        leg_d[mine, 0] = (du * side)[mine]
        leg_d[mine, 1] = (-dw)[mine]

    tcx, tcy, ts = profile_at(prof["torso"], z)
    ts *= 1 - smoothstep(TORSO_TOP_Z - 6, TORSO_TOP_Z, z)
    torso_d = np.stack([(x - tcx) * ts, (y - tcy) * ts * 0.75, np.zeros_like(z)], 1)
    wt = smoothstep(CROTCH_Z - 6, CROTCH_Z + 2, z)[:, None]
    disp += leg_d * (1 - wt) + torso_d * wt

    # head: uniform about the top of the neck, weighted by distance from the
    # head's centre so the jaw and the neck below it move together
    head_w = 1 - smoothstep(1.0, 1.35, head_distance(co))
    disp += (co - np.array(HEAD_PIVOT)) * ((HEAD_SCALE - 1) * head_w)[:, None]

    # arms: radial about each bone, softly shared between upper arm and forearm
    for side, (sh, el, wr) in ARMS.items():
        fields, dists = [], []
        for name, a, b in (("upper", sh, el), ("fore", el, wr)):
            a, b = np.array(a), np.array(b)
            ab = b - a
            t = np.clip(((co - a) @ ab) / (ab @ ab), -0.2, 1.2)
            r = co - (a + t[:, None] * ab)
            dist = np.linalg.norm(r, axis=1)
            rows = prof["arms"][side][name]
            s = np.interp(np.clip(t, 0, 1), [q[0] for q in rows], [q[1] for q in rows]) - 1
            if name == "upper":
                s *= smoothstep(0.05, 0.25, t)               # deltoid and armpit stay
            else:
                s *= 1 - smoothstep(0.97, 1.05, t)           # fist stays
            s *= 1 - smoothstep(8.0, 11.0, dist)
            fields.append(r * s[:, None])
            dists.append(dist + 3.0 * np.maximum(0, np.maximum(-t, t - 1)) * np.linalg.norm(ab))
        upper_share = 1 / (1 + np.exp(dists[0] - dists[1]))  # softmin of the two distances
        disp += fields[0] * upper_share[:, None] + fields[1] * (1 - upper_share)[:, None]
    return co + disp


def bake(obj):
    """Apply all modifiers on the object to its mesh, replacing the mesh.

    Args:
        obj: the mesh object.
    """
    dg = bpy.context.evaluated_depsgraph_get()
    new = bpy.data.meshes.new_from_object(obj.evaluated_get(dg))
    old = obj.data
    obj.modifiers.clear()
    obj.data = new
    bpy.data.meshes.remove(old)


def remesh(obj, voxel):
    """Voxel-remesh the object in place into one closed skin.

    Overlapping shells come out as their union.

    Args:
        obj: the mesh object.
        voxel: voxel size, cm.
    """
    m = obj.modifiers.new("Remesh", 'REMESH')
    m.mode, m.voxel_size = 'VOXEL', voxel
    bake(obj)


def add_tube(bm, a, b, ra, rb):
    """Add a closed tapered tube from a to b, with a sphere at each end, as new shells.

    Args:
        bm: the bmesh to add to.
        a, b: end centres (tuples, cm).
        ra, rb: radii at a and b.
    """
    a, b = Vector(a), Vector(b)
    d = b - a
    rot = d.to_track_quat('Z', 'Y').to_matrix().to_4x4()
    mid = Matrix.Translation((a + b) / 2) @ rot
    bmesh.ops.create_cone(bm, cap_ends=True, segments=32, radius1=ra, radius2=rb,
                          depth=d.length, matrix=mid)
    for c, r in ((a, ra), (b, rb)):
        bmesh.ops.create_uvsphere(bm, u_segments=32, v_segments=16, radius=r,
                                  matrix=Matrix.Translation(c))


def add_volumes(obj):
    """Add the neck flare and trapezius tubes to the mesh, for a remesh to merge.

    Args:
        obj: the mesh object, changed in place.
    """
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    for a, b, ra, rb in [NECK_FLARE] + TRAPS:
        add_tube(bm, a, b, ra, rb)
    bm.to_mesh(obj.data)
    bm.free()


def smooth_where(obj, weights, iterations):
    """Laplacian-smooth the object, keeping volume, each vertex by its weight.

    Args:
        obj: the mesh object, changed in place.
        weights: (N,) array in 0..1, one per vertex.
        iterations: smoothing iterations at factor 0.5.
    """
    vg = obj.vertex_groups.new(name="smooth")
    rounded = np.round(weights, 2)
    for w in np.unique(rounded):
        if w > 0:
            vg.add(np.nonzero(rounded == w)[0].tolist(), float(w), 'REPLACE')
    m = obj.modifiers.new("Smooth", 'LAPLACIANSMOOTH')
    m.iterations, m.lambda_factor, m.use_volume_preserve = iterations, 0.5, True
    m.vertex_group = vg.name
    bake(obj)
    obj.vertex_groups.clear()


def read_coords(me):
    """Read a mesh's vertex positions.

    Args:
        me: the mesh.

    Returns:
        (N, 3) float array.
    """
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("co", co)
    return co.reshape(-1, 3)


def inspect_mesh(me):
    """Count a mesh's triangles, shells and non-manifold edges.

    Args:
        me: the mesh (not changed).

    Returns:
        Dict with tris, shells and nonmanifold_edges.
    """
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    out = {"tris": len(bm.faces),
           "shells": len(walk_components(bm.verts, lambda v: [e.other_vert(v) for e in v.link_edges])),
           "nonmanifold_edges": sum(1 for e in bm.edges if not e.is_manifold)}
    bm.free()
    return out


def main():
    """Refine the STL, check it is one manifold shell, write it and print a summary."""
    a = parse_args()
    obj = import_stl(os.path.abspath(a.stl))
    fit_height(obj.data, JOINT_FRAME_CM)
    prof, rep = measure(obj.data, a.report)
    remesh(obj, a.dense)
    me = obj.data
    me.vertices.foreach_set("co", displace(read_coords(me), prof).ravel())
    me.update()
    add_volumes(obj)
    remesh(obj, a.dense)
    # blend the neck, trapezius and shoulders, and the crease at the hips
    co = read_coords(obj.data)
    r = np.hypot(co[:, 0] - NECK_AXIS[0], co[:, 1] - NECK_AXIS[1])
    neck = (smoothstep(134.0, 143.0, co[:, 2]) * (1 - smoothstep(150.0, 154.0, co[:, 2]))
            * (1 - smoothstep(12.0, 22.0, r)))
    hips = smoothstep(80.0, 88.0, co[:, 2]) * (1 - smoothstep(94.0, 102.0, co[:, 2])) * 0.5
    smooth_where(obj, np.maximum(neck, hips), 20)
    # light pass everywhere, lighter on the face so its features survive
    face = 1 - smoothstep(0.9, 1.2, head_distance(read_coords(obj.data)))
    smooth_where(obj, 1 - 0.7 * face, 3)
    remesh(obj, a.voxel)
    dec = obj.modifiers.new("Dec", 'DECIMATE')
    dec.ratio = min(1.0, a.tris / max(1, 2 * len(obj.data.polygons)))
    bake(obj)
    # refit, in case the edits moved the bounding box; report how far that
    # moves the joints body_from_stl.py uses
    refit = fit_height(obj.data, JOINT_FRAME_CM)
    summary = inspect_mesh(obj.data)
    summary["joint_drift_cm"] = round(max((refit(j) - j).length
                                          for js in ARMS.values() for j in js), 3)
    if summary["shells"] != 1 or summary["nonmanifold_edges"]:
        sys.exit("refined mesh is not one manifold shell: %s" % json.dumps(summary))
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    bpy.ops.wm.stl_export(filepath=os.path.abspath(a.out), export_selected_objects=True,
                          ascii_format=False, apply_modifiers=True)
    if a.report:
        _, after = measure(obj.data, True)
        summary["before"], summary["after"] = rep, after
    print("SUMMARY " + json.dumps(summary))


if __name__ == "__main__":
    main()
