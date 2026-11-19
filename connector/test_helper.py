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
        {"name": "sda", "path": "/dev/sda", "type": "disk", "size": 4000000000000, "rota": True, "serial": "WD-A", "children": []},
        {"name": "sdb", "path": "/dev/sdb", "type": "disk", "size": 4000000000000, "rota": True, "serial": "WD-B", "children": []},
        {"name": "sdc", "path": "/dev/sdc", "type": "disk", "size": 2000000000000, "model": "WDC  ", "serial": "WD123", "rota": True, "tran": "sata", "children": [
            {"name": "sdc1", "path": "/dev/sdc1", "type": "part", "fstype": "ntfs", "mountpoints": [None]}
        ]},
        {"name": "sdd", "path": "/dev/sdd", "type": "disk", "size": 500000000000, "rota": False, "serial": "SSD-1", "children": []},
        {"name": "sde", "path": "/dev/sde", "type": "disk", "size": 1000000000000, "rota": True, "serial": "WD-E", "children": [
            {"name": "sde1", "path": "/dev/sde1", "type": "part", "fstype": "btrfs", "uuid": "44444444-4444-4444-4444-444444444444", "label": "old", "mountpoints": [None]}
        ]},
        {"name": "loop0", "path": "/dev/loop0", "type": "disk", "size": 1000000, "children": []},
    ]
}


class Fake:
    def __init__(self):
        self.log = []
        self.files = {"/etc/fstab": "UUID=1111 / btrfs defaults 0 0\n"}

    def run(self, cmd, args):
        self.log.append([cmd, *args])
        if cmd == "lsblk":
            return json.dumps(LSBLK)
        if cmd == "wipefs":
            return json.dumps({"signatures": []})
        if cmd == "blkid":
            return "33333333-3333-3333-3333-333333333333\n"
        if cmd == "zpool":
            raise Exception("zpool: not found")
        if cmd == "btrfs":
            if args[:2] == ["filesystem", "df"]:
                return "Data, RAID1: total=100, used=10\n"
            if args[:2] == ["device", "stats"]:
                return "[/dev/sda].write_io_errs  0\n[/dev/sdb].write_io_errs  0\n"
            if args[:2] == ["scrub", "status"]:
                return "Status: never\nError summary: no errors found\n"
            return ""
        return ""


class Helper(unittest.TestCase):
    def setUp(self):
        from helper import handle
        self.handle = handle
        self.fake = Fake()
        self.kw = dict(run=self.fake.run, user={"name": "chris", "uid": 1000, "home": "/home/chris"}, files=self.fake.files)

    def test_ping(self):
        self.assertEqual(self.handle("ping", [], **self.kw), "ok")

    def test_refuse_system_and_junk(self):
        with self.assertRaisesRegex(Exception, "holds the system"):
            self.handle("format", ["/dev/nvme0n1", "blank"], **self.kw)
        with self.assertRaisesRegex(Exception, "Not a drive"):
            self.handle("format", ["../../etc/passwd", "blank"], **self.kw)
        with self.assertRaisesRegex(Exception, "blank, ext4 or exfat"):
            self.handle("format", ["/dev/sdc", "ntfs"], **self.kw)
        self.assertFalse(any(x[0] == "wipefs" for x in self.fake.log))

    def test_format_blank_then_ext4(self):
        self.assertEqual(self.handle("format", ["/dev/sdc", "blank"], **self.kw), "ok")
        self.assertIn(["wipefs", "-a", "/dev/sdc"], self.fake.log)
        self.fake.log.clear()
        self.handle("format", ["/dev/sdc", "ext4"], **self.kw)
        self.assertTrue(any(x[0] == "mkfs.ext4" for x in self.fake.log))

    def test_disks_roles_and_skips_loop(self):
        out = json.loads(self.handle("disks", [], **self.kw))
        names = [d["name"] for d in out]
        self.assertNotIn("loop0", names)
        by = {d["name"]: d for d in out}
        self.assertEqual(by["nvme0n1"]["role"], "system")
        self.assertTrue(by["nvme0n1"]["mounted"])
        self.assertIn("/", by["nvme0n1"]["mounts"])
        self.assertEqual(by["sdc"]["role"], "data")
        self.assertFalse(by["sdc"]["mounted"])
        self.assertEqual(by["sdc"]["path"], "/dev/sdc")
        self.assertTrue(by["sdc"]["id"])
        self.assertEqual(by["sdc"]["model"], "WDC")
        self.assertEqual(by["sdc"]["kind"], "hdd")
        self.assertIn("mounted", by["sdc"])
        self.assertIn("health", by["sdc"])

    def test_pool_create_blank_only_writes_fstab(self):
        with self.assertRaisesRegex(Exception, "Pool names"):
            self.handle("pool-create", ["Bad Name", "single", "/dev/sda"], **self.kw)
        with self.assertRaisesRegex(Exception, "holds the system"):
            self.handle("pool-create", ["tank", "single", "/dev/nvme0n1"], **self.kw)
        with self.assertRaisesRegex(Exception, "isn’t blank"):
            self.handle("pool-create", ["tank", "single", "/dev/sdc"], **self.kw)
        self.assertFalse(any(x[0] == "mkfs.btrfs" for x in self.fake.log))
        out = json.loads(self.handle("pool-create", ["tank", "raid1", "/dev/sda", "/dev/sdb"], **self.kw))
        self.assertEqual(out["mountpoint"], "/home/chris/Pools/tank")
        self.assertTrue(any(x[0] == "mkfs.btrfs" and "raid1" in x and "/dev/sda" in x for x in self.fake.log))
        self.assertIn("# omarchy-connector pool tank", self.fake.files["/etc/fstab"])
        self.assertIn("/home/chris/Pools/tank", self.fake.files["/etc/fstab"])
        self.assertTrue(any(x[0] == "mount" and "/home/chris/Pools/tank" in x for x in self.fake.log))

    def test_sleep_hdd_writes_udev_and_refuses_system(self):
        with self.assertRaisesRegex(Exception, "holds the system"):
            self.handle("sleep", ["/dev/nvme0n1", "20"], **self.kw)
        with self.assertRaisesRegex(Exception, "Only spinning"):
            self.handle("sleep", ["/dev/sdd", "20"], **self.kw)
        with self.assertRaisesRegex(Exception, "0, 10, 20"):
            self.handle("sleep", ["/dev/sda", "15"], **self.kw)
        self.assertEqual(self.handle("sleep", ["/dev/sda", "20"], **self.kw), "ok")
        self.assertIn(["hdparm", "-S", "240", "/dev/sda"], self.fake.log)
        udev = self.fake.files["/etc/udev/rules.d/69-omarchy-connector-sleep.rules"]
        self.assertIn('ENV{ID_SERIAL_SHORT}=="WD-A"', udev)
        self.assertIn("hdparm -S 240", udev)
        disks = json.loads(self.handle("disks", [], **self.kw))
        by = {d["name"]: d for d in disks}
        self.assertEqual(by["sda"]["sleepMinutes"], 20)

    def test_zfs_available_is_no_when_zpool_missing(self):
        self.assertEqual(self.handle("zfs-available", [], **self.kw), "no")

    def test_pools_and_importable_match_host_shape(self):
        self.handle("pool-create", ["tank", "raid1", "/dev/sda", "/dev/sdb"], **self.kw)
        pools = json.loads(self.handle("pools", [], **self.kw))
        self.assertEqual(len(pools), 1)
        p = pools[0]
        self.assertEqual(p["kind"], "btrfs")
        self.assertEqual(p["name"], "tank")
        self.assertEqual(p["uuid"], "33333333-3333-3333-3333-333333333333")
        self.assertEqual(p["mountpoint"], "/home/chris/Pools/tank")
        self.assertEqual(p["folder"], "/Home/Pools/tank")
        found = json.loads(self.handle("importable", [], **self.kw))
        self.assertTrue(any(i["kind"] == "btrfs" and i["uuid"] == "44444444-4444-4444-4444-444444444444" for i in found))

    def test_pool_add_forget_and_scrub(self):
        self.handle("pool-create", ["tank", "single", "/dev/sda"], **self.kw)
        self.assertEqual(self.handle("pool-add", ["tank", "/dev/sdb"], **self.kw), "ok")
        self.assertTrue(any(x[:3] == ["btrfs", "device", "add"] and "/dev/sdb" in x for x in self.fake.log))
        self.assertEqual(self.handle("pool-scrub", ["tank"], **self.kw), "ok")
        self.assertTrue(any(x[:3] == ["btrfs", "scrub", "start"] for x in self.fake.log))
        self.assertEqual(self.handle("pool-forget", ["tank"], **self.kw), "ok")
        self.assertNotIn("# omarchy-connector pool tank", self.fake.files["/etc/fstab"])


if __name__ == "__main__":
    unittest.main()

