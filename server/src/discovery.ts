// UDP 发现应答：设备广播 KAGURA_DISCOVER，回 KAGURA_HERE，设备从回包源地址得知服务端 IP。
// 以前跑在 WSL 里收不到局域网广播，要靠 Windows 侧的 discovery_relay 中转；现在原生运行，直接内置。
import dgram from "node:dgram";

export function startDiscovery(port: number): Promise<dgram.Socket | null> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    sock.on("message", (msg, rinfo) => {
      if (msg.toString().trim() === "KAGURA_DISCOVER") sock.send("KAGURA_HERE", rinfo.port, rinfo.address);
    });
    sock.once("error", (e) => { console.log(`⚠️  UDP 发现端口 ${port} 启动失败: ${e.message}`); resolve(null); });
    sock.bind(port, "0.0.0.0", () => { console.log(`UDP 发现监听 :${port}`); resolve(sock); });
  });
}
