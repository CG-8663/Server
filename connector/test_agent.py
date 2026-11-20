import json
import os
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))
import agent  # noqa: E402


class Run(unittest.TestCase):
    # #117
    def test_whitespace_only_output(self):
        with self.assertRaisesRegex(RuntimeError, "^sh failed$"):
            agent.run(["sh", "-c", "echo; exit 1"])
        with self.assertRaisesRegex(RuntimeError, "boom"):
            agent.run(["sh", "-c", "echo boom >&2; exit 1"])


class Plugins(unittest.TestCase):
    # #177
    def test_manifest_that_is_not_an_object(self):
        with tempfile.TemporaryDirectory() as home:
            for name, body in (("a", "[]"), ("b", "null"), ("c", '{"id": "real"}')):
                os.makedirs(os.path.join(home, ".config/omarchy/plugins", name))
                with open(os.path.join(home, ".config/omarchy/plugins", name, "manifest.json"), "w") as f:
                    f.write(body)
            with mock.patch.dict(os.environ, {"HOME": home}), mock.patch("shutil.which", lambda n: "/x" if n == "omarchy" else None):
                self.assertEqual(agent.omarchy_facts()["plugins"], ["a", "b", "real"])


class ShellReap(unittest.TestCase):
    # #180: a closed terminal is reaped, not left as a zombie.
    def test_closed_shell_is_reaped(self):
        sent = []
        conn = mock.Mock()
        conn.send = sent.append
        conn.binary = lambda *a, **k: None
        sh = agent.Shell(conn, 1, 80, 24)
        pid = sh.pid
        time.sleep(0.3)
        sh.close()
        for _ in range(60):
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                break
            time.sleep(0.1)
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)


if __name__ == "__main__":
    unittest.main()
