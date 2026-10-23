// trigram 至少 3 字，两字中文词搜不到。改为：CJK 逐字切开 + unicode61 + 短语查询。
import { DatabaseSync } from "node:sqlite";
const seg = (s: string) => s.replace(/([㐀-鿿豈-﫿])/g, " $1 ").replace(/\s+/g, " ").trim();
const db = new DatabaseSync(":memory:");
db.exec("CREATE VIRTUAL TABLE notes USING fts5(path UNINDEXED, body, raw UNINDEXED, tokenize='unicode61')");
const ins = db.prepare("INSERT INTO notes(path, body, raw) VALUES (?, ?, ?)");
for (const [p, t] of [["d1", "主人说下周三要去杭州出差，记得提醒带充电器"], ["d2", "主人喜欢喝无糖乌龙茶，不喜欢香菜"], ["d3", "今天聊了猫咪的名字，叫团子。iPhone 充电线坏了"]]) ins.run(p, seg(t), t);
const q = (s: string) => db.prepare("SELECT path, snippet(notes, 1, '[', ']', '…', 8) s FROM notes WHERE notes MATCH ? ORDER BY bm25(notes)").all('"' + seg(s).replace(/"/g, "") + '"') as any[];
const cases: [string, string[]][] = [["出差", ["d1"]], ["香菜", ["d2"]], ["团子", ["d3"]], ["充电", ["d1", "d3"]], ["iphone", ["d3"]], ["猫", ["d3"]], ["不存在", []]];
let ok = true;
for (const [k, want] of cases) {
  const got = q(k).map((r) => r.path).sort();
  const pass = JSON.stringify(got) === JSON.stringify(want.sort());
  ok &&= pass; console.log(pass ? "✅" : "❌", k, got);
}
process.exit(ok ? 0 : 1);
