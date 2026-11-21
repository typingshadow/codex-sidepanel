import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import sys

ROOT = Path(__file__).resolve().parent
APP_CLI = Path("/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex")


def extension_id():
    manifest = json.loads((ROOT / "extension/manifest.json").read_text())
    digest = hashlib.sha256(base64.b64decode(manifest["key"])).hexdigest()[:32]
    return digest.translate(str.maketrans("0123456789abcdef", "abcdefghijklmnop"))


def main():
    parser = argparse.ArgumentParser(description="安装 Chrome 侧栏的 macOS 本机连接器")
    parser.add_argument("--extension-id", default=extension_id(), help="商店版扩展的正式 ID")
    parser.add_argument("--codex", type=Path, help="本机 Codex 可执行文件的路径")
    parser.add_argument("--workspace", type=Path, help="Codex 会话工作目录")
    args = parser.parse_args()
    if not re.fullmatch("[a-p]{32}", args.extension_id):
        parser.error("扩展 ID 应为 32 位 a–p 字母。")
    shell_cli = shutil.which("codex")
    codex = (args.codex or (Path(shell_cli) if shell_cli else APP_CLI)).expanduser().absolute()
    if not codex.is_file() or not os.access(codex, os.X_OK):
        parser.error("找不到可执行的 Codex。请先安装 Codex，或使用 --codex 指定其路径。")
    home = Path.home()
    support = home / "Library/Application Support"
    workspace = args.workspace
    if workspace is None:
        workspace = support / "Codex Browser Connector/Workspace"
        workspace.mkdir(mode=0o700, parents=True, exist_ok=True)
    workspace = workspace.expanduser().resolve()
    if not workspace.is_dir():
        parser.error("--workspace 必须是已存在的目录。")

    host_dir = support / "Google/Chrome/NativeMessagingHosts"
    runtime = support / "Codex Feishu Sidepanel"
    host_dir.mkdir(parents=True, exist_ok=True)
    runtime.mkdir(mode=0o700, parents=True, exist_ok=True)
    files = ["host.py", "bridge-policy.json", "workspace-picker.js"]
    for filename in files:
        shutil.copyfile(ROOT / filename, runtime / filename)
    launcher = runtime / "launch-host"

    lark = shutil.which("codex-lark-cli") or shutil.which("lark-cli")
    path_dirs = [str(codex.parent)]
    if lark:
        path_dirs.append(str(Path(lark).parent))
    path_dirs.extend([
        str(home / ".local/bin"), str(home / ".npm-global/bin"), str(home / "bin"),
        "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin",
    ])
    env_path = shlex.quote(":".join(dict.fromkeys(path_dirs)))
    arguments = [sys.executable, str(runtime / "host.py"), str(codex), str(workspace)]
    command = shlex.join(arguments)
    log = shlex.quote(str(runtime / "bridge.log"))
    launcher.write_text(f'#!/bin/sh\nexport PATH={env_path}\nexec {command} 2>>{log}\n')
    launcher.chmod(0o700)
    host_name = "local.codex_sidepanel"
    (host_dir / (host_name + ".json")).write_text(json.dumps({
        "name": host_name,
        "description": "Chrome side panel connection to Codex App Server",
        "path": str(launcher),
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{args.extension_id}/"],
    }, indent=2))
    print(f"连接器已注册 · 扩展 ID {args.extension_id}")
    print(f"Codex 工作目录 {workspace}")
    print("已找到飞书 CLI，将沿用现有配置。" if lark else "终端未检测到飞书 CLI，可先连接 Codex。")
    if args.extension_id == extension_id():
        print(f"本地扩展目录 {ROOT / 'extension'}")


if __name__ == "__main__":
    main()
