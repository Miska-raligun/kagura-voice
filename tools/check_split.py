#!/usr/bin/env python3
"""设备端模块拆分的静态校验（无法真机测试时的安全网）。

检查四件事：
  1. 每个模块引用的名字都能解析（本模块定义 / 显式 import / 星号导入基线）
  2. import 图无环
  3. 没有模块用 `from cfg import <运行时可变量>`（会读到值拷贝，静默失效）
  4. 拆分后没有丢函数（对比单文件版本）
用法: python3 tools/check_split.py
"""
import ast, builtins, os, sys

SRC = "device/src"
LEGACY = "cores3_client.py"      # 单文件基线（若还在）
MUTABLE = {"SERVER_BASE", "SERVER_URL", "VISION_URL", "UPLOAD_URL",
           "MQTT_BROKER", "SILENCE_THRESHOLD", "WAKE_THRESHOLD"}
BUILTINS = set(dir(builtins)) | {"__name__", "__file__", "const"}

def binds_of(node, deep=True):
    """收集一个作用域里绑定的名字。"""
    out = set()
    for n in ast.walk(node) if deep else [node]:
        if isinstance(n, ast.Name) and isinstance(n.ctx, (ast.Store, ast.Del)):
            out.add(n.id)
        elif isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            out.add(n.name)
            if n is not node:
                continue
        elif isinstance(n, ast.arg):
            out.add(n.arg)
        elif isinstance(n, ast.ExceptHandler) and n.name:
            out.add(n.name)
        elif isinstance(n, (ast.Import, ast.ImportFrom)):
            for a in n.names:
                out.add((a.asname or a.name).split(".")[0])
        elif isinstance(n, (ast.Global, ast.Nonlocal)):
            out.update(n.names)
    return out

def loads_of(node):
    return {n.id for n in ast.walk(node)
            if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)}

def analyse(path):
    tree = ast.parse(open(path).read())
    mod_binds = set()
    for n in tree.body:
        mod_binds |= binds_of(n, deep=not isinstance(n, (ast.FunctionDef, ast.ClassDef)))
        if isinstance(n, (ast.FunctionDef, ast.ClassDef)):
            mod_binds.add(n.name)
    # 顶层 for/if/try 里的绑定也算模块级
    for n in ast.walk(tree):
        if isinstance(n, (ast.For, ast.If, ast.Try, ast.While)):
            for st in ast.walk(n):
                if isinstance(st, ast.Name) and isinstance(st.ctx, ast.Store):
                    mod_binds.add(st.id)
    undef = set()
    for fn in [n for n in ast.walk(tree)
               if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]:
        local = binds_of(fn)
        undef |= loads_of(fn) - local - mod_binds - BUILTINS
    top_loads = set()
    for n in tree.body:
        if not isinstance(n, (ast.FunctionDef, ast.ClassDef)):
            top_loads |= loads_of(n)
    undef |= top_loads - mod_binds - BUILTINS
    imports = {a.name.split(".")[0] for n in ast.walk(tree)
               if isinstance(n, ast.Import) for a in n.names}
    imports |= {n.module.split(".")[0] for n in ast.walk(tree)
                if isinstance(n, ast.ImportFrom) and n.module}
    fns = {n.name for n in tree.body if isinstance(n, ast.FunctionDef)}
    return tree, mod_binds, undef, imports, fns

# ── 基线：单文件版里"未定义"的名字 = 星号导入 + 内置提供的 ──
baseline = set()
legacy_fns = set()
if os.path.exists(LEGACY):
    _, _, baseline, _, legacy_fns = analyse(LEGACY)

mods = sorted(f[:-3] for f in os.listdir(SRC) if f.endswith(".py"))
fail = 0

print("=== 1. 名字解析 ===")
for m in mods:
    _, _, undef, _, _ = analyse(os.path.join(SRC, m + ".py"))
    bad = undef - baseline - set(mods)
    if bad:
        print("  ✗ %-12s 无法解析: %s" % (m, ", ".join(sorted(bad)))); fail += 1
    else:
        print("  ✓ %-12s" % m)

print("\n=== 2. import 图 ===")
graph = {}
for m in mods:
    _, _, _, imps, _ = analyse(os.path.join(SRC, m + ".py"))
    graph[m] = sorted(imps & set(mods))
    print("  %-12s -> %s" % (m, ", ".join(graph[m]) or "(无)"))

def find_cycle(g):
    WHITE, GREY, BLACK = 0, 1, 2
    color = {n: WHITE for n in g}
    stack = []
    def dfs(n):
        color[n] = GREY; stack.append(n)
        for nb in g.get(n, []):
            if color.get(nb) == GREY:
                return stack[stack.index(nb):] + [nb]
            if color.get(nb) == WHITE:
                r = dfs(nb)
                if r: return r
        color[n] = BLACK; stack.pop(); return None
    for n in g:
        if color[n] == WHITE:
            r = dfs(n)
            if r: return r
    return None

cyc = find_cycle(graph)
if cyc:
    print("  ✗ 存在循环 import: " + " -> ".join(cyc)); fail += 1
else:
    print("  ✓ 无环")

print("\n=== 3. 可变全局的导入方式 ===")
bad_from = []
for m in mods:
    tree = ast.parse(open(os.path.join(SRC, m + ".py")).read())
    for n in ast.walk(tree):
        if isinstance(n, ast.ImportFrom) and n.module == "cfg":
            for a in n.names:
                if a.name in MUTABLE:
                    bad_from.append((m, a.name))
if bad_from:
    for m, name in bad_from:
        print("  ✗ %s: `from cfg import %s` —— 必须改成 cfg.%s" % (m, name, name)); fail += 1
else:
    print("  ✓ 无模块用 from cfg import 拿可变量（%d 个受监控）" % len(MUTABLE))

print("\n=== 4. 跨模块属性引用 ===")
exported = {}
for m in mods:
    t = ast.parse(open(os.path.join(SRC, m + ".py")).read())
    names = set()
    for n in t.body:
        if isinstance(n, (ast.FunctionDef, ast.ClassDef)):
            names.add(n.name)
        elif isinstance(n, ast.Assign):
            names |= {x.id for x in n.targets if isinstance(x, ast.Name)}
        elif isinstance(n, (ast.Import, ast.ImportFrom)):
            names |= {(a.asname or a.name).split(".")[0] for a in n.names}
    for n in ast.walk(t):
        if isinstance(n, (ast.For, ast.If, ast.Try, ast.While)):
            for st in ast.walk(n):
                if isinstance(st, ast.Name) and isinstance(st.ctx, ast.Store):
                    names.add(st.id)
    exported[m] = names
dangling = 0
for m in mods:
    t = ast.parse(open(os.path.join(SRC, m + ".py")).read())
    # 函数内把模块名用作局部变量会遮蔽模块，单独标记
    for n in ast.walk(t):
        if (isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name)
                and n.value.id in exported and n.value.id != m):
            if n.attr not in exported[n.value.id]:
                print("  \u2717 %s:%d  %s.%s 不存在" % (m, n.lineno, n.value.id, n.attr))
                dangling += 1
if dangling:
    fail += 1
else:
    print("  \u2713 所有 mod.attr 引用都命中")

print("\n=== 5. 函数完整性（对比单文件基线）===")
if legacy_fns:
    new_fns = set()
    for m in mods:
        _, _, _, _, fns = analyse(os.path.join(SRC, m + ".py"))
        new_fns |= fns
    renamed = {"_update_chat_text": "update_chat_text", "_mic_on": "mic_on",
               "_mic_off": "mic_off", "_wdt_feed": "wdt_feed",
               "_volume_load": "volume_load", "_volume_adjust": "volume_adjust"}
    missing = {f for f in legacy_fns if f not in new_fns and renamed.get(f) not in new_fns}
    if missing:
        print("  ✗ 丢失: %s" % ", ".join(sorted(missing))); fail += 1
    else:
        print("  ✓ 基线 %d 个函数全部落位（含 %d 处重命名）" % (len(legacy_fns), len(renamed)))
else:
    print("  - 跳过（单文件基线已删除）")

print("\n" + ("❌ %d 项未通过" % fail if fail else "✅ 全部通过"))
sys.exit(1 if fail else 0)
