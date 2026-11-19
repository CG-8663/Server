import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))

LSBLK = {
    "blockdevices": [
        {"name": "nvme0n1", "path": "/dev/nvme0n1", "type": "disk", "size": 512000000000, "children": [
            {"name": "nvme0n1p2", "path": "/dev/nvme0n1p2", "type": "part", "fstype": "btrfs", "uuid": "11111111-1111-1111-1111-111111111111", "mountpoints": ["/", "/home"]}
        ]},
        {"name": "sdc", "path": "/dev/sdc", "type": "disk", "size": 2000000000000, "children": [
            {"name": "sdc1", "path": "/dev/sdc1", "type": "part", "fstype": "ntfs", "mountpoints": [None]}
        ]},
    ]
}


class Fake:
    def __init__(self):
        self.log = []

    def run(self, cmd, args):
        self.log.append([cmd, *args])
        if cmd == "lsblk":
            return json.dumps(LSBLK)
        return ""


class Helper(unittest.TestCase):
    def setUp(self):
        from helper import handle
        self.handle = handle
        self.fake = Fake()
        self.kw = dict(run=self.fake.run, user={"name": "chris", "uid": 1000, "home": "/home/chris"})

    def test_ping(self):
        self.assertEqual(self.handle("ping", [], **self.kw), "ok")

    def test_refuse_system_and_junk(self):
        with self.assertRaisesRegex(Exception, "holds the system"):
            self.handle("format", ["/dev/nvme0n1", "blank"], **self.kw)
        with self.assertRaisesRegex(Exception, "Not a drive"):
            self.handle("format", ["../../etc/passwd", "blank"], **self.kw)
        self.assertFalse(any(x[0] == "wipefs" for x in self.fake.log))

    def test_format_blank_then_ext4(self):
        self.assertEqual(self.handle("format", ["/dev/sdc", "blank"], **self.kw), "ok")
        self.assertIn(["wipefs", "-a", "/dev/sdc"], self.fake.log)
        self.fake.log.clear()
        self.handle("format", ["/dev/sdc", "ext4"], **self.kw)
        self.assertTrue(any(x[0] == "mkfs.ext4" for x in self.fake.log))


if __name__ == "__main__":
    unittest.main()
