"""Build the macOS connector and, when a download URL is supplied, the Store ZIP."""

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from urllib.parse import urlparse
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[1]
HOST = "local.codex_sidepanel_macos"
INSTALL_DIR = "/Library/Application Support/Codex Browser Connector"
REGISTER_DIR = "/Library/Google/Chrome/NativeMessagingHosts"


def run(*args, env=None):
    return subprocess.check_call([str(arg) for arg in args], env=env)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--extension-id", required=True, help="Chrome Web Store item ID or a development ID")
    parser.add_argument("--download-url", help="HTTPS download URL for the notarized package")
    parser.add_argument("--out", type=Path, default=ROOT / "dist")
    args = parser.parse_args()
    if not re.fullmatch("[a-p]{32}", args.extension_id):
        parser.error("Use the 32-character Chrome extension ID.")
    if args.download_url:
        url = urlparse(args.download_url)
        if url.scheme != "https" or not url.hostname or url.username or url.password:
            parser.error("The installer download URL must use HTTPS with no credentials.")
    if args.download_url and not all(os.getenv(key) for key in ("CONNECTOR_APP_SIGN_ID", "CONNECTOR_INSTALLER_SIGN_ID")):
        parser.error("Store builds require Developer ID signing identities.")
    manifest = json.loads((ROOT / "extension/manifest.json").read_text())
    version = manifest["version"]
    args.out.mkdir(parents=True, exist_ok=True)
    pkg = args.out / f"Codex-Browser-Connector-{version}.pkg"

    with tempfile.TemporaryDirectory(prefix="codex-connector-build-") as directory:
        work = Path(directory)
        payload = work / "payload"
        binary = payload / INSTALL_DIR.lstrip("/") / "codex-browser-connector"
        registration = payload / REGISTER_DIR.lstrip("/") / (HOST + ".json")
        binary.parent.mkdir(parents=True)
        for filename in ("bridge-policy.json", "workspace-picker.js"):
            shutil.copyfile(ROOT / filename, binary.parent / filename)
        registration.parent.mkdir(parents=True)
        run("swiftc", "-module-cache-path", work / "modules", "-swift-version", "5",
            "-O", "-target", "arm64-apple-macos13.0",
            ROOT / "macos/Connector.swift", "-o", binary)
        identity = os.getenv("CONNECTOR_APP_SIGN_ID")
        run("codesign", "--force", "--timestamp" if identity else "--timestamp=none",
            "--options", "runtime", "--sign", identity or "-", binary)
        registration.write_text(json.dumps({
            "name": HOST, "description": "Codex Browser Connector", "type": "stdio",
            "path": INSTALL_DIR + "/codex-browser-connector",
            "allowed_origins": [f"chrome-extension://{args.extension_id}/"],
        }, indent=2) + "\n")
        installer_id = os.getenv("CONNECTOR_INSTALLER_SIGN_ID")
        sign_args = ["--sign", installer_id] if installer_id else []
        run("pkgbuild", "--root", payload, "--install-location", "/",
            "--identifier", "local.codex-sidepanel.connector", "--version", version, *sign_args, pkg,
            env={**os.environ, "COPYFILE_DISABLE": "1"})

    packaged_manifest = dict(manifest)
    channel = "Mac-Test"
    if args.download_url:
        packaged_manifest.pop("key", None)
        channel = "Store"
    release = {"hostName": HOST, "installerUrl": args.download_url or "", "packageInstall": True}
    archive_path = args.out / f"Codex-Sidepanel-{channel}-{version}.zip"
    with ZipFile(archive_path, "w", ZIP_DEFLATED) as archive:
        extension = ROOT / "extension"
        for source in sorted(extension.rglob("*")):
            relative = source.relative_to(extension)
            if source.is_file() and relative.as_posix() not in {"manifest.json", "release.js"} and not any(part.startswith(".") for part in relative.parts):
                archive.write(source, relative.as_posix())
        archive.writestr("manifest.json", json.dumps(packaged_manifest, ensure_ascii=False, indent=2))
        archive.writestr("release.js", "const release = " + json.dumps(release) + ";\n")
    print(pkg)
    print(archive_path)


if __name__ == "__main__":
    main()
