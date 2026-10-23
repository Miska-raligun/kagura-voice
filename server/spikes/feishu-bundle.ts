// M0：飞书 SDK 能否被 esbuild 打进单文件，WSClient / EventDispatcher 能否构造（无真凭据，不连网）。
import * as Lark from "@larksuiteoapi/node-sdk";
const client = new Lark.Client({ appId: "cli_test", appSecret: "secret_test", disableTokenCache: true });
const dispatcher = new Lark.EventDispatcher({}).register({
  "im.message.receive_v1": async (data: any) => { console.log("msg", data?.message?.content); },
});
const ws = new Lark.WSClient({ appId: "cli_test", appSecret: "secret_test", loggerLevel: Lark.LoggerLevel.error });
const ok = typeof ws.start === "function" && typeof client.im.message.create === "function" && !!dispatcher;
console.log(ok ? "FEISHU-BUNDLE-OK" : "FEISHU-BUNDLE-FAIL");
process.exit(ok ? 0 : 1);
