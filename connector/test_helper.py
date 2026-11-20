import copy
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
    def __init__(self, lsblk=None):
        self.log = []
        self.files = {"/etc/fstab": "UUID=1111 / btrfs defaults 0 0\n"}
        self.lsblk = lsblk if lsblk is not None else LSBLK

    def run(self, cmd, args):
        self.log.append([cmd, *args])
        if cmd == "lsblk":
            return json.dumps(self.lsblk)
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


def zfs_member_lsblk():
    tree = copy.deepcopy(LSBLK)
    sdb = next(d for d in tree["blockdevices"] if d["path"] == "/dev/sdb")
    sdb["children"] = [{
        "name": "sdb1",
        "path": "/dev/sdb1",
        "type": "part",
        "fstype": "zfs_member",
        "label": "tank",
        "mountpoints": [None],
    }]
    return tree


def run_with_zpool_list(fake, text):
    def run(cmd, args):
        if cmd == "zpool" and list(args)[:4] == ["list", "-H", "-o", "name"]:
            fake.log.append([cmd, *list(args)])
            return text
        return fake.run(cmd, args)

    return run


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

    def test_format_refuses_disks_in_use_by_encryption_lvm_or_raid(self):
        from helper import HelperError
        busy = copy.deepcopy(LSBLK)
        busy["blockdevices"].append({"name": "sdf", "path": "/dev/sdf", "type": "disk", "size": 4000000000000, "children": [
            {"name": "sdf1", "path": "/dev/sdf1", "type": "part", "fstype": "crypto_LUKS", "mountpoints": [None], "children": [
                {"name": "luks-x", "path": "/dev/mapper/luks-x", "type": "crypt", "fstype": "ext4", "mountpoints": [None]}]}]})
        busy["blockdevices"].append({"name": "sdg", "path": "/dev/sdg", "type": "disk", "size": 4000000000000, "fstype": "linux_raid_member", "children": [
            {"name": "md0", "path": "/dev/md0", "type": "raid1", "mountpoints": [None]}]})
        fake = Fake(busy)
        kw = dict(self.kw, run=fake.run, files=fake.files)
        for dev in ("/dev/sdf", "/dev/sdg"):
            with self.assertRaisesRegex(HelperError, "encryption, LVM or RAID"):
                self.handle("format", [dev, "blank"], **kw)
        self.assertFalse(any(c[0] == "wipefs" and "-a" in c for c in fake.log))

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

    def test_mount_refuses_system_pool_blank_mounted_and_junk(self):
        with self.assertRaisesRegex(Exception, "holds the system"):
            self.handle("mount", ["/dev/nvme0n1"], **self.kw)
        self.fake.files["/etc/fstab"] = "UUID=44444444-4444-4444-4444-444444444444 /home/chris/Pools/old btrfs d 0 0 # omarchy-connector pool old\n"
        with self.assertRaisesRegex(Exception, "is in a pool"):
            self.handle("mount", ["/dev/sde"], **self.kw)
        with self.assertRaisesRegex(Exception, "Nothing to mount"):
            self.handle("mount", ["/dev/sdb"], **self.kw)
        with self.assertRaisesRegex(Exception, "Not a drive"):
            self.handle("mount", ["/etc/passwd"], **self.kw)
        mounted = copy.deepcopy(LSBLK)
        mounted["blockdevices"][3]["children"][0]["mountpoints"] = ["/run/media/chris/WINDOWS"]
        fake = Fake(mounted)
        kw = dict(run=fake.run, user=self.kw["user"], files=fake.files)
        with self.assertRaisesRegex(Exception, "already mounted"):
            self.handle("mount", ["/dev/sdc"], **kw)
        self.assertFalse(any(x[0] == "mount" for x in fake.log))

    def test_mount_ntfs_and_btrfs_at_run_media(self):
        self.assertEqual(self.handle("mount", ["/dev/sdc"], **self.kw), "ok")
        self.assertIn(["mount", "-o", "nosuid,nodev,uid=1000,gid=1000", "/dev/sdc1", "/run/media/chris/sdc1"], self.fake.log)
        self.fake.log.clear()
        self.assertEqual(self.handle("mount", ["/dev/sde"], **self.kw), "ok")
        self.assertIn(["mount", "-o", "nosuid,nodev", "/dev/sde1", "/run/media/chris/old"], self.fake.log)

    def test_mount_fat_chown_after_mount_is_skipped(self):
        mounted = set()
        chowns = []

        def run(cmd, args):
            if cmd == "mount":
                mounted.add(args[-1])
            return self.fake.run(cmd, args)

        def chown(path, uid, gid):
            if path in mounted:
                raise OSError(1, "Operation not permitted")
            chowns.append((path, uid, gid))

        kw = dict(self.kw, run=run, chown=chown)
        self.assertEqual(self.handle("mount", ["/dev/sdc"], **kw), "ok")
        self.assertIn(("/run/media/chris/sdc1", 1000, 1000), chowns)
        self.assertIn(("/run/media/chris", 1000, 1000), chowns)


    def test_mount_skips_luks_and_swap(self):
        lsblk = copy.deepcopy(LSBLK)
        lsblk["blockdevices"].append({
            "name": "sdf", "path": "/dev/sdf", "type": "disk", "size": 1000000000, "children": [
                {"name": "sdf1", "path": "/dev/sdf1", "type": "part", "fstype": "crypto_LUKS", "mountpoints": [None]},
                {"name": "sdf2", "path": "/dev/sdf2", "type": "part", "fstype": "swap", "mountpoints": [None]},
                {"name": "sdf3", "path": "/dev/sdf3", "type": "part", "fstype": "LVM2_member", "mountpoints": [None]},
            ]
        })
        fake = Fake(lsblk)
        kw = dict(run=fake.run, user=self.kw["user"], files=fake.files)
        with self.assertRaisesRegex(Exception, "Nothing to mount"):
            self.handle("mount", ["/dev/sdf"], **kw)
        self.assertFalse(any(x[0] == "mount" for x in fake.log))

    def test_mount_sanitizes_label(self):
        lsblk = copy.deepcopy(LSBLK)
        lsblk["blockdevices"].append({
            "name": "sdg", "path": "/dev/sdg", "type": "disk", "size": 1000000000, "fstype": "ext4",
            "uuid": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "label": "My Disk / 2", "mountpoints": [None], "children": [],
        })
        fake = Fake(lsblk)
        kw = dict(run=fake.run, user=self.kw["user"], files=fake.files)
        self.assertEqual(self.handle("mount", ["/dev/sdg"], **kw), "ok")
        self.assertIn(["mount", "-o", "nosuid,nodev", "/dev/sdg", "/run/media/chris/My_Disk_2"], fake.log)

    def test_pool_add_forget_and_scrub(self):
        self.handle("pool-create", ["tank", "single", "/dev/sda"], **self.kw)
        self.assertEqual(self.handle("pool-add", ["tank", "/dev/sdb"], **self.kw), "ok")
        self.assertTrue(any(x[:3] == ["btrfs", "device", "add"] and "/dev/sdb" in x for x in self.fake.log))
        self.assertEqual(self.handle("pool-scrub", ["tank"], **self.kw), "ok")
        self.assertTrue(any(x[:3] == ["btrfs", "scrub", "start"] for x in self.fake.log))
        self.assertEqual(self.handle("pool-forget", ["tank"], **self.kw), "ok")
        self.assertNotIn("# omarchy-connector pool tank", self.fake.files["/etc/fstab"])

    def test_format_and_umount_refuse_imported_zfs_pool(self):
        fake = Fake(zfs_member_lsblk())
        kw = dict(run=run_with_zpool_list(fake, "tank\n"), user=self.kw["user"], files=fake.files)
        with self.assertRaisesRegex(Exception, r"/dev/sdb is in a pool"):
            self.handle("format", ["/dev/sdb", "blank"], **kw)
        with self.assertRaisesRegex(Exception, r"/dev/sdb is in a pool"):
            self.handle("umount", ["/dev/sdb"], **kw)
        self.assertFalse(any(c[0] == "wipefs" and "-a" in c for c in fake.log))

    def test_format_allows_zfs_member_when_pool_not_imported(self):
        tree = zfs_member_lsblk()
        missing = Fake(tree)
        kw = dict(run=missing.run, user=self.kw["user"], files=missing.files)
        self.assertEqual(self.handle("format", ["/dev/sdb", "blank"], **kw), "ok")
        self.assertIn(["wipefs", "-a", "/dev/sdb"], missing.log)
        empty = Fake(tree)
        kw = dict(run=run_with_zpool_list(empty, ""), user=self.kw["user"], files=empty.files)
        self.assertEqual(self.handle("format", ["/dev/sdb", "blank"], **kw), "ok")
        self.assertIn(["wipefs", "-a", "/dev/sdb"], empty.log)


if __name__ == "__main__":
    unittest.main()

