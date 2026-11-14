// 建模小函数：在跑她的代码之前放进同一个命名空间（harness.ts）。目的：让她用几行可靠的调用搭模型，
// 别每次从 bpy.ops 底层拼——底层容易漏「应用缩放」「选中 / 激活」「布尔用哪种算法」，一漏就是破洞或者尺寸不对。
// 约定：单位毫米；box / cylinder / cone / text3d 的 at 是**底面中心**（底面落在 at 的 z 上）；sphere 的 at 是球心。
// 布尔一律 EXACT 算法、做完就应用并删掉工具物体，结果马上是实打实的网格。
// 改这里要同步改 guide.ts 里的说明，并在装了 Blender 的机器上跑 test/blender.test.ts（指南里的示例都在那跑一遍）。
export const HELPERS = String.raw`
import bpy, bmesh, math, mathutils, os

def _activate(o):
    # 删过物体之后 view_layer.objects 里可能还挂着空引用，跳过
    for x in list(bpy.context.view_layer.objects):
        if x is not None and x.select_get():
            x.select_set(False)
    bpy.context.view_layer.objects.active = o
    o.select_set(True)

def _apply(o, location=False, rotation=True, scale=True):
    _activate(o)
    bpy.ops.object.transform_apply(location=location, rotation=rotation, scale=scale)

def _merge(o, dist=0.0005):
    bm = bmesh.new(); bm.from_mesh(o.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=dist)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(o.data); bm.free()

def box(sx, sy, sz, at=(0, 0, 0)):
    """长方体：sx × sy × sz（mm），底面中心在 at"""
    bpy.ops.mesh.primitive_cube_add(size=1, location=(at[0], at[1], at[2] + sz / 2))
    o = bpy.context.object; o.scale = (sx, sy, sz); _apply(o); return o

def cylinder(r, h, at=(0, 0, 0), segments=64):
    """圆柱：半径 r、高 h，底面中心在 at"""
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=h, vertices=segments, location=(at[0], at[1], at[2] + h / 2))
    return bpy.context.object

def cone(r1, r2, h, at=(0, 0, 0), segments=64):
    """圆台 / 圆锥：底半径 r1、顶半径 r2（0 = 尖），底面中心在 at"""
    bpy.ops.mesh.primitive_cone_add(radius1=r1, radius2=r2, depth=h, vertices=segments, location=(at[0], at[1], at[2] + h / 2))
    return bpy.context.object

def sphere(r, at=(0, 0, 0), segments=48):
    """球：半径 r，球心在 at"""
    bpy.ops.mesh.primitive_uv_sphere_add(radius=r, segments=segments, ring_count=max(8, segments // 2), location=at)
    return bpy.context.object

def _bool(target, tools, op):
    for t in tools:
        m = target.modifiers.new("k_" + op.lower(), "BOOLEAN")
        m.operation = op; m.object = t; m.solver = "EXACT"
        _activate(target)
        bpy.ops.object.modifier_apply(modifier=m.name)
        bpy.data.objects.remove(t, do_unlink=True)
    return target

def cut(target, *tools):
    """从 target 上挖掉 tools（挖完 tools 删掉）"""
    return _bool(target, tools, "DIFFERENCE")

def union(target, *others):
    """把 others 合进 target，成一个实体（合完 others 删掉）"""
    return _bool(target, others, "UNION")

def intersect(target, other):
    """只留两者重叠的部分"""
    return _bool(target, [other], "INTERSECT")

def move(o, x=0, y=0, z=0):
    o.location = (o.location.x + x, o.location.y + y, o.location.z + z); return o

def rotate(o, x=0, y=0, z=0):
    """绕物体自己的原点转（角度，度）"""
    o.rotation_euler.rotate(mathutils.Euler((math.radians(x), math.radians(y), math.radians(z))))
    _apply(o, rotation=True, scale=False); return o

def round_edges(o, r, segments=3, angle=30):
    """倒圆角：夹角大于 angle 度的棱边倒半径约 r 的圆角（r 要小于最薄处的一半）"""
    m = o.modifiers.new("k_bevel", "BEVEL")
    m.width = r; m.segments = segments; m.limit_method = "ANGLE"; m.angle_limit = math.radians(angle)
    _activate(o); bpy.ops.object.modifier_apply(modifier=m.name); return o

_CJK_FONTS = [r"C:\Windows\Fonts\simhei.ttf", r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\simsun.ttc",
              "/System/Library/Fonts/PingFang.ttc", "/System/Library/Fonts/STHeiti Medium.ttc",
              "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc"]

def text3d(s, size=10, depth=2, at=(0, 0, 0), font=None, align="CENTER"):
    """立体字：平躺在 XY 面上，字高约 size、厚 depth，底面中心在 at。有中文时自动找系统里的中文字体（也可以 font= 给字体文件路径）"""
    bpy.ops.object.text_add(location=(0, 0, 0))
    o = bpy.context.object
    o.data.body = s; o.data.size = size; o.data.extrude = depth / 2
    o.data.align_x = align; o.data.align_y = "CENTER"
    path = font or (next((f for f in _CJK_FONTS if os.path.exists(f)), None) if any(ord(c) > 127 for c in s) else None)
    if path:
        o.data.font = bpy.data.fonts.load(path)
    elif any(ord(c) > 127 for c in s):
        print("WARN 没找到中文字体，中文会显示成方框；用 font= 指定一个字体文件")
    _activate(o)
    bpy.ops.object.convert(target="MESH")
    o = bpy.context.object
    _merge(o)
    o.location = (at[0], at[1], at[2] + depth / 2)
    return o

def drop(o):
    """把物体放到地面上（最低点 z=0）"""
    bpy.context.view_layer.update()
    z = min((o.matrix_world @ v.co).z for v in o.data.vertices)
    o.location.z -= z; return o
`;
