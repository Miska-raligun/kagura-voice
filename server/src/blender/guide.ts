// model_guide 的内容：用 Blender 建 3D 打印模型的指导。分节给，她用到哪节读哪节（不常驻，不占每轮的额度）。
// 示例代码（EXAMPLES）在 test/blender.test.ts 里用真的 Blender 逐个跑过：要封闭、放得下、尺寸对。改了示例要重跑。
import { HELPERS } from "./helpers.ts";

/** 示例：名字 → [说明, 代码] */
export const EXAMPLES: Record<string, [string, string]> = {
  "带盖收纳盒": ["60×40×30 的盒子（壁厚 2、底厚 2），盖子带一圈 0.2 mm 间隙的内唇，盖子放在旁边一起打（内唇朝上）", `L, W, H, t, gap = 60, 40, 30, 2, 0.2
body = box(L, W, H)
cut(body, box(L - 2*t, W - 2*t, H, at=(0, 0, t)))          # 挖空，底留 t 厚
round_edges(body, 0.8)

# 盖子：平板 + 一圈插进盒口的内唇（比盒子内腔每边小 gap）
lx = L + 10                                                  # 放在盒子旁边
lid = box(L, W, t, at=(lx, 0, 0))
lip = box(L - 2*t - 2*gap, W - 2*t - 2*gap, 4, at=(lx, 0, t - 0.01))
cut(lip, box(L - 4*t - 2*gap, W - 4*t - 2*gap, 5, at=(lx, 0, t - 0.5)))
union(lid, lip)`],
  "带螺丝孔的L形支架": ["40 宽的 L 形角码，底板两个 M4 沉头孔，内角加了加强筋", `base = box(40, 24, 4)                                        # 底板
wall = box(40, 4, 30, at=(0, 10, 0))                         # 立板（贴着底板后边）
union(base, wall)
for x in (-14, 14):                                          # 加强筋：以内角（y=8, z=4）为中心转 45° 的方块，截出内角那一块三角形
    rib = box(3, 16, 16, at=(x, 8, 4 - 8))                    # 中心正好在内角
    rotate(rib, x=45)
    intersect(rib, box(3, 12.5, 12.5, at=(x, 8.5 - 6.25, 3.5)))  # 截取范围往立板、底板里多伸 0.5，合并时才吃得进去
    union(base, rib)
for x in (-7, 7):                                            # M4 过孔 4.4 + 沉头（锥形，开口朝上）
    cut(base, cylinder(2.2, 10, at=(x, -4, -1)))
    cut(base, cone(2.2, 4.6, 2.5, at=(x, -4, 4 - 2.4)))`],
  "铭牌（凸字和刻字）": ["80×25×3 的铭牌：上面凸起 1.2 mm 的名字，下面刻 0.6 mm 深的小字", `plate = box(80, 25, 3)
round_edges(plate, 1)
name = text3d("KAGURA", size=11, depth=1.2, at=(0, 3, 3 - 0.01))   # 凸字：底面略微插进板里，合并才不会有缝
union(plate, name)
cut(plate, text3d("No.1", size=5, depth=1, at=(0, -8, 3 - 0.6)))    # 刻字：从顶面往下 0.6`],
};

const SECTIONS: Record<string, [string, () => string]> = {
  basics: ["基本约定和流程", () => `## 基本约定
- 单位毫米（1 = 1 mm），z 轴朝上，模型的底面放在 z=0（打印时贴着板的那面）。
- 每次调用都从空场景开始：每次给完整代码。上一版代码存在 <模型目录>/<name>/<name>.py，要改就 read_file 拿回来改了再整段交。
- 场景里所有可见的网格会合成一个 STL；临时用的工具物体用 cut / union 用掉就自动删了；自己用 bpy 建的辅助物体不想要就删掉或 hide_render = True。
- 优先用下面的小函数（model_guide topic=helpers），它们处理好了缩放、选中、布尔算法；需要别的再用 bpy / bmesh。

## 流程
1. 先把尺寸想清楚：主人给的尺寸、要装的东西多大、要配合的地方留多少间隙（topic=fits）。拿不准就先问主人。
2. 写代码 → model_build → 看检查结果和预览图：尺寸对不对、有没有破洞、形状是不是想要的。
3. 有问题就改代码再建；对了把预览图用 send_file 发给主人看，主人点头再 printer_slice → printer_print。
4. 第一次做某类东西可以先看 topic=examples 里的例子照着改。`],
  helpers: ["预置的小函数", () => `## 预置的小函数（已经导入，直接调；at 是底面中心，sphere 的 at 是球心）
- box(sx, sy, sz, at=(0,0,0)) 长方体
- cylinder(r, h, at=(0,0,0), segments=64) 圆柱（半径！不是直径）
- cone(r1, r2, h, at=(0,0,0), segments=64) 圆台 / 圆锥（r1 底、r2 顶，0 = 尖）
- sphere(r, at=(0,0,0), segments=48) 球
- text3d(s, size=10, depth=2, at=(0,0,0), font=None, align="CENTER") 立体字，平躺；有中文自动找系统中文字体
- cut(target, *tools) 挖掉；union(target, *others) 合并成一个实体；intersect(target, other) 只留重叠部分。都会删掉工具物体、返回 target
- move(o, x=0, y=0, z=0) 平移；rotate(o, x=0, y=0, z=0) 绕自己的原点转（度）；drop(o) 放到地面
- round_edges(o, r, segments=3, angle=30) 倒圆角（r 小于最薄处的一半，最后做）
- 也能直接用 bpy、bmesh、math、mathutils、Vector

## 用的时候注意
- 挖孔 / 挖槽的工具要比被挖的物体**多出来一点**（上下各多 0.5~1 mm），别让面刚好重合——重合的面布尔容易出破洞。
- 凸起的东西（字、筋）要**稍微插进**主体一点（0.01~0.5 mm）再 union，不然只是挨着，合不成一个。
- 倒圆角放在布尔都做完之后；圆角太大或者棱太多会很慢、甚至失败，失败就把 r 调小或者不倒。`],
  printing: ["3D 打印的规矩（0.4 喷嘴、PLA）", () => `## 能不能打出来
- 壁厚至少 1.2 mm（约 3 圈），受力的地方 2 mm 以上；底 / 顶至少 1 mm。
- 悬空：和竖直方向夹角不超过 45° 能直接打；水平悬空（桥）不超过 10 mm；再多就要支撑——尽量通过摆放和造型避免。
- 最小孔径约 2 mm；竖着的圆孔会打小 0.1~0.2 mm，要配合的孔加大一点（topic=fits）。
- 字：凸字字高 ≥ 5 mm、凸出 ≥ 0.6 mm；刻字字高 ≥ 6 mm、深 ≥ 0.6 mm；笔画太细的字体打不清。
- 尖的薄边打不好，加小圆角；**贴板的底边别倒大圆角**（圆角下面是悬空，1 mm 以内没关系），要倒大的就倒 45° 斜角。
- 放得下：P2S 打印范围 256 × 256 × 256 mm；太大就拆成几块，做定位销 / 榫接起来。

## 怎么摆
- 最大的平面朝下贴板；要受力的方向别和层线垂直（层与层之间最容易断）。
- 一个零件尽量不要支撑：悬空的地方改成 45° 斜坡、或者把零件转个方向。
- 多个零件可以并排放在一个场景里一起打，中间隔 5 mm 以上。`],
  fits: ["配合间隙和常用尺寸", () => `## 配合间隙（单边，PLA，P2S 这类机器）
- 能活动的（盖子、滑动、插拔）：0.2~0.3 mm
- 紧配（压进去不掉）：0.1 mm 左右；要很紧再小，但容易装不进
- 两个零件要能转动（轴和孔）：0.3~0.4 mm
## 常用孔
- 螺丝过孔：M2 2.4、M3 3.4、M4 4.4、M5 5.5（直径）
- 自攻螺丝底孔：M2 1.8、M3 2.6~2.8
- 沉头：锥形开口，直径约是螺丝的 2 倍，深约 0.6 倍
- 热熔螺母（M3）：孔径 4.0~4.2、深 5~6
- 圆形磁铁：直径 + 0.2~0.3，深 + 0.2
## 记住
- 半径和直径别搞混：cylinder 填的是半径。
- 尺寸要以主人量的为准；拿不准的配合可以先打一个小的测试件（比如只打带孔的那一小块）试试。`],
  examples: ["示例代码", () => `## 示例（都在真的 Blender 里跑过，照着改尺寸就行）\n` + Object.entries(EXAMPLES).map(([n, [d, c]]) => `### ${n}\n${d}\n\`\`\`python\n${c}\n\`\`\``).join("\n\n")],
  problems: ["出问题怎么办", () => `## 检查结果里的问题
- 「有 N 条破洞边」：多半是布尔时面刚好重合、或者用了单面的平面 / 没封口的形状。挖的工具多伸出来一点；用 box / cylinder 这类封闭的体，别用 plane。
- 「最低点不在 z=0」：drop(o)，或者把 at 的 z 设成 0。
- 「放不进打印机」：缩小，或者拆成几块分开建（可以一次建几块并排放）。
- 「最薄只有 x mm」：加厚到 1 mm 以上。
## 代码出错
- NameError / AttributeError：看报错那一行。bpy.ops 建出来的物体用 bpy.context.object 拿；4.x 的接口名和旧教程可能不一样。
- 跑太久超时：圆柱 / 球的 segments 降到 32~48；别对上千个面的物体反复布尔。
- 中文字成了方框：系统里没找到中文字体，用 font="C:\\\\Windows\\\\Fonts\\\\simhei.ttf" 这样指定一个。
## 预览图
- 左上：前面斜上方；右上：正面；左下：右侧；右下：背面斜上方。颜色深浅只是光照，不是材料。`],
};

export const GUIDE_TOPICS = Object.keys(SECTIONS);

export function guide(topic = ""): string {
  const t = topic.trim().toLowerCase();
  if (t === "all") return GUIDE_TOPICS.map((k) => SECTIONS[k][1]()).join("\n\n");
  if (SECTIONS[t]) return SECTIONS[t][1]();
  // 不填：基本约定 + 小函数 + 目录
  return `${SECTIONS.basics[1]()}\n\n${SECTIONS.helpers[1]()}\n\n## 还有这些（model_guide topic=…）\n${GUIDE_TOPICS.filter((k) => k !== "basics" && k !== "helpers").map((k) => `- ${k}：${SECTIONS[k][0]}`).join("\n")}`;
}

/** 测试用：小函数源码（检查示例里用到的都定义了） */
export const HELPER_NAMES = [...HELPERS.matchAll(/^def ([a-z]\w*)\(/gm)].map((m) => m[1]);
