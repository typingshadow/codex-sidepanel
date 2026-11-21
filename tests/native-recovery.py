"""Exercise development native connector framing against an isolated fake server."""
import json
from pathlib import Path
import select
import struct
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class NativeRecovery(unittest.TestCase):
    def exercise(self, action, expected):
        with tempfile.TemporaryDirectory() as directory:
            fake = Path(directory) / "codex"
            fake.write_text("#!" + sys.executable + "\nimport json, sys, time\n"
                            "for line in sys.stdin:\n"
                            " req = json.loads(line)\n"
                            " print(json.dumps({'id':req.get('id'),'result':{'account':None}}), flush=True)\n"
                            " " + action + "\n time.sleep(5)\n")
            fake.chmod(0o700)
            with subprocess.Popen([sys.executable, str(ROOT / "host.py"), str(fake), directory],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, bufsize=0) as proc:
                def exact(size):
                    data = bytearray()
                    while len(data) < size:
                        self.assertTrue(select.select([proc.stdout], [], [], 5)[0])
                        part = proc.stdout.read(size - len(data))
                        self.assertTrue(part)
                        data.extend(part)
                    return bytes(data)

                def read():
                    return json.loads(exact(struct.unpack("<I", exact(4))[0]))

                try:
                    self.assertEqual(read()["bridgeInfo"]["protocol"], 3)
                    body = json.dumps({"id": 7, "method": "account/read", "params": {}}).encode()
                    proc.stdin.write(struct.pack("<I", len(body)) + body)
                    self.assertEqual(read()["id"], 7)
                    self.assertIn(expected, read()["bridgeError"])
                    proc.wait(timeout=5)
                finally:
                    if proc.poll() is None:
                        proc.kill()

    def test_file_picker_does_not_block_other_windows(self):
        with tempfile.TemporaryDirectory() as directory:
            fake = Path(directory) / "codex"
            fake.write_text("#!" + sys.executable + "\nimport sys, time\ntime.sleep(10)\n")
            fake.chmod(0o700)
            runner = ("import host,sys,time; host.pick_workspace=lambda _:time.sleep(10);"
                      "host.run_server(sys.argv[1],sys.argv[2])")
            with subprocess.Popen([sys.executable, "-c", runner, str(fake), directory],
                                  cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE) as proc:
                try:
                    for rid, method in enumerate(["workspace/pick", "workspace/pick", "workspace/list"], 1):
                        body = json.dumps({"id": rid, "method": method, "params": {}}).encode()
                        proc.stdin.write(struct.pack("<I", len(body)) + body)
                    proc.stdin.flush()
                    self.assertTrue(select.select([proc.stdout], [], [], 3)[0])
                    for rid in (2, 3):
                        length, = struct.unpack("<I", proc.stdout.read(4))
                        packet = json.loads(proc.stdout.read(length))
                        self.assertEqual(packet["id"], rid)
                        if rid == 2:
                            self.assertIn("error", packet)
                        else:
                            self.assertEqual(packet["result"]["default"], directory)
                finally:
                    proc.stdin.close()
                    proc.wait(timeout=5)

    def test_account_change_before_any_thread(self):
        self.exercise("print(json.dumps({'method':'account/updated'}), flush=True)", "账号")

    def test_oversized_unterminated_line(self):
        self.exercise("sys.stdout.write('x'*(8*1024*1024+1)); sys.stdout.flush()", "消息过大")


if __name__ == "__main__":
    unittest.main()
