// 网络代理：Node 自带的 fetch 不认系统代理和 HTTPS_PROXY 环境变量。配了代理（设置 → 工具，或环境变量）
// 就把全局 dispatcher 换成走代理的，联网搜索、读网页、调模型都走它；本机地址（Ollama 之类）直连。
import { Agent, EnvHttpProxyAgent, setGlobalDispatcher, fetch as undiciFetch } from "undici";

const LOCAL = "localhost,127.0.0.1,::1";
let current = "";

/** 生效中的代理（空 = 直连），给日志和管理界面看 */
export const activeProxy = () => current;

export function applyProxy(proxy: string, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || "";
  const p = proxy.trim() || fromEnv;
  if (!p) {
    if (current) setGlobalDispatcher(new Agent());
    current = "";
    return "";
  }
  const noProxy = [LOCAL, env.NO_PROXY || env.no_proxy || ""].filter(Boolean).join(",");
  setGlobalDispatcher(new EnvHttpProxyAgent({ httpProxy: p, httpsProxy: p, noProxy }));
  current = p;
  return p;
}

/** 联网工具用的 fetch：undici 自己的实现，一定跟着上面设的全局 dispatcher 走 */
export const proxiedFetch = undiciFetch as unknown as typeof fetch;
