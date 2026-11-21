import io
import json
import hashlib
from pathlib import Path
import select
import shutil
import struct
import subprocess
import sys
import threading
from urllib.parse import urlsplit

MAX_REPLY = 1024 * 1024
MAX_REQUEST = 256 * 1024
POLICY = json.loads(Path(__file__).with_name("bridge-policy.json").read_text())
EVENTS = {"item/started", "item/agentMessage/delta", "item/completed", "turn/completed"}
ITEM_TYPES = {"commandExecution", "dynamicToolCall", "mcpToolCall", "webSearch", "fileChange", "agentMessage"}


def error(request_id, message):
    return {"id": request_id, "error": {"code": -32602, "message": message}}


def workspace_registry():
    return Path.home() / "Library/Application Support/Codex Browser Connector/Workspaces"


def workspaces(default):
    directories = {default}
    for entry in workspace_registry().glob("*.json"):
        try:
            directory = json.loads(entry.read_text())
            if isinstance(directory, str) and Path(directory).is_absolute() and Path(directory).is_dir():
                directories.add(directory)
        except (ValueError, OSError):
            continue
    return sorted(directories)


def pick_workspace(default):
    picker = Path(__file__).with_name("workspace-picker.js")
    result = subprocess.run(["/usr/bin/osascript", "-l", "JavaScript", str(picker), default],
                            capture_output=True, text=True, check=True, timeout=120)
    selected = result.stdout.rstrip("\n")
    if not selected:
        return None
    directory = str(Path(selected).resolve(strict=True))
    if not Path(directory).is_dir():
        raise ValueError("请选择文件夹。")
    registry = workspace_registry()
    registry.mkdir(parents=True, exist_ok=True)
    name = hashlib.sha256(directory.encode()).hexdigest()
    (registry / (name + ".json")).write_text(json.dumps(directory))
    return directory


def remove_workspace(directory, default):
    if not isinstance(directory, str) or not Path(directory).is_absolute() or directory == default:
        raise ValueError("默认工作目录不可移除。")
    key = hashlib.sha256(directory.encode()).hexdigest()
    (workspace_registry() / (key + ".json")).unlink(missing_ok=True)


def make_request(method, params, workspace, allowed):
    thread_id = params.get("threadId")
    if method == "initialize":
        return {"clientInfo": {"name": POLICY["clientName"], "version": "1.4.2"}}
    if method == "initialized":
        return {}
    if method == "account/read":
        return {"refreshToken": False}
    if method == "thread/list":
        return {"archived": False, "currentAccountOnly": True, "limit": 40,
                "sortKey": "updated_at", "cursor": params.get("cursor")}
    if method != "thread/start" and (not isinstance(thread_id, str) or thread_id not in allowed):
        raise ValueError("此会话不在当前账号的侧栏历史中，请重新打开历史菜单。")
    if method in {"thread/start", "thread/resume"}:
        if method == "thread/resume":
            directory = allowed[thread_id]
        else:
            directory = params.get("workspace") or workspace
        if directory not in workspaces(workspace):
            raise ValueError("此工作目录不可用，请重新选择文件夹。")
        request = {"cwd": directory, "sandbox": "workspace-write", "approvalPolicy": "never",
                   "developerInstructions": POLICY["instructions"]}
        if method == "thread/resume":
            request.update(threadId=thread_id, excludeTurns=True)
        return request
    if method == "thread/turns/list":
        return {"threadId": thread_id, "cursor": params.get("cursor"), "limit": 4,
                "sortDirection": "desc", "itemsView": "summary"}
    if method == "turn/interrupt":
        return {"threadId": thread_id, "turnId": params.get("turnId")}
    if method == "turn/start":
        if allowed[thread_id] not in workspaces(workspace):
            raise ValueError("此工作目录已移除或不可用，请重新选择。")
        text, effort, target = params.get("text"), params.get("effort"), params.get("writeTarget")
        if not isinstance(text, str) or not text.strip() or len(text) > 16000 or effort not in ("low", "medium", "high"):
            raise ValueError("请求格式无效，或消息太长。")
        targets = params.get("writeTargets")
        if targets is None:
            targets = [target] if target else []
        if not isinstance(targets, list) or len(targets) > 100:
            raise ValueError("工作区页面列表无效。")
        if target and target not in targets:
            raise ValueError("聚焦页面不在本次工作区中。")
        for page in targets:
            url = urlsplit(page) if isinstance(page, str) else None
            parts = url.path.strip("/").split("/") if url else []
            if (not url or url.scheme != "https" or not url.hostname or url.netloc != url.hostname
                    or not any(url.hostname.endswith("." + domain) or url.hostname == domain
                               for domain in ("feishu.cn", "larksuite.com", "doubao.com"))
                    or len(parts) != 2 or parts[0] not in ("docx", "wiki", "base", "sheets", "sheet")
                    or not parts[1].isascii() or not parts[1].isalnum() or url.query or url.fragment):
                raise ValueError("工作区中存在无效的飞书页面链接。")
        mode = POLICY["readTurn"]
        if targets:
            mode = (POLICY["writeTurn"] + (target or "未选择；按用户指令确定目标") +
                    "\n本次可读写的工作区页面：\n" + "\n".join(dict.fromkeys(targets)))
        return {"threadId": thread_id, "effort": effort,
                "input": [{"type": "text", "text": mode + "\n\n用户请求：\n" + text, "text_elements": []}]}
    raise ValueError("连接器不支持该请求。")


def safe_response(method, packet, allowed):
    result = packet.get("result")
    if not isinstance(result, dict):
        return packet
    if method == "account/read":
        account = result.get("account")
        packet["result"] = {"authenticated": bool(account), "requiresOpenaiAuth": result.get("requiresOpenaiAuth", True)}
    elif method == "thread/list":
        threads = [entry for entry in result.get("data", []) if entry.get("originator") == POLICY["clientName"]]
        allowed.update({entry["id"]: entry.get("cwd") for entry in threads})
        packet["result"] = {"data": [{k: entry.get(k) for k in ("id", "name", "preview", "cwd")}
                                     for entry in threads],
                            "nextCursor": result.get("nextCursor")}
    elif method in {"thread/start", "thread/resume"}:
        thread_id = result["thread"]["id"]
        allowed[thread_id] = result.get("cwd") or result["thread"].get("cwd")
        packet["result"] = {"thread": {"id": thread_id}}
    elif method == "thread/turns/list":
        packet["result"] = {"data": [{"items": [
            history_item(item)
            for item in turn.get("items", []) if item.get("type") in ("userMessage", "agentMessage")
        ]} for turn in result.get("data", [])], "nextCursor": result.get("nextCursor")}
    return packet


def history_item(item):
    if item["type"] == "agentMessage":
        return {"type": "agentMessage", "text": item["text"]}
    content = []
    for part in item.get("content", []):
        if part.get("type") == "text":
            text = part["text"]
            if text.startswith((POLICY["readTurn"], POLICY["writeTurn"], "Active Feishu document for this turn.", "Connector mode for this turn: the user enabled editing for this document only: ")):
                _, _, text = text.partition("\n\n用户请求：\n")
            content.append({"type": "text", "text": text})
    return {"type": "userMessage", "content": content}


def send(packet):
    data = json.dumps(packet, ensure_ascii=False).encode()
    if len(data) > MAX_REPLY:
        packet = error(packet["id"], "回复过长，无法传回侧栏。") if "id" in packet else {"bridgeError": "单条事件过长。"}
        data = json.dumps(packet, ensure_ascii=False).encode()
    sys.stdout.buffer.write(struct.pack("<I", len(data)) + data)
    sys.stdout.buffer.flush()


def safe_event(packet):
    method = packet.get("method")
    if method not in EVENTS:
        return None
    if method == "turn/completed":
        turn = packet["params"]["turn"]
        packet["params"]["turn"] = {k: turn[k] for k in ("id", "status", "error") if k in turn}
    if method not in ("item/started", "item/completed"):
        return packet
    params = packet.get("params", {})
    item = params.get("item", {})
    if item.get("type") not in ITEM_TYPES:
        return None
    params["item"] = {k: item[k] for k in ("id", "type", "text") if k in item}
    return packet


def run_server(codex, workspace):
    home = Path.home()
    lark_paths = [home / "Library/Application Support/lark-cli"]
    if shutil.which("codex-lark-cli"):
        lark_paths.append(home / "Library/Application Support/Codex Lark CLI/config")
    else:
        lark_paths.append(home / ".lark-cli/locks")
    command = [codex, "app-server", "--listen", "stdio://", "-c", "sandbox_workspace_write.network_access=true",
               "-c", "sandbox_workspace_write.writable_roots=" + json.dumps([str(path) for path in lark_paths])]
    for override in POLICY["appServerConfigOverrides"]:
        command.extend(["-c", override])
    with subprocess.Popen(
        command,
        cwd=workspace, stdin=subprocess.PIPE, stdout=subprocess.PIPE, bufsize=0,
    ) as server:
        state_lock = threading.Lock()
        write_lock = threading.Lock()
        output_lock = threading.Lock()
        stopping = threading.Event()
        in_flight = {}
        allowed = {}
        account_checked = False
        picker_lock = threading.Lock()

        def forward(packet):
            with write_lock:
                server.stdin.write(json.dumps(packet).encode() + b"\n")

        def reply(packet):
            with output_lock:
                send(packet)

        def relay():
            nonlocal account_checked
            try:
                stream = io.BufferedReader(server.stdout)
                while line := stream.readline(8 * 1024 * 1024 + 1):
                    if len(line) > 8 * 1024 * 1024:
                        reply({"bridgeError": "Codex 返回的消息过大。"})
                        break
                    packet = json.loads(line)
                    if "method" in packet and "id" in packet:
                        forward(error(packet["id"], "此侧栏不处理额外的权限申请。"))
                    elif packet.get("method") == "account/updated":
                        with state_lock:
                            had_scope = account_checked or bool(allowed)
                            allowed.clear()
                        if had_scope:
                            reply({"bridgeError": "Codex 账号状态已变化，请重新连接。"})
                            break
                    elif "id" in packet:
                        with state_lock:
                            request = in_flight.pop(packet["id"], None)
                            if request:
                                method = request
                                if method == "account/read":
                                    account_checked = True
                                    allowed.clear()
                                reply(safe_response(method, packet, allowed))
                    else:
                        event = safe_event(packet)
                        if event is None:
                            continue
                        reply(event)
            except (BrokenPipeError, OSError, ValueError, KeyError):
                pass
            finally:
                stopping.set()

        def choose_directory(request_id):
            try:
                selected = pick_workspace(workspace)
                reply({"id": request_id, "result": {"default": workspace, "paths": workspaces(workspace), "selected": selected}})
            except (OSError, ValueError, subprocess.SubprocessError) as exc:
                reply(error(request_id, str(exc)))
            finally:
                picker_lock.release()

        reader = threading.Thread(target=relay, daemon=True)
        reader.start()
        try:
            # Raw stdin avoids buffered bytes getting stranded between select calls.
            input_stream = sys.stdin.buffer.raw
            def read_exact(size):
                data = bytearray()
                while len(data) < size and not stopping.is_set():
                    if not select.select([input_stream], [], [], 0.2)[0]:
                        continue
                    chunk = input_stream.read(size - len(data))
                    if not chunk:
                        return None
                    data.extend(chunk)
                return data if len(data) == size else None

            while (header := read_exact(4)) is not None:
                size, = struct.unpack("<I", header)
                payload = read_exact(size) if 0 < size <= MAX_REQUEST else None
                if payload is None:
                    break
                packet = json.loads(payload)
                request_id, method = packet.get("id"), packet.get("method")
                try:
                    if method == "workspace/pick":
                        if picker_lock.acquire(blocking=False):
                            threading.Thread(target=choose_directory, args=(request_id,), daemon=True).start()
                        else:
                            reply(error(request_id, "已有文件夹选择器打开。"))
                        continue
                    if method in ("workspace/list", "workspace/remove"):
                        selected = None
                        if method == "workspace/remove":
                            remove_workspace((packet.get("params") or {}).get("path"), workspace)
                        reply({"id": request_id, "result": {"default": workspace, "paths": workspaces(workspace), "selected": selected}})
                        continue
                    with state_lock:
                        params = make_request(method, packet.get("params") or {}, workspace, allowed)
                        if request_id is not None:
                            in_flight[request_id] = method
                    forward({"id": request_id, "method": method, "params": params} if request_id is not None
                            else {"method": method, "params": params})
                except (ValueError, TypeError, subprocess.SubprocessError, FileNotFoundError) as exc:
                    if request_id is not None:
                        reply(error(request_id, str(exc)))
        except (BrokenPipeError, OSError, ValueError, AttributeError):
            pass
        finally:
            if server.poll() is None:
                server.terminate()
                try:
                    server.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    server.kill()
            reader.join(timeout=2)


def main():
    codex, workspace = sys.argv[1:]
    send({"bridgeInfo": {"larkCli": bool(shutil.which("codex-lark-cli") or shutil.which("lark-cli")), "protocol": 3, "workspaces": True,
                         "workspaceManagement": True, "groupEditing": True}})
    try:
        run_server(codex, workspace)
    except OSError as exc:
        print(exc, file=sys.stderr)
        send({"bridgeError": "找不到本机 Codex。" if not Path(codex).exists() else "本机连接器无法启动 Codex。"})


if __name__ == "__main__":
    main()
