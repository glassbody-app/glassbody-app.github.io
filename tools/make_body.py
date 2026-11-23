"""Hologram body, pass 8 — measured anthropometry, one watertight surface.

Writes data/body.json (and, with --preview, data/prev_{front,three,side}.png).
The output path is found from this file's location, so any working directory
works. Run it with the Blender app (tested on 5.2.3, macOS):

  /Applications/Blender.app/Contents/MacOS/Blender -b -P tools/make_body.py -- --preview

or with Blender as a Python module (`pip install bpy`, about 400 MB; each bpy
release installs on one Python minor version only, so pick the release that
matches your Python; that route was used for earlier passes and not retested
on this one):

  python3 tools/make_body.py --preview

Dimensions come from 50th-percentile adult male anthropometric tables
(stature 174.5 cm), scaled to a 178 cm figure (x1.020). The written mesh
measures 181.3 cm sole to crown, because the metaball surface sits outside
the station centres the 178 cm is laid out on.

  bideltoid (shoulder, across deltoids) 49.5    biacromial (bone) 41.3
  chest depth 25.0                              hip breadth 39.8
  head breadth 15.8   head length 20.4          shoulder height 147.4
  elbow height 112.2  knee height 54.6          foot length 27.0
  hand length 19.4

Pass 5 hit those numbers and came out heavy: 50th-percentile tables describe a
population that skews overweight, and large shaping accents piled more on top.
Pass 6 keeps the skeletal landmarks (shoulder, elbow, knee, foot, head) but trims
the soft tissue to an athletic-average build with a real V-taper — chest and hips
about equal in breadth, waist clearly narrower — and cuts the accents back to
shaping rather than mass.

Pass 7: the arms were welding themselves to the ribcage, because metaball fields
bridge any small gap. Arms (and the deltoid) now live in a SEPARATE metaball
object — Blender only blends metaballs sharing a name stem — so the negative
space between arm and torso survives.

Pass 8: two overlapping closed surfaces look fine opaque, but the hologram shader
is additive and transparent, so their interiors showed through as hollows at the
shoulders. A voxel remesh fuses arm and torso into ONE watertight skin with no
interior faces, which is what the shader needs.

Sections are built from PAIRS of metaballs offset along one axis, so a station's
half-width is (spread + r) across that axis and r in the other. Head stations
spread along y, because the head is deeper than it is wide.
"""
import bpy, bmesh, math, json, os, sys

TARGET_TRIS = 7600
RES = 0.5
K = 1.0 / 0.72
STEP = 2.2
# tools/ -> repo root -> data/body.json; previews land beside it as prev_*.png
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "body.json")

# bone: (a, b, r_a, r_b, spread_a, spread_b, axis)
SPINE = [
    # pelvis -> hips: hip breadth 39.8 means half-width 19.9 at the trochanters
    ((0,-1.5,85),(0,-1.0,94),   10.6, 11.5,  4.0, 6.5, 'x'),
    ((0,-1.0,94),(0,0.6,102),   11.5, 10.6,  6.5, 5.6, 'x'),
    ((0,0.6,102),(0,1.2,110),   10.4,  9.4,  5.2, 4.2, 'x'),   # lumbar, forward
    ((0,1.2,110),(0,0.6,118),    9.4, 10.8,  4.2, 5.2, 'x'),   # waist, narrowest
    ((0,0.6,118),(0,-0.6,128),  11.0, 12.0,  5.4, 6.0, 'x'),   # chest depth 24
    ((0,-0.6,128),(0,-1.6,138), 12.0, 11.2,  6.0, 6.4, 'x'),   # thoracic, back
    ((0,-1.6,138),(0,-2.2,147), 11.2, 10.0, 6.4, 10.6, 'x'),   # biacromial 41.3
    ((0,-2.2,147),(0,-1.8,152), 10.0,  7.8, 10.6, 2.0, 'x'),
    ((0,-1.8,152),(0,-0.6,156),  7.2,  6.6,  0.8, 0.4, 'x'),   # neck, forward
]
# head: deeper than wide, so the pair spreads along y
HEAD = [
    ((0,0.4,156),(0,1.4,160),    6.6, 6.8,  0.6, 1.6, 'y'),    # jaw underside / chin
    ((0,1.4,160),(0,0.4,164),    6.8, 7.7,  1.6, 2.2, 'y'),    # jaw, cheek
    ((0,0.4,164),(0,-0.8,168.5), 8.0, 8.3,  2.3, 2.5, 'y'),    # ear line, widest
    ((0,-0.8,168.5),(0,-1.2,173),8.3, 7.8,  2.5, 2.3, 'y'),    # cranium
    ((0,-1.2,173),(0,-1.0,176.5),7.8, 5.9,  2.3, 1.6, 'y'),
    ((0,-1.0,176.5),(0,-0.8,178),5.6, 3.0,  1.5, 0.8, 'y'),    # crown
]
ARM = [
    ((11.0,-2.0,146.5),(19.4,-0.8,145.5), 7.4, 6.4, 0,0,'x'),
    ((19.4,-0.8,145.5),(21.2,0.4,130), 6.4, 5.5, 0,0,'x'),
    ((21.2,0.4,130),(22.4,1.0,112.2), 5.5, 4.6, 0,0,'x'),      # elbow height 112.2
    ((22.4,1.0,112.2),(23.2,1.2,99),  4.6, 4.2, 0,0,'x'),
    ((23.2,1.2,99),(23.8,1.2,86),     4.2, 3.1, 0,0,'x'),      # wrist
    ((23.8,1.2,86),(24.2,2.0,79),     2.3, 2.1, 1.7, 2.1, 'x'),# palm
    ((24.2,2.0,79),(24.4,2.8,66.6),   2.1, 1.3, 2.1, 1.5, 'x'),# hand length 19.4
]
LEG = [
    ((4.5,-1.0,88),(9.8,-0.6,88),  9.2, 9.0, 1.6, 0.8, 'x'),
    ((9.8,-0.6,88),(10.4,0,74),  9.0, 8.4, 0.8, 0.4, 'x'),     # thigh
    ((10.4,0,74),(10.8,0.6,64),  8.4, 7.4, 0.4, 0.2, 'x'),
    ((10.8,0.6,64),(11.0,1.2,54.6), 7.4, 5.7, 0.2, 0.0, 'x'),  # knee height 54.6
    ((11.0,1.2,54.6),(11.0,-1.6,40), 5.7, 6.2, 0,0,'x'),       # calf
    ((11.0,-1.6,40),(11.0,-0.2,24),  6.2, 4.5, 0,0,'x'),
    ((11.0,-0.2,24),(11.0,0.4,7.5),  4.5, 3.4, 0,0,'x'),       # ankle
]
FOOT = [
    ((11.0,0.4,7.5),(11.0,-6.0,4.6), 3.5, 3.2, 0,0,'x'),       # heel
    ((11.0,0.4,7.0),(11.0,3.0,3.8),  2.9, 2.7, 0.6, 1.0, 'x'), # arch
    ((11.0,3.0,3.8),(11.0,12.0,3.2), 2.7, 2.5, 1.0, 1.7, 'x'), # ball
    ((11.0,12.0,3.2),(11.0,21.0,2.6),2.5, 1.7, 1.7, 1.5, 'x'), # toes, foot length 27
]
# (pos, r, spread, axis)
ACCENT = [
    ((18.8, -0.8, 141.5), 6.0, 0.0, 'x'),   # deltoid -> bideltoid ~49.6
    ((9.6, -3.4, 148.0),  4.8, 0.0, 'x'),   # trapezius
    ((6.8, -6.2, 92.0),   7.4, 1.0, 'x'),   # gluteal
    ((0.0, 3.4, 110.0),   6.8, 2.0, 'x'),   # abdomen, gentle
    ((6.8, 4.2, 130.0),   6.2, 0.0, 'x'),   # pectoral
    ((10.6, 4.2, 70.0),   6.6, 0.0, 'x'),   # quadriceps
    ((10.6, -4.6, 74.0),  6.2, 0.0, 'x'),   # hamstring
    ((11.0, -3.2, 38.0),  5.2, 0.0, 'x'),   # calf belly
    ((8.8, -1.5, 167.0),  1.9, 0.0, 'x'),   # ear, closer to the skull
]

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

def new_field(stem):
    """Create a metaball field named stem; return (metaball data, object)."""
    # Blender blends metaballs that share a name stem, so two stems = two fields.
    mb = bpy.data.metaballs.new(stem)
    mb.resolution = RES
    mb.render_resolution = RES
    mb.threshold = 0.6
    o = bpy.data.objects.new(stem, mb)
    scene.collection.objects.link(o)
    return mb, o

MB_BODY, OB_BODY = new_field("torso")
MB_ARM, OB_ARM = new_field("limb")

def emit(mb, p, r, spread, axis):
    """Add mirrored balls of radius r at point p, split by spread along axis."""
    offs = [0.0] if spread <= 0.01 else [spread, -spread]
    for o in offs:
        q = list(p)
        q[0 if axis == 'x' else 1] += o
        for sx in (1, -1):
            if sx == -1 and abs(q[0]) < 1e-6:
                continue
            e = mb.elements.new(); e.type = 'BALL'
            e.co = (q[0]*sx, q[1], q[2]); e.radius = r*K; e.stiffness = 2.0

def run(mb, bones):
    """Lay balls along each bone segment, interpolating radius and spread."""
    for (a, b, ra, rb, sa, sb, axis) in bones:
        steps = max(1, int(round(math.dist(a, b) / STEP)))
        for i in range(steps + 1):
            t = i/steps
            emit(mb, (a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t),
                 ra+(rb-ra)*t, sa+(sb-sa)*t, axis)

for g in (SPINE, HEAD, LEG, FOOT):
    run(MB_BODY, g)
run(MB_ARM, ARM)
for (p, r, sp, axis) in ACCENT:
    emit(MB_ARM if p[2] > 138.0 and abs(p[0]) > 14.0 else MB_BODY, p, r, sp, axis)

bpy.context.view_layer.update()
dg = bpy.context.evaluated_depsgraph_get()
joined = bmesh.new()
for ob in (OB_BODY, OB_ARM):
    md = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    joined.from_mesh(md)
    bpy.data.meshes.remove(md)
src = bpy.data.meshes.new("src")
joined.to_mesh(src)
joined.free()
body = bpy.data.objects.new("body", src)
scene.collection.objects.link(body)

# Fuse the two overlapping shells into a single skin, discarding interior faces.
rm = body.modifiers.new("Fuse", 'REMESH')
rm.mode = 'VOXEL'
rm.voxel_size = 1.1
rm.use_smooth_shade = True
dg = bpy.context.evaluated_depsgraph_get()
_fused = bpy.data.meshes.new_from_object(body.evaluated_get(dg))
start_tris = sum(len(p.vertices)-2 for p in _fused.polygons)
bpy.data.meshes.remove(_fused)
dec = body.modifiers.new("Dec", 'DECIMATE'); dec.decimate_type = 'COLLAPSE'
dec.ratio = min(1.0, float(TARGET_TRIS)/max(1, start_tris))
sm = body.modifiers.new("Smooth", 'SMOOTH'); sm.factor = 0.45; sm.iterations = 3

dg = bpy.context.evaluated_depsgraph_get()
baked = bpy.data.meshes.new_from_object(body.evaluated_get(dg))
bm = bmesh.new(); bm.from_mesh(baked)
bmesh.ops.triangulate(bm, faces=bm.faces[:]); bm.to_mesh(baked); bm.free()

EAR = [(8.8, -1.5, 167.0), (-8.8, -1.5, 167.0)]
def region_of(c):
    """Return the region id for a triangle centre c, in centimetres."""
    for e in EAR:
        if (c[0]-e[0])**2 + (c[1]-e[1])**2 + (c[2]-e[2])**2 < 5.4**2:
            return "sound"
    if abs(c[0]) > 17.5 and c[2] > 62.0:
        return "heart"
    if c[2] > 153.5:
        return "sleep"
    if c[2] > 119.0:
        return "heart"
    if c[2] > 84.0:
        return "fuel"
    return "move"

verts = [v.co for v in baked.vertices]
# The metaball surface stops about 1 cm above the lowest soles' centres; drop the
# figure so the soles touch y=0, as holo.js expects.
FLOOR = min(co.z for co in verts)
buckets = {k: [] for k in ("move","heart","sleep","sound","fuel")}
for p in baked.polygons:
    c = p.center
    buckets[region_of((c.x, c.y, c.z))].append(tuple(p.vertices))

out = {"units":"cm","up":"y","regions":{}}
for name, tris in buckets.items():
    remap, pos, idx = {}, [], []
    for tri in tris:
        for vi in tri:
            if vi not in remap:
                remap[vi] = len(pos)//3
                co = verts[vi]
                pos += [round(co.x,1), round(co.z-FLOOR,1), round(-co.y,1)]
            idx.append(remap[vi])
    out["regions"][name] = {"pos":pos, "idx":idx}
out["height"] = round(max(co.z for co in verts) - FLOOR, 1)
out["tris"] = sum(len(v["idx"])//3 for v in out["regions"].values())
out["verts"] = sum(len(v["pos"])//3 for v in out["regions"].values())
with open(OUT, "w") as f:
    json.dump(out, f, separators=(",",":"))

def breadth(z0, tol=1.6):
    """Return the full width of the mesh at height z0, or None if no vertices."""
    w = [abs(v.co.x) for v in baked.vertices if abs(v.co.z-z0) < tol]
    return round(2*max(w), 1) if w else None
def depth(z0, tol=1.6):
    """Return the front-to-back depth of the torso at height z0, or None."""
    w = [v.co.y for v in baked.vertices if abs(v.co.z-z0) < tol and abs(v.co.x) < 14]
    return round(max(w)-min(w), 1) if w else None

if "--preview" in sys.argv:
    scene.render.engine = 'BLENDER_WORKBENCH'
    scene.display.shading.light = 'STUDIO'
    scene.display.shading.show_cavity = True
    scene.render.resolution_x, scene.render.resolution_y = 520, 900
    cd = bpy.data.cameras.new("c"); cd.type = 'ORTHO'; cd.ortho_scale = 200
    cam = bpy.data.objects.new("c", cd); scene.collection.objects.link(cam)
    scene.camera = cam
    OB_BODY.hide_render = True
    OB_ARM.hide_render = True
    for tag, loc, rot in (
        ("front", (0,-400,89), (math.radians(90),0,0)),
        ("three", (300,-300,89), (math.radians(90),0,math.radians(45))),
        ("side",  (400,0,89),  (math.radians(90),0,math.radians(90))),
    ):
        cam.location = loc; cam.rotation_euler = rot
        scene.render.filepath = os.path.join(os.path.dirname(OUT), "prev_%s.png" % tag)
        bpy.ops.render.render(write_still=True)

print(json.dumps({
    "height": out["height"], "tris": out["tris"], "verts": out["verts"],
    "measured_vs_target": {
        "shoulder_bideltoid": [breadth(141), 49.5],
        "chest_depth": [depth(128), 25.0],
        "hip_breadth": [breadth(94), 39.8],
        "waist_breadth": [breadth(110), None],
        "head_breadth": [breadth(168), 15.8],
        "head_depth": [depth(168), 20.4],
    },
    "bytes": os.path.getsize(OUT),
}, indent=1))
