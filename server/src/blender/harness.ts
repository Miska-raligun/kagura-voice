// 在 Blender 里跑的那段 Python（`blender -b --factory-startup --python <这段> -- <参数.json>`）：
// 空场景（单位毫米，1 个单位 = 1 mm）→ 跑她写的建模代码（或导入一个 STL / OBJ）→ 把所有可见网格（修改器生效后）合起来检查
// （尺寸、体积、三角面数、非流形边 / 破洞、离不离地、放不放得进打印机）→ 导出 STL → 四个角度渲染一张拼图。结果写进 JSON。
// Blender 4.1 起 STL 导出换成了 wm.stl_export，4.0 及以前是 export_mesh.stl（插件），两个都认。渲染用 Workbench（不吃显卡，没显卡时 Mesa 软渲染也行），
// 失败再退 Cycles CPU（关降噪，有的发行版没编进降噪库）。
export const HARNESS = String.raw`
import bpy, bmesh, json, sys, math, traceback, mathutils, os
args = json.load(open(sys.argv[sys.argv.index("--") + 1], encoding="utf-8"))
res = {"ok": False, "version": bpy.app.version_string}

def save():
    with open(args["result"], "w", encoding="utf-8") as f:
        json.dump(res, f, ensure_ascii=False)

def call_first(*tries):
    """bpy.ops 的 hasattr 总是真：挨个试，第一个跑通的算数（4.1 起 STL / OBJ 的导入导出换了新接口，老的是插件）"""
    errs = []
    for mod, fn in tries:
        try:
            if mod:
                import addon_utils
                addon_utils.enable(mod, default_set=True)
            fn(); return
        except Exception as e:
            errs.append(str(e).strip().split("\n")[-1][:160])
    raise RuntimeError("；".join(errs))

def mesh_objects(sc):
    return [o for o in sc.objects if o.type == "MESH" and not o.hide_render and not o.hide_get()]

try:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    us = sc.unit_settings
    us.system = "METRIC"; us.scale_length = 0.001; us.length_unit = "MILLIMETERS"
    if args["mode"] == "build":
        code = open(args["code_file"], encoding="utf-8").read()
        g = {"__name__": "__kagura__", "bpy": bpy, "bmesh": bmesh, "mathutils": mathutils, "math": math, "Vector": mathutils.Vector}
        # 预置的小函数（helpers.ts）：box / cylinder / cut / union / text3d …
        if args.get("helpers_file"):
            exec(compile(open(args["helpers_file"], encoding="utf-8").read(), "kagura_helpers.py", "exec"), g)
        try:
            exec(compile(code, "model.py", "exec"), g)
        except Exception:
            tb = traceback.format_exc(limit=8)
            i = tb.find('File "model.py"')
            res["error"] = "建模代码出错：\n" + (tb[i:] if i >= 0 else tb).strip()
            raise SystemExit
        # 她的代码可能把物体转成了别的类型（文字、曲线）：转成网格
        for o in list(sc.objects):
            if o.type in ("CURVE", "FONT", "SURFACE", "META") and not o.hide_render:
                bpy.context.view_layer.objects.active = o
                for x in sc.objects: x.select_set(x == o)
                try:
                    bpy.ops.object.convert(target="MESH")
                    # 文字 / 曲线转出来的网格正反面和侧壁是分开的点：合并重合的点，不然整圈都算破洞
                    me = bpy.context.object.data
                    bm0 = bmesh.new(); bm0.from_mesh(me)
                    bmesh.ops.remove_doubles(bm0, verts=bm0.verts, dist=0.0005)
                    bm0.to_mesh(me); bm0.free()
                except Exception: pass
    else:
        f = args["import_file"]; ext = os.path.splitext(f)[1].lower()
        if ext == ".stl":
            call_first(("", lambda: bpy.ops.wm.stl_import(filepath=f)), ("io_mesh_stl", lambda: bpy.ops.import_mesh.stl(filepath=f)))
        elif ext == ".obj":
            call_first(("", lambda: bpy.ops.wm.obj_import(filepath=f)), ("io_scene_obj", lambda: bpy.ops.import_scene.obj(filepath=f)))
        else:
            res["error"] = "只能看 .stl 和 .obj"; raise SystemExit

    objs = mesh_objects(sc)
    if not objs:
        res["error"] = "场景里没有网格物体（建模代码没建出东西，或者建出来的都被隐藏了）"; raise SystemExit
    dg = bpy.context.evaluated_depsgraph_get()
    bm = bmesh.new()
    for o in objs:
        eo = o.evaluated_get(dg)
        me = eo.to_mesh()
        me.transform(o.matrix_world)
        bm.from_mesh(me)
        eo.to_mesh_clear()
    if not bm.verts:
        res["error"] = "网格是空的"; raise SystemExit
    xs = [v.co.x for v in bm.verts]; ys = [v.co.y for v in bm.verts]; zs = [v.co.z for v in bm.verts]
    lo = [min(xs), min(ys), min(zs)]; hi = [max(xs), max(ys), max(zs)]
    dims = [hi[i] - lo[i] for i in range(3)]
    bed = args["bed"]
    res.update({
        "objects": len(objs), "verts": len(bm.verts),
        "tris": sum(len(f.verts) - 2 for f in bm.faces),
        "dims": [round(d, 2) for d in dims], "min": [round(v, 2) for v in lo], "max": [round(v, 2) for v in hi],
        "volume_mm3": round(abs(bm.calc_volume(signed=True)), 1),
        "non_manifold": sum(1 for e in bm.edges if not e.is_manifold),
        "boundary": sum(1 for e in bm.edges if e.is_boundary),
        "loose_verts": sum(1 for v in bm.verts if not v.link_edges),
        "fits": all(dims[i] <= bed[i] + 1e-6 for i in range(3)),
    })
    bm.free()

    # 导出 STL（所有可见网格合成一个文件，修改器生效，1 单位 = 1 mm）
    if args.get("out_stl"):
        for o in sc.objects: o.select_set(o in objs)
        bpy.context.view_layer.objects.active = objs[0]
        call_first(
            ("", lambda: bpy.ops.wm.stl_export(filepath=args["out_stl"], export_selected_objects=True, apply_modifiers=True, global_scale=1.0, ascii_format=False)),
            ("io_mesh_stl", lambda: bpy.ops.export_mesh.stl(filepath=args["out_stl"], use_selection=True, use_mesh_modifiers=True, global_scale=1.0, ascii=False)))
        res["stl"] = args["out_stl"]

    # 渲染：正交相机分别从斜上方、正面、右侧、正上方看，拼成 2×2 一张
    if args.get("out_png"):
        W, H = args.get("size", [400, 300])
        center = mathutils.Vector([(lo[i] + hi[i]) / 2 for i in range(3)])
        span = max(max(dims), 1.0)
        cam = bpy.data.objects.new("kcam", bpy.data.cameras.new("kcam"))
        sc.collection.objects.link(cam)
        cam.data.type = "ORTHO"; cam.data.clip_start = 0.1; cam.data.clip_end = span * 20
        sc.camera = cam
        r = sc.render
        r.resolution_x = W; r.resolution_y = H; r.resolution_percentage = 100
        r.image_settings.file_format = "PNG"; r.image_settings.color_mode = "RGB"; r.image_settings.compression = 90
        r.film_transparent = False
        def use_workbench():
            r.engine = "BLENDER_WORKBENCH"
            sh = sc.display.shading
            sh.light = "STUDIO"; sh.color_type = "SINGLE"; sh.single_color = (0.85, 0.55, 0.25)
            sh.show_cavity = True; sh.show_object_outline = True; sh.background_type = "VIEWPORT"
            # 阴影 + 凹槽 / 棱线描边：正上方看盒子时也看得出内腔和边沿
            sh.show_shadows = True; sh.shadow_intensity = 0.35
            try:
                sh.cavity_type = "BOTH"; sh.cavity_ridge_factor = 1.5; sh.cavity_valley_factor = 1.5
                sh.curvature_ridge_factor = 1.5; sh.curvature_valley_factor = 1.5
            except Exception: pass
            sc.display.light_direction = (0.45, -0.35, 0.82)
            # 浅灰背景（用世界颜色：存成 RGB 时视口背景会变黑）
            w = bpy.data.worlds.new("kworld"); w.color = (0.92, 0.92, 0.94); sc.world = w
            sh.background_type = "WORLD"
        def use_cycles():
            r.engine = "CYCLES"; sc.cycles.device = "CPU"; sc.cycles.samples = 16
            try: sc.cycles.use_denoising = False
            except Exception: pass
            if not any(o.type == "LIGHT" for o in sc.objects):
                sun = bpy.data.objects.new("ksun", bpy.data.lights.new("ksun", "SUN")); sun.data.energy = 4
                sun.rotation_euler = (0.8, 0.2, 0.6); sc.collection.objects.link(sun)
        # 第四张从背面斜上方看（正上方俯视看不出凹凸）
        views = [("iso", (1, -1, 0.8)), ("front", (0, -1, 0)), ("right", (1, 0, 0)), ("back", (-1, 1, 0.9))]
        tiles = []
        engines = [use_workbench, use_cycles]
        for name, d in views:
            d = mathutils.Vector(d).normalized()
            cam.location = center + d * span * 3
            cam.rotation_euler = (-d).to_track_quat("-Z", "Y").to_euler()
            cam.data.ortho_scale = span * (1.6 if name in ("iso", "back") else 1.35)
            path = args["out_png"] + "." + name + ".png"
            r.filepath = path
            done = False
            while engines and not done:
                try:
                    engines[0](); bpy.ops.render.render(write_still=True); done = os.path.exists(path)
                except Exception as e:
                    res.setdefault("render_errors", []).append(str(e)[:200])
                if not done: engines.pop(0)
            if done: tiles.append(path)
        # 拼成 2×2 一张（像素从下往上存，所以下面一行先放）。不用 numpy：有的发行版的 Blender 没带
        if len(tiles) == 4:
            try:
                ims = [bpy.data.images.load(t) for t in tiles]
                w, h = ims[0].size[0], ims[0].size[1]
                px = []
                for im in ims:
                    a = [0.0] * (w * h * 4); im.pixels.foreach_get(a); px.append(a)
                rows = []
                for pair in ((px[2], px[3]), (px[0], px[1])):          # 下：右侧、背面斜上方；上：前面斜上方、正面
                    for y in range(h):
                        rows.append(pair[0][y * w * 4:(y + 1) * w * 4]); rows.append(pair[1][y * w * 4:(y + 1) * w * 4])
                flat = [v for r_ in rows for v in r_]
                out = bpy.data.images.new("kgrid", w * 2, h * 2, alpha=True)
                out.pixels.foreach_set(flat)
                out.save_render(args["out_png"], scene=sc)        # 按场景的输出设置存（RGB、压缩 90），图小一半多
                for t in tiles: os.remove(t)
                res["png"] = args["out_png"]
            except Exception as e:
                res.setdefault("render_errors", []).append("拼图失败：" + str(e)[:200]); res["pngs"] = tiles
        elif tiles:
            res["pngs"] = tiles
    res["ok"] = True
except SystemExit:
    pass
except Exception:
    res["error"] = traceback.format_exc(limit=5)
finally:
    save()
`;
