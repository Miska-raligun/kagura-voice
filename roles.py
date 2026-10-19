"""角色切换：每台设备当前在跟哪个角色说话。

一个角色 = OpenClaw 的一个 agent + 一个百度音色 + 设备上一套背景图。
- 角色表来自 config.py 的 ROLES（可选），没配就只有一个默认角色，行为与加角色前一致。
- **第一个角色是默认角色**：它的会话 key 就是 device_id（沿用旧会话），
  其他角色的会话 key 是 "device_id~role_id"，各角色上下文互不串。
- 每台设备当前角色落盘 roles_state.json，服务端重启不丢；设备开机 GET /role 取回。
- 设备端背景图放 /flash/kagura/resource/<role_id>/img_xxx.jpg，缺哪张就沿用默认那张。
"""

import json
import re
import threading
from pathlib import Path
from typing import Optional

STATE_FILE = Path(__file__).parent / "roles_state.json"

# 默认角色 id 为空串：设备端 St.role="" 即用默认图目录，与旧版逐字节一致
_DEFAULT = [{"id": "", "name": "神乐", "agent": "main", "per": 111, "aliases": []}]

_lock = threading.Lock()
_roles: list = []
_current: dict = {}        # device_id → role_id


_ID_RE = re.compile(r"^[A-Za-z0-9_-]{0,24}$")


def _norm(r: dict) -> dict:
    rid = str(r.get("id", ""))
    if not _ID_RE.match(rid):
        # id 要进 HTTP 头（X-Role）、要当设备上的目录名：只许 ASCII 字母数字
        raise ValueError(f"角色 id 只能用字母/数字/_-（≤24）: {rid!r}")
    return {
        "id": rid,
        "name": str(r.get("name") or r.get("id") or "默认"),
        "agent": str(r.get("agent") or "main"),
        "per": int(r.get("per", 111)),
        "aliases": [str(a) for a in r.get("aliases", [])],
    }


def init(roles: Optional[list] = None, state_file: Optional[Path] = None) -> None:
    """载入角色表与设备当前角色。测试可传入自己的角色表和状态文件。"""
    global _roles, _current, STATE_FILE
    if state_file is not None:
        STATE_FILE = state_file
    _roles = [_norm(r) for r in (roles or _DEFAULT)]
    ids = [r["id"] for r in _roles]
    if len(set(ids)) != len(ids):
        raise ValueError(f"ROLES 里 id 重复: {ids}")
    _current = {}
    try:
        data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        _current = {k: v for k, v in data.items() if v in ids}
    except (OSError, ValueError):
        pass


def all_roles() -> list:
    return list(_roles)


def default() -> dict:
    return _roles[0]


def find(role_id: str) -> Optional[dict]:
    for r in _roles:
        if r["id"] == role_id:
            return r
    return None


def get(device_id: str) -> dict:
    with _lock:
        rid = _current.get(device_id)
    return find(rid) if rid is not None and find(rid) else default()


def set_role(device_id: str, role_id: str) -> Optional[dict]:
    """切换设备角色并落盘。role_id 不存在返回 None。"""
    role = find(role_id)
    if role is None:
        return None
    with _lock:
        if role_id == default()["id"]:
            _current.pop(device_id, None)
        else:
            _current[device_id] = role_id
        snapshot = dict(_current)
    try:
        tmp = STATE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(snapshot, ensure_ascii=False), encoding="utf-8")
        tmp.replace(STATE_FILE)
    except OSError as e:
        print(f"[role] 状态落盘失败: {e}")
    return role


def session_key(device_id: str, role: dict) -> str:
    """默认角色沿用 device_id（老会话不丢），其他角色各自一条会话。"""
    return device_id if role["id"] == default()["id"] else f"{device_id}~{role['id']}"


# ── 语音指令 ──────────────────────────────────────────────────────────────────

_PUNCT = re.compile(r"[\s，。！？、,.!?~～…]+")
# 只有"切换意图词"和"角色名"同时出现才算：防止"换个话题""让我想想"误触发
_SWITCH = re.compile(r"(切换|切到|切成|换成|换到|换回|召唤|我要找|我想找|我要和|我想和|我要跟|我想跟)")
# 「叫/让」太常见（"让神乐唱首歌"不是切换），只认「叫 XX 出来」「让 XX 来」
_LIST = re.compile(r"(有哪些|有几个|都有谁|有什么)(角色|人)")


def _names(r: dict) -> list:
    return [n for n in [r["name"], r["id"], *r["aliases"]] if n]


def match_switch(text: str) -> Optional[dict]:
    """「切换到 XX / 叫 XX 出来 / 我想和 XX 说话」→ 目标角色；不是切换指令返回 None。"""
    if len(_roles) < 2:
        return None
    t = _PUNCT.sub("", text or "").lower()
    strong = bool(_SWITCH.search(t))
    best, best_len = None, 0
    for r in _roles:
        for n in _names(r):
            n = n.lower()
            if n not in t or len(n) <= best_len:   # 最长匹配：「小神乐」优先于「神乐」
                continue
            if strong or re.search(r"(叫|让)" + re.escape(n) + r"(出来|过来|来)", t):
                best, best_len = r, len(n)
    return best


def match_list(text: str) -> Optional[str]:
    """「有哪些角色」→ 播报的句子。"""
    if len(_roles) < 2 or not _LIST.search(_PUNCT.sub("", text or "")):
        return None
    return "现在有" + "、".join(r["name"] for r in _roles) + "，说「切换到」加名字就能换。"


init()
