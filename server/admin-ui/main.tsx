// Kagura 管理界面（§7）：本机浏览器打开 http://127.0.0.1:5000/admin。所有数据走 /api/admin/*。
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Toasts } from "./ui.tsx";
import { Overview } from "./pages/overview.tsx";
import { Agents } from "./pages/agents.tsx";
import { Sessions } from "./pages/sessions.tsx";
import { Memory } from "./pages/memory.tsx";
import { Skills } from "./pages/skills.tsx";
import { Plugins } from "./pages/plugins.tsx";
import { Jobs } from "./pages/jobs.tsx";
import { A2A } from "./pages/a2a.tsx";
import { Channels } from "./pages/channels.tsx";
import { Devices } from "./pages/devices.tsx";
import { Usage } from "./pages/usage.tsx";
import { Settings } from "./pages/settings.tsx";

const PAGES: [string, string, (p: { arg: string }) => any][] = [
  ["overview", "总览", Overview],
  ["agents", "Agents", Agents],
  ["sessions", "会话 / 聊天", Sessions],
  ["memory", "记忆", Memory],
  ["skills", "技能", Skills],
  ["plugins", "扩展 / MCP", Plugins],
  ["jobs", "定时任务", Jobs],
  ["a2a", "Agent 通信", A2A],
  ["channels", "渠道", Channels],
  ["devices", "设备", Devices],
  ["usage", "用量", Usage],
  ["settings", "设置", Settings],
];

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

function App() {
  const [page, arg] = useRoute();
  const [menu, setMenu] = useState(false);
  const cur = PAGES.find((p) => p[0] === page) ?? PAGES[0];
  const Page = cur[2];
  useEffect(() => { document.title = `${cur[1]} · Kagura`; setMenu(false); }, [page]);
  return (
    <div class="app">
      <nav class={`side ${menu ? "open" : ""}`}>
        <div class="brand">Kagura<small>管理</small></div>
        {PAGES.map(([id, label]) => <a class={id === cur[0] ? "on" : ""} href={`#/${id}`}>{label}</a>)}
        <a class="ext" href="/monitor" target="_blank">监控页 ↗</a>
      </nav>
      <main>
        <header class="top"><button class="menu" onClick={() => setMenu(!menu)}>☰</button><h2>{cur[1]}</h2></header>
        <Page key={page} arg={arg} />
      </main>
      <Toasts />
    </div>
  );
}

render(<App />, document.getElementById("app")!);
