import hashlib
import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import agent


class SelfUpdateTests(unittest.TestCase):
    def test_info_includes_agent_sha(self):
        facts = agent.info()
        self.assertRegex(facts["agentSha"], r"^[0-9a-f]{64}$")
        self.assertIn("helperSha", facts)

    def test_update_self_verifies_sha_and_ast_and_replaces_atomically(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = os.path.join(tmp, "agent.py")
            with open(target, "wb") as f:
                f.write(b"#!/usr/bin/env python3\nOLD = 1\n")
            new_code = b"#!/usr/bin/env python3\nNEW = 2\n"
            good_sha = hashlib.sha256(new_code).hexdigest()

            # Wrong checksum is rejected and leaves file untouched.
            with self.assertRaisesRegex(RuntimeError, "checksum"):
                agent.update_self({"sha256": "0" * 64}, {}, target_path=target, fetch=lambda: new_code)
            with open(target, "rb") as f:
                self.assertIn(b"OLD = 1", f.read())

            # Invalid Python syntax is rejected even if checksum matches.
            bad_py = b"def broken(:\n"
            bad_sha = hashlib.sha256(bad_py).hexdigest()
            with self.assertRaisesRegex(RuntimeError, "valid Python"):
                agent.update_self({"sha256": bad_sha}, {}, target_path=target, fetch=lambda: bad_py)
            with open(target, "rb") as f:
                self.assertIn(b"OLD = 1", f.read())

            # Valid update replaces file atomically with 0o700 and schedules restart.
            restarted = threading.Event()
            res = agent.update_self({"sha256": good_sha}, {}, target_path=target, on_restart=restarted.set, fetch=lambda: new_code)
            self.assertEqual(res["sha256"], good_sha)
            self.assertTrue(res["restarting"])
            with open(target, "rb") as f:
                self.assertEqual(f.read(), new_code)
            self.assertEqual(os.stat(target).st_mode & 0o777, 0o700)
            self.assertTrue(restarted.wait(2.0))

    def test_update_self_requires_manage_ability(self):
        conn = agent.Connection.__new__(agent.Connection)
        conn.allowed = {"manage": False}
        conn.cfg = {"server": "https://127.0.0.1:7780", "id": "a" * 12, "key": "k" * 43}
        sent = []
        conn.send = sent.append
        conn.call({"id": 7, "name": "update-self", "args": {"sha256": "0" * 64}})
        self.assertEqual(len(sent), 1)
        self.assertFalse(sent[0]["ok"])
        self.assertIn("managing", sent[0]["error"].lower())


if __name__ == "__main__":
    unittest.main()
