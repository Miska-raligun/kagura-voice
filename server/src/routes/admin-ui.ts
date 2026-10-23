// 管理界面页面：/admin（只许本机）。前端代码在 server/admin-ui/，构建时由 scripts/build.mjs 编译后内联进产物
import { bytes, json, type Router } from "../http/router.ts";
import { isLocal } from "./admin.ts";
// 构建时的虚拟模块：{ js, css }（见 scripts/build.mjs 的 adminUi 插件）
import { js, css } from "virtual:admin-ui";

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kagura</title><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23041c1c'/%3E%3Ctext x='16' y='22' font-size='17' font-family='sans-serif' font-weight='800' text-anchor='middle' fill='%23ffe6cb'%3EK%3C/text%3E%3C/svg%3E">
<script>try{document.documentElement.dataset.theme=localStorage.getItem("kagura-theme")||"dark"}catch(e){}</script><style>${css}</style></head>
<body><div id="app"></div><script type="module" src="/admin/app.js"></script></body></html>`;

export function registerAdminUi(r: Router) {
  const deny = () => json({ error: "管理界面只允许本机访问：请在运行服务端的这台电脑上打开 http://127.0.0.1:端口/admin" }, 403);
  r.get("/admin", (req) => (isLocal(req) ? bytes(Buffer.from(html), "text/html; charset=utf-8", { "Cache-Control": "no-cache" }) : deny()));
  r.get("/admin/app.js", (req) => (isLocal(req) ? bytes(Buffer.from(js), "text/javascript; charset=utf-8", { "Cache-Control": "no-cache" }) : deny()));
}
