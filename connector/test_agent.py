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


class Disks(unittest.TestCase):
    # #185: only the real system folders are hidden, not names that merely start the same way.
    def test_prefix_is_a_whole_folder(self):
        mounts = "/dev/sda1 /mnt/x ext4 rw 0 0\n/dev/sdb1 /snapshots btrfs rw 0 0\n/dev/sdc1 /boot vfat rw 0 0\n/dev/sdd1 /var/lib/docker-data ext4 rw 0 0\n"
        st = mock.Mock(f_blocks=100, f_frsize=4096, f_bavail=50, f_bfree=50)
        with mock.patch.object(agent, "read", lambda p, *a: mounts if p == "/proc/mounts" else ""), mock.patch("os.statvfs", lambda p: st):
            got = [d["mount"] for d in agent.disks()]
        self.assertIn("/snapshots", got)
        self.assertIn("/var/lib/docker-data", got)
        self.assertNotIn("/boot", got)


class BackupFolders(unittest.TestCase):
    # #187: a folder that leads outside home is neither offered nor fatal.
    def test_link_out_of_home(self):
        with tempfile.TemporaryDirectory() as home, tempfile.TemporaryDirectory() as other:
            os.mkdir(os.path.join(home, "Documents"))
            os.symlink(other, os.path.join(home, "Pictures"))
            with mock.patch.dict(os.environ, {"HOME": home}):
                names = [f["name"] for f in agent.backup_folders({})["folders"]]
                self.assertEqual(names, ["Documents"])


class Restore(unittest.TestCase):
    # #188: a failed restore leaves no empty folder.
    def test_failed_restore_cleans_up(self):
        with tempfile.TemporaryDirectory() as home:
            with mock.patch.dict(os.environ, {"HOME": home}), mock.patch.object(agent, "restic_path", lambda: "/x"), mock.patch.object(agent, "start_relay", side_effect=RuntimeError("unreachable")):
                with self.assertRaises(RuntimeError):
                    agent.backup_restore(None, 1, {"password": "p", "snapshot": "abcdef12"}, {})
            restored = os.path.join(home, "Restored")
            self.assertEqual(os.listdir(restored) if os.path.isdir(restored) else [], [])


if __name__ == "__main__":
    unittest.main()
