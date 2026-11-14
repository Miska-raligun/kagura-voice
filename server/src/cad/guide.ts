// cad_guide 的内容。打印规矩 / 配合尺寸 / 自查 / 好看这几节和 Blender 那个共用（blender/guide.ts 的 sharedSection），这里只写 build123d 自己的。
// 示例代码在 test/cad.test.ts 里用真的 build123d 逐个建一遍（封闭、放得下），改了要重跑、看一眼渲染图。
import { sharedSection } from "../blender/guide.ts";
export const EXAMPLES: Record<string, [string, string]> = {
  "带盖收纳盒": ["盒身 + 套在外面的盖子，并排放一起打；竖棱圆角、底边防象脚斜角。", `# 带盖收纳盒：盒身 + 盖子并排放（各自开口 / 顶面朝下），盖子套在盒口外面
L, W, H = 80, 50, 35      # 盒身外形
wall = 2.0                # 壁厚
r = 4                     # 竖棱圆角
gap = 0.25                # 盖子和盒身单边间隙（能拿下来的配合）
lip_h = 6                 # 盖子裙边高度

body = Box(L, W, H, align=(Align.CENTER, Align.CENTER, Align.MIN))
body = fillet(body.edges().filter_by(Axis.Z), radius=r)
body = chamfer(body.edges().group_by(Axis.Z)[0], 0.5)          # 贴板的底边倒 0.5 斜角（防象脚）
cavity = Pos(0, 0, wall) * Box(L - 2 * wall, W - 2 * wall, H, align=(Align.CENTER, Align.CENTER, Align.MIN))
cavity = fillet(cavity.edges().filter_by(Axis.Z), radius=r - wall)
body = body - cavity

# 盖子：顶板 + 一圈裙边，裙边内侧比盒身外形大 gap
lid_L, lid_W = L + 2 * (gap + wall), W + 2 * (gap + wall)
lid = Box(lid_L, lid_W, wall + lip_h, align=(Align.CENTER, Align.CENTER, Align.MIN))
lid = fillet(lid.edges().filter_by(Axis.Z), radius=r + gap + wall)
inner = Pos(0, 0, wall) * Box(L + 2 * gap, W + 2 * gap, lip_h + 1, align=(Align.CENTER, Align.CENTER, Align.MIN))
inner = fillet(inner.edges().filter_by(Axis.Z), radius=r + gap)
lid = Pos(0, W / 2 + lid_W / 2 + 10, 0) * (lid - inner)        # 并排放，隔 10 mm

result = body + lid`],
  "L形支架": ["两块板 + 中间一道三角筋，每块板两个 M4 过孔（4.5）避开筋。草图挤出、选边倒圆角、批量挖孔的写法。", `# L 形支架：两块板 + 中间一道三角筋，每块板两个 M4 过孔（4.5），孔避开筋
t = 4          # 板厚
w = 30         # 宽（y 方向）
a, b = 50, 40  # 底板长（x）、立板高（z）
hole = 4.5     # M4 过孔直径
rib = 4        # 筋厚
hy = 9         # 孔离中线的距离（筋在中线上，孔放两边）

base = Box(a, w, t, align=(Align.MIN, Align.CENTER, Align.MIN))
wall = Box(t, w, b, align=(Align.MIN, Align.CENTER, Align.MIN))
# 三角筋：在 XZ 面里画三角形，向两侧各挤出 rib/2
with BuildSketch(Plane.XZ) as sk:
    Polygon((t - 0.2, t - 0.2), (t + 25, t - 0.2), (t - 0.2, t + 25), align=None)
ribs = extrude(sk.sketch, amount=rib / 2, both=True)
part = base + wall + ribs
part = fillet(part.edges().filter_by(Axis.Y).group_by(Axis.X)[0].group_by(Axis.Z)[-1], radius=2)  # 立板顶外棱
# 底板两个竖孔，立板两个横孔（Cylinder 居中、高 3 倍板厚：上下都伸出去，挖得干净）
part = part - [Pos(a - 12, y, 0) * Cylinder(hole / 2, t * 3) for y in (-hy, hy)]
part = part - [Pos(0, y, b - 12) * Rot(0, 90, 0) * Cylinder(hole / 2, t * 3) for y in (-hy, hy)]
result = part`],
  "铭牌": ["圆角板 + 凸起的字（中英文混排用 CJK_FONT）。", `# 铭牌：圆角板 + 凸起的字（中文用 CJK_FONT，系统里找到的中文字体）
L, W, t = 90, 30, 3
text_h = 1.0                      # 字凸起高度
plate = Box(L, W, t, align=(Align.CENTER, Align.CENTER, Align.MIN))
plate = fillet(plate.edges().filter_by(Axis.Z), radius=5)
plate = chamfer(plate.edges().group_by(Axis.Z)[-1], 0.6)          # 顶边小斜角
with BuildSketch(Plane.XY.offset(t - 0.2)) as sk:                  # 字插进板里 0.2，合得上
    Text("KAGURA 神乐", font_size=12, font_path=CJK_FONT)
result = plate + extrude(sk.sketch, amount=text_h + 0.2)`],
};

const SECTIONS: Record<string, [string, () => string]> = {
  basics: ["约定和流程", () => `## 约定
- 单位毫米，z 轴朝上，模型的底面放在 z=0（打印时贴着板的那面）。
- 代码开头已经有 from build123d import *、import math；中文字体文件的路径在 CJK_FONT（没找到是 None）。
- **最后一定写 result = 零件**（Part / Solid / Compound 都行；用 BuildPart 写 result = p.part；几个分开打的零件 result = a + b 或 [a, b]）。
- 每次调用都是新的 Python：每次给完整代码。上一版存在 <模型目录>/<name>/<name>.py，要改就 read_file 拿回来改了再整段交。
- 同时导出 STL（给切片）和 STEP（精确实体，主人想在别的 CAD 里接着改就给它）。
- 代码开头把所有尺寸写成变量，每个后面注释一句为什么是这个数（「内腔比电池大 0.3，好放进去」）；位置都用变量算，改一个数整个模型跟着变。

## 开工前问清楚（不清楚就问主人，问一两句就好）
- 是什么、干什么用：放东西 / 固定东西 / 装饰 / 要受力吗。
- 必须对上的尺寸：要装进去的东西多大、要套在什么上面、螺丝孔距。**以主人量的为准**，别凭印象写现成零件的尺寸；拿不准的让主人用尺子量一下。
- 怎么固定：螺丝（多大）、卡扣、双面胶、磁铁、直接放着。
- 要不要好看：圆润还是硬朗、哪一面朝外给人看。
- 主人说的方位（「左边」「上面」）先翻译成坐标轴（-x / +z）再动手，必要时复述一句确认。

## 分三步做，每步都看图
1. 大形：只做外形和主要尺寸 → cad_build → 看图对比例和大小 → 给主人看一眼方向对不对。
2. 功能：孔、槽、卡扣、螺丝柱、加强筋 → 再建、再看。
3. 收尾：倒圆角 / 倒角、字 → 按 topic=review 的清单自查 → 把预览图 send_file 给主人，附一张参数表（关键尺寸、壁厚、间隙），问要不要调。
- 一次只改一处，改完就建一次看图；别一口气重写整个模型。
- 主人点头了再 printer_slice → printer_print。`],
  api: ["常用写法", () => `## 建体（**默认都是以中心为原点的**）
- Box(长x, 宽y, 高z)、Cylinder(半径, 高)、Cone(底半径, 顶半径, 高)、Sphere(半径)、Torus(大半径, 小半径)
- 让底面落在 z=0：加 align=(Align.CENTER, Align.CENTER, Align.MIN)；角落在原点：align=(Align.MIN, Align.MIN, Align.MIN)
- Cylinder 填的是**半径**；孔的尺寸表是直径，记得 / 2

## 定位和布尔（代数写法，推荐）
- Pos(x, y, z) * 物体 平移；Rot(x, y, z) * 物体 转（度，绕原点）；Pos(...) * Rot(...) * 物体 = 先转再移
- a + b 合并、a - b 挖掉、a & b 只留重叠；挖一堆：a - [孔1, 孔2, …]
- 阵列：holes = [Pos(x, y, 0) * Cylinder(1.7, 20) for x in (-20, 20) for y in (-10, 10)]
- 镜像：mirror(零件, about=Plane.YZ)（左右对称的建一半再 + 镜像）；切开：split(零件, bisect_by=Plane.XY)（留 z>0 的一半）

## 选边 / 选面（倒角、开口都靠它）
- 零件.edges().filter_by(Axis.Z)：所有竖直的棱（盒子四个竖角）
- 零件.edges().group_by(Axis.Z)[0] / [-1]：最低一层 / 最高一层的边（底边、顶边）
- 零件.faces().sort_by(Axis.Z)[-1]：最高的面（顶面）；.filter_by(GeomType.CIRCLE) 只要圆边
- fillet(边, radius=r) 圆角、chamfer(边, length) 斜角——都返回新零件：body = fillet(body.edges()…, 2)
- 半径要小于相邻最窄面的一半，不然报错。**先倒角再挖要精确配合的孔**，或者倒角时只选外面那几条边

## 空心和壳
- 盒子：body - Pos(0, 0, 壁厚) * Box(内长, 内宽, 高, align=…)（最直观，内腔还能单独倒圆角）
- 或者抽壳：offset(body, amount=-壁厚, openings=body.faces().sort_by(Axis.Z)[-1])（顶面开口，壁厚均匀）

## 草图 → 挤出 / 旋转（复杂轮廓）
\`\`\`python
with BuildSketch(Plane.XY) as sk:          # 在哪个面上画：Plane.XY / XZ / YZ，Plane.XY.offset(5) 抬高 5
    Rectangle(40, 20)
    Circle(5, mode=Mode.SUBTRACT)          # 挖掉
    with Locations((10, 0)): RegularPolygon(3, 6)   # 六边形（外接圆半径）
part = extrude(sk.sketch, amount=5)       # both=True 两边各挤
\`\`\`
- 其它形状：Polygon((x,y), …)、SlotOverall(总长, 宽)（腰形孔）、Ellipse、RectangleRounded(长, 宽, 圆角)、Trapezoid
- 绕 z 轴转出来（杯子、旋钮）：在 Plane.XZ 上画截面（x = 半径方向），revolve(sk.sketch, axis=Axis.Z)
- 六角螺母槽：RegularPolygon(对边宽 / √3, 6) 的对边宽正好是那个数

## 孔（BuildPart 写法里有现成的）
\`\`\`python
with BuildPart() as p:
    Box(60, 40, 5, align=(Align.CENTER, Align.CENTER, Align.MIN))
    with Locations(p.faces().sort_by(Axis.Z)[-1]):      # 在顶面上往下打
        with GridLocations(40, 20, 2, 2):                # 2×2 个，间距 40 / 20
            CounterBoreHole(radius=1.7, counter_bore_radius=3.25, counter_bore_depth=3.5)   # M3 沉孔
    with PolarLocations(10, 6): Hole(1)                  # 一圈 6 个
result = p.part
\`\`\`
- Hole(半径) 打穿；CounterSinkHole(半径, 锥口半径) 沉头；代数写法就用 - Cylinder

## 字
- Text("文字", font_size=字号, font_path=CJK_FONT) 是平面草图，要 extrude 成体；字号 10 的大写字母实际高约 7.3 mm
- 凸字：在顶面高度往下 0.2 开始挤（插进去一点才合得上）；刻字：用 - 挖掉，深 ≥ 0.6
- 竖面上的字：在 Plane.XZ（朝 -y 的正面）上画，或者建好再 Rot(90, 0, 0)

## 查尺寸
- 零件.bounding_box().size、零件.volume；print 出来的东西会附在结果里，算位置时可以 print 核对`],
  printing: sharedSection("printing"),
  fits: sharedSection("fits"),
  review: sharedSection("review"),
  look: sharedSection("look"),
  examples: ["示例代码", () => `## 示例（都用真的 build123d 跑过，照着改尺寸就行）\n` + Object.entries(EXAMPLES).map(([n, [d, c]]) => `### ${n}\n${d}\n\`\`\`python\n${c}\n\`\`\``).join("\n\n")],
  problems: ["出问题怎么办", () => `## 检查结果里的问题
- 「放不进打印机」：缩小，或者拆成几块（一次建几块并排放，result = a + b）。
- 「最低点不在 z=0」：建体时用 align=(…, …, Align.MIN)，或者最后 result = Pos(0, 0, -零件.bounding_box().min.Z) * 零件。
- 「N 个分开的实体」但本该是一体：相加的两块只是挨着、没重叠——让它插进去 0.2 再加。
- 「最薄只有 x mm」：加厚到 1.2 mm 以上。
- 挖了孔但图上看不到：工具没和主体重叠（位置算错了）——print(零件.bounding_box()) 核对。
## 代码出错
- fillet / chamfer 报错（StdFail_NotDone 之类）：半径太大，或者选到了不该选的边（比如已经倒过的）。调小半径，或者先倒角、后挖孔 / 加别的东西。
- 选边选错了：先 print(len(零件.edges().filter_by(Axis.Z))) 看选到几条。
- 布尔之后 is_valid = False：两个物体有刚好重合的面——让挖的工具多伸出来 0.5~1 mm。
- NameError：build123d 的名字都是大写开头（Box、Cylinder、Pos、Align）；函数是小写（fillet、extrude、mirror）。
- 中文字是空的或报找不到字体：CJK_FONT 是 None，用 font_path=r"C:\\\\Windows\\\\Fonts\\\\simhei.ttf" 指定一个。
- 跑太久超时：别对上百个小物体逐个相减，先把它们 + 成一个再一次减掉；字少一点。
## 改了好几次还不对
- 退回上一版能用的代码，一次只改一处。
- 三五次还不行就停下来，告诉主人哪里卡住了、可能的原因，问要不要换个做法。`],
};
export const GUIDE_TOPICS = Object.keys(SECTIONS);

export function guide(topic = ""): string {
  const t = topic.trim().toLowerCase();
  if (t === "all") return GUIDE_TOPICS.map((k) => SECTIONS[k][1]()).join("\n\n");
  if (SECTIONS[t]) return SECTIONS[t][1]();
  return `${SECTIONS.basics[1]()}\n\n${SECTIONS.api[1]()}\n\n## 还有这些（cad_guide topic=…，用到就读）\n${GUIDE_TOPICS.filter((k) => k !== "basics" && k !== "api").map((k) => `- ${k}：${SECTIONS[k][0]}`).join("\n")}`;
}
