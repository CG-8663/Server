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


class TelemetryPowerAndSessionsTests(unittest.TestCase):
    def test_nvidia_gpus_parses_vram_temp_and_power(self):
        sample = "0, NVIDIA GeForce RTX 4090, GPU-123, 55, 8192, 24576, 67, 210.5\n"
        rows = agent._nvidia_gpus(lambda _cmd, _args: sample)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["used"], 55)
        self.assertEqual(rows[0]["vramUsed"], 8192 * 1024 * 1024)
        self.assertEqual(rows[0]["vramTotal"], 24576 * 1024 * 1024)
        self.assertEqual(rows[0]["temp"], 67.0)
        self.assertEqual(rows[0]["power"], 210.5)

    def test_net_io_calculates_rates_and_skips_virtual(self):
        agent._net_last = None
        proc1 = (
            "Inter-|   Receive\n"
            " face |bytes packets errs drop fifo frame compressed multicast|bytes packets\n"
            "    lo: 1000 10 0 0 0 0 0 0 1000 10\n"
            "docker0: 5000 10 0 0 0 0 0 0 5000 10\n"
            "  eth0: 10000 10 0 0 0 0 0 0 20000 10\n"
        )
        proc2 = (
            "Inter-|   Receive\n"
            " face |bytes packets errs drop fifo frame compressed multicast|bytes packets\n"
            "    lo: 9000 10 0 0 0 0 0 0 9000 10\n"
            "docker0: 99999 10 0 0 0 0 0 0 99999 10\n"
            "  eth0: 12000 10 0 0 0 0 0 0 26000 10\n"
        )
        first = agent.net_io(read_file=lambda _p: proc1, now=lambda: 100.0)
        self.assertEqual(first, {"rx": 0, "tx": 0})
        second = agent.net_io(read_file=lambda _p: proc2, now=lambda: 102.0)
        self.assertEqual(second, {"rx": 1000, "tx": 3000})

    def test_lan_macs_filters_virtual_and_zero(self):
        files = {
            "/sys/class/net/lo/address": "00:00:00:00:00:00\n",
            "/sys/class/net/docker0/address": "02:42:ac:11:00:01\n",
            "/sys/class/net/enp3s0/address": "AA:BB:CC:DD:EE:FF\n",
            "/sys/class/net/wlan0/address": "11:22:33:44:55:66\n",
        }
        macs = agent.lan_macs(list_dir=lambda _r: ["lo", "docker0", "enp3s0", "wlan0"], read_file=lambda p: files.get(p, ""))
        self.assertEqual(macs, ["aa:bb:cc:dd:ee:ff", "11:22:33:44:55:66"])

    def test_trim_scrollback_preserves_utf8_boundaries(self):
        # 3-byte UTF-8 character '€' = b'\xe2\x82\xac'
        buf = bytearray(b"a" * 5 + "€".encode("utf-8") + b"b" * 5)
        agent._trim_scrollback(buf, limit=7)
        # Should drop partial leading continuation bytes and decode cleanly as UTF-8.
        decoded = buf.decode("utf-8")
        self.assertTrue(decoded.endswith("bbbbb"))

    def test_shell_session_resumes_and_replays_scrollback(self):
        class FakeWS:
            def __init__(self):
                self.bin = bytearray()

            def send_binary(self, payload):
                self.bin += payload[4:]

        conn = agent.Connection.__new__(agent.Connection)
        conn.allowed = {"terminal": True}
        conn.ws = FakeWS()
        sent = []
        conn.send = sent.append
        try:
            ch1 = agent.open_shell_session(conn, 1, 80, 24, name="test-resume", fresh=True)
            self.assertTrue(any(m.get("op") == "attached" and m.get("resumed") is False for m in sent))
            ch1.write(b"echo SWARM_PERSIST_OK\n")
            deadline = __import__("time").time() + 5
            while __import__("time").time() < deadline and b"SWARM_PERSIST_OK" not in conn.ws.bin:
                __import__("time").sleep(0.05)
            self.assertIn(b"SWARM_PERSIST_OK", conn.ws.bin)
            # Detach ch1 (does not kill the shell).
            ch1.close()
            # Reattach on ch2: should report resumed=True and replay buffered output.
            conn.ws = FakeWS()
            sent.clear()
            ch2 = agent.open_shell_session(conn, 2, 80, 24, name="test-resume", fresh=False)
            self.assertTrue(any(m.get("op") == "attached" and m.get("resumed") is True for m in sent))
            self.assertIn(b"SWARM_PERSIST_OK", conn.ws.bin)
            ch2.close()
        finally:
            agent.kill_shell_session("test-resume")

    def test_power_actions_registered(self):
        self.assertIn("shutdown", agent.ACTIONS)
        self.assertIn("suspend", agent.ACTIONS)


if __name__ == "__main__":
    unittest.main()
