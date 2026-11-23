"""Hologram body from the refined figure STL.

Writes data/body.json (and, with --preview, data/prev_{front,three}.png) from
the muscular male with raised fists that tools/refine_figure.py makes out of
data/raw/astra_figure.stl, 60,000 triangles:

  /Applications/Blender.app/Contents/MacOS/Blender -b -P tools/refine_figure.py -- \\
      data/raw/astra_figure.stl figure/refined.stl
  /Applications/Blender.app/Contents/MacOS/Blender -b -P tools/body_from_stl.py -- \\
      figure/refined.stl --preview

Grew out of an earlier script that only centred, scaled and split the faces
into regions. This version can also change the figure:

  --arms DEG    re-pose the arms with a Blender armature and automatic (heat)
                weights, upper arm DEG out from hanging straight down. Joints
                are measured off this mesh and hardcoded, because automatic
                joint-finding fails on an asymmetric pose (docs/architecture.md
                §5). Not tried on this figure; on the previous one the
                shoulders rose above the chin line and the head, neck and ear
                rules painted the upper chest, so check the regions before a
                re-posed figure is used.
  --voxel CM    voxel-remesh into one watertight skin. The additive shader
                shows any interior faces as hollows, so this also guards
                against overlapping shells.
  --tris N      decimate the remeshed skin to about N triangles.
  --smooth K    smoothing iterations after decimation; with a remesh the
                figure is written with flat:false so it shades smooth.
  --slim CM     move the remeshed surface inward by CM along its normals.

With --voxel 0 the STL's facets are kept and the page shades them flat.
The defaults (--voxel 0.7 --tris 9000 --smooth 2, no re-pose, no slimming)
reproduce data/body.json byte for byte.
Output is Y up, centimetres, soles at y=0, scaled to --height cm.
"""
import argparse
import json
import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Quaternion, Vector

# The joints below are measured at this height, whatever --height asks for.
JOINT_FRAME_CM = 178.0
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REGIONS = ("move", "heart", "sleep", "sound", "fuel")

# Joints in the frame fit_height() leaves the STL in (178 cm, centred, soles at
# z=0, facing -y), from sections perpendicular to each arm; right arm is +x.
# tools/refine_figure.py imports them.
SHOULDER_R, ELBOW_R, WRIST_R = (Vector((18, 3.7, 138.3)), Vector((44.3, 3.5, 148.7)),
                                Vector((36.2, 2.8, 167)))
SHOULDER_L, ELBOW_L, WRIST_L = (Vector((-18, 3.7, 139.2)), Vector((-44.3, 3.6, 145.3)),
                                Vector((-35.2, 2.9, 166.5)))
TRUNK = [  # head, spine and legs: what an arm vertex is compared against
    (Vector((0, 0, 86)), Vector((0, 0, 177))),
    (Vector((9.5, 0, 88)), Vector((10, 0, 50))), (Vector((10, 0, 50)), Vector((10, 0, 4))),
    (Vector((-9.5, 0, 88)), Vector((-10, 0, 50))), (Vector((-10, 0, 50)), Vector((-10, 0, 4))),
]


def parse_args():
    """Read the options that follow Blender's '--' (or all of argv under bpy).

    Exits with a usage message when an option is out of range. Under the
    Blender app the '--' is required, or Blender's own flags reach argparse.

    Returns:
        argparse.Namespace with the STL path and the figure settings.
    """
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("stl", help="the refined figure, e.g. figure/refined.stl")
    p.add_argument("--out", default=os.path.join(ROOT, "data", "body.json"))
    p.add_argument("--height", type=float, default=JOINT_FRAME_CM)
    p.add_argument("--arms", type=float, default=None, help="upper-arm degrees from vertical")
    p.add_argument("--fore", type=float, default=None,
                   help="forearm degrees (default: --arms - 6)")
    p.add_argument("--voxel", type=float, default=0.7)
    p.add_argument("--tris", type=int, default=9000)
    p.add_argument("--smooth", type=int, default=2)
    p.add_argument("--slim", type=float, default=0.0)
    p.add_argument("--preview", action="store_true")
    a = p.parse_args(argv)
    if not os.path.isfile(a.stl):
        p.error("no such STL: %s" % a.stl)
    if a.height <= 0:
        p.error("--height must be > 0")
    if a.voxel < 0:
        p.error("--voxel must be >= 0 (0 keeps the STL's facets)")
    if a.tris < 100:
        p.error("--tris must be >= 100")
    if a.smooth < 0:
        p.error("--smooth must be >= 0")
    if a.slim < 0:
        p.error("--slim must be >= 0; it only moves the surface inward")
    for name in ("arms", "fore"):
        deg = getattr(a, name)
        if deg is not None and not 0 <= deg <= 180:
            p.error("--%s must be between 0 and 180 degrees" % name)
    if a.fore is not None and a.arms is None:
        p.error("--fore needs --arms")
    if a.slim and not a.voxel:
        p.error("--slim needs --voxel: the raw STL is not one closed skin")
    return a


def import_stl(path):
    """Load the STL into an empty scene, merged and triangulated.

    Args:
        path: absolute path to the STL.

    Returns:
        The mesh object.
    """
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.wm.stl_import(filepath=path)
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    if not meshes:
        sys.exit("no mesh in STL: %s" % path)
    obj = meshes[0]
    obj.name = "body"
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-4)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bm.to_mesh(obj.data)
    bm.free()
    return obj


def fit_height(me, height):
    """Centre x and y, put the soles at z=0 and scale to the given height.

    Args:
        me: the mesh, changed in place.
        height: target height in cm.

    Returns:
        A function applying the same transform to a Vector, for the joints.
    """
    xs = [v.co.x for v in me.vertices]
    ys = [v.co.y for v in me.vertices]
    zs = [v.co.z for v in me.vertices]
    c = Vector(((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2, min(zs)))
    s = height / (max(zs) - min(zs))
    for v in me.vertices:
        v.co = (v.co - c) * s
    me.update()
    return lambda p: (p - c) * s


def rot_to(a, b):
    """Shortest rotation taking direction a onto direction b.

    Args:
        a, b: direction Vectors, any length.

    Returns:
        A Quaternion.
    """
    a, b = a.normalized(), b.normalized()
    d = max(-1.0, min(1.0, a.dot(b)))
    if d > 0.999999:
        return Quaternion((1, 0, 0, 0))
    ax = a.cross(b)
    if ax.length < 1e-9:
        ax = Vector((0, 0, 1))
    return Quaternion(ax.normalized(), math.acos(d))


def pose_arms(obj, upper_deg, fore_deg):
    """Swing both arms down with an armature, then bake the pose into the mesh.

    A bone for every body part gives automatic weights no orphan vertices.
    Setting pose_bone.matrix once only gets part way, because the parent chain
    re-evaluates, so each bone is nudged toward its target until it sticks.

    Args:
        obj: the mesh object, in the joint frame; its mesh is replaced.
        upper_deg: upper-arm angle out from hanging straight down.
        fore_deg: forearm angle, measured the same way.

    Returns:
        The four posed arm segments as (head, tail) Vector pairs.
    """
    scene = bpy.context.scene
    rig = bpy.data.objects.new("rig", bpy.data.armatures.new("rig"))
    scene.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode='EDIT')
    eb = rig.data.edit_bones

    def bone(name, head, tail, parent=None, connect=False):
        """Add an edit bone from head to tail and return it."""
        b = eb.new(name)
        b.head, b.tail, b.parent, b.use_connect = head, tail, parent, connect
        return b

    pelvis = bone("pelvis", Vector((0, 0, 86)), Vector((0, 0, 110)))
    chest = bone("chest", Vector((0, 0, 110)), Vector((0, 0, 142)), pelvis, True)
    neck = bone("neck", Vector((0, 0, 142)), Vector((0, 0, 155)), chest, True)
    bone("head", Vector((0, 0, 155)), Vector((0, 0, 177)), neck, True)
    for t, sh, el, wr in (("R", SHOULDER_R, ELBOW_R, WRIST_R),
                          ("L", SHOULDER_L, ELBOW_L, WRIST_L)):
        clav = bone("clav." + t, Vector((0, 0, 140)), sh, chest)
        up = bone("upper." + t, sh, el, clav, True)
        bone("fore." + t, el, wr, up, True)
    for s, t in ((1, "R"), (-1, "L")):
        th = bone("thigh." + t, Vector((9.5 * s, 0, 88)), Vector((10 * s, 0, 50)), pelvis)
        sn = bone("shin." + t, Vector((10 * s, 0, 50)), Vector((10 * s, 0, 9)), th, True)
        bone("foot." + t, Vector((10 * s, 0, 9)), Vector((10 * s, 14, 4)), sn, True)
    bpy.ops.object.mode_set(mode='OBJECT')

    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.parent_set(type='ARMATURE_AUTO')
    bpy.ops.object.mode_set(mode='POSE')

    def aim(name, deg, sgn, rounds=12):
        """Rotate a pose bone until it points deg degrees out from straight down."""
        tgt = Vector((math.sin(math.radians(deg)) * sgn, 0, -math.cos(math.radians(deg))))
        for _ in range(rounds):
            pb = rig.pose.bones[name]
            if (pb.tail - pb.head).normalized().dot(tgt) > 0.99995:
                break
            q = rot_to(pb.tail - pb.head, tgt)
            pb.matrix = (Matrix.Translation(pb.head) @ q.to_matrix().to_4x4()
                         @ Matrix.Translation(-pb.head) @ pb.matrix)
            bpy.context.view_layer.update()

    for t, sgn in (("R", 1), ("L", -1)):
        aim("upper." + t, upper_deg, sgn)
        aim("fore." + t, fore_deg, sgn)
    segs = [(rig.pose.bones[n].head.copy(), rig.pose.bones[n].tail.copy())
            for n in ("upper.R", "fore.R", "upper.L", "fore.L")]

    bpy.ops.object.mode_set(mode='OBJECT')
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=obj.modifiers[0].name)
    mw = obj.matrix_world.copy()
    bpy.data.objects.remove(rig, do_unlink=True)
    obj.matrix_world = mw
    return segs


def reskin(obj, voxel, tris, smooth, slim):
    """Voxel-remesh into one closed skin, optionally slim it, decimate, smooth.

    Args:
        obj: the mesh object; modifiers are added to it.
        voxel: voxel size in cm.
        tris: target triangle count after decimation.
        smooth: smoothing iterations, 0 for none.
        slim: cm to move the surface inward, 0 for none.

    Returns:
        A new mesh with the modifiers baked in, triangulated.
    """
    rm = obj.modifiers.new("Fuse", 'REMESH')
    rm.mode, rm.voxel_size = 'VOXEL', voxel
    if slim:
        dp = obj.modifiers.new("Slim", 'DISPLACE')
        dp.mid_level, dp.strength = 0.0, -slim
    dg = bpy.context.evaluated_depsgraph_get()
    fused = bpy.data.meshes.new_from_object(obj.evaluated_get(dg))
    start = sum(len(p.vertices) - 2 for p in fused.polygons)
    bpy.data.meshes.remove(fused)
    dec = obj.modifiers.new("Dec", 'DECIMATE')
    dec.decimate_type, dec.ratio = 'COLLAPSE', min(1.0, tris / max(1, start))
    if smooth:
        sm = obj.modifiers.new("Smooth", 'SMOOTH')
        sm.factor, sm.iterations = 0.5, smooth
    dg = bpy.context.evaluated_depsgraph_get()
    baked = bpy.data.meshes.new_from_object(obj.evaluated_get(dg))
    bm = bmesh.new()
    bm.from_mesh(baked)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bm.to_mesh(baked)
    bm.free()
    return baked


def seg_dist(p, a, b):
    """Distance from point p to the segment a-b.

    Args:
        p: the point; a, b: the segment's ends (all Vectors).

    Returns:
        The distance as a float.
    """
    ab = b - a
    t = max(0.0, min(1.0, (p - a).dot(ab) / max(1e-9, ab.length_squared)))
    return (a + ab * t - p).length


def make_region_of(me, height, arm_segs, trunk_segs):
    """Build the face classifier for the five regions on this mesh.

    Head and ears are located on the mesh itself so the ear patches land on the
    real ears; the figure faces -y, so the ears sit a little +y of the head's
    middle. Arm faces are the ones nearer an arm bone than the trunk or legs.

    Args:
        me: the final mesh, in cm, soles at z=0.
        height: the figure's height in cm.
        arm_segs, trunk_segs: lists of (head, tail) Vector pairs.

    Returns:
        A function mapping a face centre (Vector) to a region name.
    """
    head_z, head_x = 0.854 * height, 0.076 * height     # chin line; fists sit outside
    neck_z, neck_x = 0.820 * height, 0.042 * height     # lower and the sternum turns purple
    chest_z, pelvis_z = 0.560 * height, 0.470 * height
    # Measured above the jaw only: lowered arms lift the trapezius over the
    # chin line, and its width would put the ears on the shoulders.
    jaw_z = 0.86 * height
    hp = [v.co for v in me.vertices if v.co.z > jaw_z and abs(v.co.x) < head_x]
    if not hp:
        sys.exit("head not found: no vertices above %.0f cm within %.0f cm of the "
                 "centre line; is the STL Z-up?" % (jaw_z, head_x))
    hx = max(abs(p.x) for p in hp)
    hy = (min(p.y for p in hp) + max(p.y for p in hp)) / 2
    hz0, hz1 = head_z, max(p.z for p in hp)
    ears = [Vector((s * hx * 0.92, hy + 0.30 * hx, hz0 + (hz1 - hz0) * 0.42))
            for s in (1, -1)]
    ear_r = 0.034 * height

    def region_of(c):
        """Return the region id for a face centre c (a Vector, in centimetres)."""
        if any((c - e).length < ear_r for e in ears):
            return "sound"
        if (c.z > head_z and abs(c.x) < head_x) or (c.z > neck_z and abs(c.x) < neck_x):
            return "sleep"
        if c.z > chest_z:
            return "heart"
        if min(seg_dist(c, *s) for s in arm_segs) < min(seg_dist(c, *s) for s in trunk_segs):
            return "heart"                                   # hands hanging below the chest
        if c.z > pelvis_z:
            return "fuel"
        return "move"
    return region_of


def write_json(me, region_of, flat, path):
    """Split the faces by region and write body.json in the holo.js format.

    Blender Z-up becomes three.js Y-up: (x, y, z) -> (x, z, -y).

    Args:
        me: the final mesh.
        region_of: face-centre classifier from make_region_of().
        flat: whether the page should shade facets flat.
        path: where to write the JSON.

    Returns:
        The written dict, without the vertex data, for the summary.
    """
    verts = [v.co for v in me.vertices]
    buckets = {k: [] for k in REGIONS}
    for p in me.polygons:
        buckets[region_of(p.center)].append(tuple(p.vertices))
    out = {"units": "cm", "up": "y", "flat": flat, "regions": {}}
    for name, faces in buckets.items():
        remap, pos, idx = {}, [], []
        for tri in faces:
            for vi in tri:
                if vi not in remap:
                    remap[vi] = len(pos) // 3
                    co = verts[vi]
                    pos += [round(co.x, 1), round(co.z, 1), round(-co.y, 1)]
                idx.append(remap[vi])
        out["regions"][name] = {"pos": pos, "idx": idx}
    out["height"] = round(max(v.z for v in verts), 1)
    out["tris"] = sum(len(r["idx"]) // 3 for r in out["regions"].values())
    out["verts"] = sum(len(r["pos"]) // 3 for r in out["regions"].values())
    with open(path, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    return {"height": out["height"], "tris": out["tris"], "verts": out["verts"],
            "per_region": {k: len(r["idx"]) // 3 for k, r in out["regions"].items()},
            "bytes": os.path.getsize(path)}


def render_previews(me, region_of, folder):
    """Render front and three-quarter region previews as prev_*.png.

    These are opaque, so they do not show hollows; only the page does.

    Args:
        me: the final mesh; its materials are replaced.
        region_of: face-centre classifier from make_region_of().
        folder: where the PNGs go.
    """
    scene = bpy.context.scene
    # approximately the page's --move, --heart, ... colours in css/style.css
    col = {"move": (0.20, 0.88, 1, 1), "heart": (1, 0.36, 0.54, 1), "sleep": (0.65, 0.49, 1, 1),
           "sound": (1, 0.70, 0.33, 1), "fuel": (0.24, 0.91, 0.65, 1)}
    me.materials.clear()
    for name in REGIONS:
        m = bpy.data.materials.new(name)
        m.diffuse_color = col[name]
        me.materials.append(m)
    for p in me.polygons:
        p.material_index = REGIONS.index(region_of(p.center))
    ob = bpy.data.objects.new("preview", me)
    scene.collection.objects.link(ob)
    for o in scene.objects:
        o.hide_render = o is not ob and o.type == 'MESH'
    scene.render.engine = 'BLENDER_WORKBENCH'
    scene.display.shading.color_type = 'MATERIAL'
    scene.display.shading.light = 'STUDIO'
    scene.render.resolution_x, scene.render.resolution_y = 520, 900
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    cam.data.type, cam.data.ortho_scale = 'ORTHO', 200
    scene.collection.objects.link(cam)
    scene.camera = cam
    for tag, loc, rot in (("front", (0, -400, 89), (math.radians(90), 0, 0)),
                          ("three", (300, -300, 89), (math.radians(90), 0, math.radians(45)))):
        cam.location, cam.rotation_euler = loc, rot
        scene.render.filepath = os.path.join(folder, "prev_%s.png" % tag)
        bpy.ops.render.render(write_still=True)


def main():
    """Convert the STL with the given settings and print a summary."""
    a = parse_args()
    obj = import_stl(os.path.abspath(a.stl))
    fit_height(obj.data, JOINT_FRAME_CM)
    arm_segs = [(SHOULDER_R, ELBOW_R), (ELBOW_R, WRIST_R),
                (SHOULDER_L, ELBOW_L), (ELBOW_L, WRIST_L)]
    if a.arms is not None:
        fore = a.fore if a.fore is not None else max(0.0, a.arms - 6)
        arm_segs = pose_arms(obj, a.arms, fore)
    me = reskin(obj, a.voxel, a.tris, a.smooth, a.slim) if a.voxel else obj.data
    refit = fit_height(me, a.height)
    arm_segs = [(refit(h), refit(t)) for h, t in arm_segs]
    trunk = [(refit(h), refit(t)) for h, t in TRUNK]
    region_of = make_region_of(me, a.height, arm_segs, trunk)
    out = os.path.abspath(a.out)
    summary = write_json(me, region_of, flat=not (a.voxel and a.smooth), path=out)
    if a.preview:
        render_previews(me, region_of, os.path.dirname(out))
    print(json.dumps(summary, indent=1))


if __name__ == "__main__":
    main()
