// 在 Python 里跑的那段（`python harness.py <参数.json>`）：`from build123d import *` → 跑她写的建模代码 → 取 result（没写就取最后一个实体变量）
// → 检查（有效性、实体个数、体积、包围盒）→ 导出 STL + STEP。网格检查（破洞边）和预览图在 Node 那边按 STL 做（raster.ts），不依赖别的库。
// 她代码里 print 的东西收进 res.output（别混进我们的结果）。
export const HARNESS = String.raw`
import json, sys, io, os, traceback, contextlib
args = json.load(open(sys.argv[1], encoding="utf-8"))
res = {"ok": False}

def save():
    with open(args["result"], "w", encoding="utf-8") as f:
        json.dump(res, f, ensure_ascii=False)

def _cjk_fonts():
    """系统里能用的中日文字体（先中文、后日文；「楽」这类日文写法的字中文字体里可能没有）"""
    win = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts")
    local = os.path.join(os.environ.get("LOCALAPPDATA", ""), "Microsoft", "Windows", "Fonts")   # 只给当前用户装的字体在这
    names = ["msyh.ttc", "msyhbd.ttc", "simhei.ttf", "Deng.ttf", "simsun.ttc", "YuGothM.ttc", "YuGothR.ttc", "meiryo.ttc", "msgothic.ttc"]
    c = [os.path.join(d, n) for d in (win, local) for n in names] + [
        "/System/Library/Fonts/PingFang.ttc", "/System/Library/Fonts/STHeiti Medium.ttc", "/System/Library/Fonts/Hiragino Sans GB.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc", "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc"]
    return [f for f in c if os.path.exists(f)]

buf = io.StringIO()
try:
    try:
        import build123d as b3d
        from importlib.metadata import version as _ver
        res["version"] = _ver("build123d")
    except Exception as e:
        res["error"] = "NO_BUILD123D " + str(e)[:300]; raise SystemExit
    Shape = b3d.topology.Shape
    g = {"__name__": "__kagura__"}
    exec("from build123d import *", g)
    import math
    g["math"] = math
    # 中文字体：Text("神乐", 8, font_path=CJK_FONT)；CJK_FONTS 是找到的全部（缺字时换一个）
    fonts = _cjk_fonts()
    g["CJK_FONTS"] = fonts; g["CJK_FONT"] = fonts[0] if fonts else None
    res["fonts"] = fonts
    code = open(args["code_file"], encoding="utf-8").read()
    before = set(g)
    try:
        with contextlib.redirect_stdout(buf):
            exec(compile(code, "model.py", "exec"), g)
    except Exception:
        tb = traceback.format_exc(limit=8)
        i = tb.find('File "model.py"')
        res["error"] = "建模代码出错：\n" + (tb[i:] if i >= 0 else tb).strip()
        raise SystemExit

    def as_shape(v):
        if isinstance(v, b3d.BuildPart): return v.part
        if isinstance(v, (b3d.BuildSketch, b3d.BuildLine)): return None
        if isinstance(v, (list, tuple)) and v and all(isinstance(x, Shape) for x in v): return b3d.Compound(list(v))
        if isinstance(v, Shape): return v
        return None

    picked = None
    if "result" in g:
        shape = as_shape(g["result"]); picked = "result"
        if shape is None:
            res["error"] = "result 不是实体（是 %s）：要赋成 Part / Solid / Compound，或者 BuildPart 本身" % type(g["result"]).__name__; raise SystemExit
    else:
        shape = None
        for k in reversed([k for k in g if k not in before and not k.startswith("_")]):
            s = as_shape(g[k])
            if s is not None and s.volume > 1e-6:
                shape, picked = s, k; break
        if shape is None:
            res["error"] = "没找到建好的实体：最后写一句 result = 你的零件（BuildPart 写 result = p.part）"; raise SystemExit
    res["picked"] = picked
    solids = shape.solids()
    if not solids:
        res["error"] = "result 里没有实体（只有面或线：草图要 extrude / revolve 成体）"; raise SystemExit
    bb = shape.bounding_box()
    lo = [bb.min.X, bb.min.Y, bb.min.Z]; hi = [bb.max.X, bb.max.Y, bb.max.Z]
    dims = [hi[i] - lo[i] for i in range(3)]
    bed = args["bed"]
    res.update({
        "objects": len(solids), "valid": bool(shape.is_valid),
        "dims": [round(d, 2) for d in dims], "min": [round(v, 2) for v in lo], "max": [round(v, 2) for v in hi],
        "volume_mm3": round(abs(shape.volume), 1),
        "fits": all(dims[i] <= bed[i] + 1e-6 for i in range(3)),
    })
    tol = float(args.get("tolerance") or 0.01)
    if not b3d.export_stl(shape, args["out_stl"], tolerance=tol, angular_tolerance=0.1):
        res["error"] = "导出 STL 失败"; raise SystemExit
    res["stl"] = args["out_stl"]
    if args.get("out_step"):
        try:
            b3d.export_step(shape, args["out_step"]); res["step"] = args["out_step"]
        except Exception as e:
            res["step_error"] = str(e)[:200]
    res["ok"] = True
except SystemExit:
    pass
except Exception:
    res["error"] = traceback.format_exc(limit=5)
finally:
    out = buf.getvalue()
    if out.strip(): res["output"] = out[-2000:]
    save()
`;
