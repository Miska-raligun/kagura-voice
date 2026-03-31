"""
discovery_relay.py
Windows 侧 UDP 发现中继：接收 M5Stack 的广播，回复本机 IP。
使用方法：python discovery_relay.py
（需要在 Windows 防火墙放行 UDP 5001 入站）
"""
import socket
import sys

DISC_PORT = 5001

def main():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.bind(("0.0.0.0", DISC_PORT))
    except OSError as e:
        print(f"[discovery] 绑定端口 {DISC_PORT} 失败: {e}")
        print("  请检查防火墙规则或端口占用")
        sys.exit(1)
    print(f"[discovery] 监听 UDP :{DISC_PORT}，等待设备广播...")
    while True:
        try:
            data, addr = sock.recvfrom(64)
            if data.strip() == b"KAGURA_DISCOVER":
                sock.sendto(b"KAGURA_HERE", addr)
                print(f"[discovery] 已回应 {addr[0]}")
        except KeyboardInterrupt:
            break
        except Exception as e:
            print(f"[discovery] 异常: {e}")
    sock.close()

if __name__ == "__main__":
    main()
