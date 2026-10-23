"""契约测试用的独立 MQTT broker（amqtt，纯 Python）。被测服务端没有内置 broker 时由 conftest 拉起。
用法：python _broker.py <port>
"""
import asyncio
import sys

from amqtt.broker import Broker


async def main(port: int) -> None:
    broker = Broker({
        "listeners": {"default": {"type": "tcp", "bind": f"127.0.0.1:{port}"}},
        "plugins": {"amqtt.plugins.authentication.AnonymousAuthPlugin": {"allow_anonymous": True}},
    })
    await broker.start()
    print("BROKER-READY", flush=True)
    await asyncio.Event().wait()


if __name__ == "__main__":
    asyncio.run(main(int(sys.argv[1])))
