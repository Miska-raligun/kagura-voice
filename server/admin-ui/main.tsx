// Kagura 管理界面：本机浏览器打开 http://127.0.0.1:5000/admin。所有数据走 /api/admin/*。
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { api } from "./api.ts";
import { Icon, Toasts, type IconName } from "./ui.tsx";
import { Overview } from "./pages/overview.tsx";
import { Agents } from "./pages/agents.tsx";
import { Sessions } from "./pages/sessions.tsx";
import { Memory } from "./pages/memory.tsx";
import { Skills } from "./pages/skills.tsx";
import { Plugins } from "./pages/plugins.tsx";
import { Jobs } from "./pages/jobs.tsx";
import { Tasks } from "./pages/tasks.tsx";
import { A2A } from "./pages/a2a.tsx";
import { Channels } from "./pages/channels.tsx";
import { Devices } from "./pages/devices.tsx";
import { Usage } from "./pages/usage.tsx";
import { Settings } from "./pages/settings.tsx";

type Page = [id: string, label: string, icon: IconName, comp: (p: { arg: string }) => any];
const GROUPS: [string, Page[]][] = [
  ["概览", [
    ["overview", "总览", "home", Overview],
    ["sessions", "会话", "chat", Sessions],
    ["usage", "用量", "chart", Usage],
  ]],
  ["Agent", [
    ["agents", "Agents", "bot", Agents],
    ["memory", "记忆", "brain", Memory],
    ["skills", "技能", "book", Skills],
    ["plugins", "扩展 / MCP", "puzzle", Plugins],
    ["jobs", "定时任务", "clock", Jobs],
    ["tasks", "待办", "moon", Tasks],
    ["a2a", "Agent 通信", "link", A2A],
  ]],
  ["连接", [
    ["channels", "渠道", "send", Channels],
    ["devices", "设备", "cpu", Devices],
  ]],
  ["系统", [
    ["settings", "设置", "gear", Settings],
  ]],
];
const PAGES = GROUPS.flatMap(([, p]) => p);

/** #/agents/mio → ["agents", "mio"] */
function useRoute(): [string, string] {
  const parse = (): [string, string] => {
    let [, page = "overview", ...rest] = location.hash.replace(/^#/, "").split("/");
    if (page === "chat") page = "sessions";      // 旧的「网页聊天」页并进了会话页
    return [page || "overview", decodeURIComponent(rest.join("/"))];
  };
  const [r, set] = useState(parse());
  useEffect(() => { const f = () => set(parse()); addEventListener("hashchange", f); return () => removeEventListener("hashchange", f); }, []);
  return r;
}

type Theme = "dark" | "light" | "auto";
const loadTheme = (): Theme => { try { return (localStorage.getItem("kagura-theme") as Theme) || "dark"; } catch { return "dark"; } };

function ThemeSwitch() {
  const [t, setT] = useState<Theme>(loadTheme());
  useEffect(() => {
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem("kagura-theme", t); } catch { /* 无痕窗口 */ }
  }, [t]);
  const opts: [Theme, IconName, string][] = [["dark", "moon", "深色"], ["light", "sun", "浅色"], ["auto", "monitor", "跟随系统"]];
  return <div class="theme">{opts.map(([v, i, l]) => <button class={t === v ? "on" : ""} title={l} onClick={() => setT(v)}><Icon name={i} /></button>)}</div>;
}

function App() {
  const [page, arg] = useRoute();
  const [menu, setMenu] = useState(false);
  const [ver, setVer] = useState("");
  const cur = PAGES.find((p) => p[0] === page) ?? PAGES[0];
  const PageComp = cur[3];
  useEffect(() => { document.title = `${cur[1]} · Kagura`; setMenu(false); }, [page]);
  useEffect(() => { api("/overview").then((d) => setVer(d.version ?? "")).catch(() => {}); }, []);
  return (
    <div class="app">
      <aside class={`side ${menu ? "open" : ""}`}>
        <div class="brand"><div class="logo">K</div><div><b>Kagura</b><small>{ver ? `v${ver}` : "admin"}</small></div></div>
        <nav>
          {GROUPS.map(([g, pages]) => (
            <div class="nav-group"><span>{g}</span>
              {pages.map(([id, label, icon]) => <a class={id === cur[0] ? "on" : ""} href={`#/${id}`}><Icon name={icon} />{label}</a>)}
            </div>
          ))}
        </nav>
        <div class="side-foot"><span><i class="dot" />运行中</span><ThemeSwitch /></div>
      </aside>
      {menu && <div class="scrim" onClick={() => setMenu(false)} />}
      <main>
        <header class="top"><button class="menu" onClick={() => setMenu(!menu)}><Icon name="menu" /></button><h2>{cur[1]}</h2></header>
        <PageComp key={page} arg={arg} />
      </main>
      <Toasts />
    </div>
  );
}

document.documentElement.dataset.theme = loadTheme();
render(<App />, document.getElementById("app")!);
