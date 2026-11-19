#!/usr/bin/env python3
"""Root helper for the Omarchy Server connector's Storage ability.

Installed at /usr/local/libexec/omarchy-connector/helper.py. A sudoers rule lets the person who
installed the connector run it (and nothing else) without a password. Every argument is treated as
hostile. Verbs:

  ping           is the helper installed and allowed?
  smart DEV      drive health (smartctl JSON)
  umount DEV     unmount every mountpoint on a non-system, non-pool whole disk
  mount DEV      mount each filesystem on a non-system, non-pool extra disk at /run/media/$USER
  format DEV FS  wipe a non-system, non-pool, unmounted whole disk (FS is blank, ext4 or exfat)
  sleep DEV MIN  spin-down time for a hard drive (0 = never)
  pool-*         Btrfs pools at ~/Pools/NAME (create, add, import, forget, scrub, status)
  zfs-available  is ZFS installed?
"""
import json
import os
import pwd
import re
import shutil
import subprocess
import sys

DEV = re.compile(r"^/dev/(sd[a-z]{1,2}|vd[a-z]{1,2}|nvme\d{1,2}n\d{1,2}|hd[a-z])$")
BY_ID = re.compile(r"^/dev/disk/by-id/[A-Za-z0-9._:+-]+$")
NAME = re.compile(r"^[a-z][a-z0-9-]{0,31}$")
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
SYSTEM_MOUNTS = frozenset(["/", "/boot", "/efi", "/boot/efi", "/home", "/var", "/usr", "[SWAP]"])
SKIP_FS = frozenset(["crypto_LUKS", "swap", "LVM2_member", "linux_raid_member", "zfs_member"])
FAT_FS = frozenset(["vfat", "exfat", "ntfs", "msdos", "fuseblk"])


def safe_mount_name(s):
    n = re.sub(r"[^A-Za-z0-9._-]+", "_", str(s or "")).strip("._-")
    if not n or n in (".", ".."):
        return ""
    return n[:64]


PROTECTED = ["/", "/boot", "/efi", "/etc", "/usr", "/var", "/home", "/root", "/opt", "/srv", "/bin", "/sbin", "/lib", "/lib64", "/dev", "/proc", "/sys", "/run", "/tmp"]
FSTAB_MARK = "# omarchy-connector pool"
ZFS_MARK = "# omarchy-connector zfs"
POOL_OPTIONS = "defaults,noatime,nosuid,nodev,compress=zstd:3,nofail,x-systemd.device-timeout=10s"
UDEV_SLEEP = "/etc/udev/rules.d/69-omarchy-connector-sleep.rules"
SLEEP_MINUTES = {0: 0, 10: 120, 20: 240, 30: 241, 60: 242, 120: 244, 240: 248}


class HelperError(Exception):
    pass


def fail(message):
    raise HelperError(message)


def default_run(cmd, args):
    env = dict(os.environ)
    env["PATH"] = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin"
    env["LC_ALL"] = "C"
    r = subprocess.run([cmd, *args], capture_output=True, text=True, timeout=600, env=env)
    if r.returncode and not (cmd == "smartctl" and r.stdout):
        msg = (r.stderr or r.stdout or ("%s failed" % cmd)).strip().split("\n")[-1][:300]
        raise HelperError("%s: %s" % (cmd, msg) if msg else "%s failed" % cmd)
    return r.stdout


def handle(verb, args, run=None, user=None, realpath=None, fstab_text=None, files=None, chown=None):
    run = run or default_run
    realpath = realpath or os.path.realpath
    if not user or not user.get("name") or not isinstance(user.get("uid"), int) or user.get("uid") == 0 or not str(user.get("home") or "").startswith("/"):
        fail("Run this through sudo as the person who installed the connector")
    if not re.match(r"^[a-z_][a-z0-9_-]{0,31}$", user["name"]):
        fail("Run this through sudo as the person who installed the connector")
    uid = user["uid"]
    gid = user.get("gid", uid)
    pools_dir = os.path.join(user["home"], "Pools")

    def mount_of(name):
        return os.path.join(pools_dir, name)

    def read_text(path):
        if files is not None:
            if path not in files:
                raise OSError("ENOENT")
            return files[path]
        if fstab_text is not None and path == "/etc/fstab":
            return str(fstab_text)
        with open(path, encoding="utf-8") as f:
            return f.read()

    def write_text(path, text):
        if files is not None:
            files[path] = text
            return
        tmp = path + ".omarchy-connector.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path)

    def block_devices():
        j = json.loads(run("lsblk", ["-J", "-b", "-o", "NAME,PATH,TYPE,SIZE,ROTA,TRAN,MODEL,SERIAL,FSTYPE,LABEL,UUID,MOUNTPOINTS,RM,HOTPLUG"]))
        return j.get("blockdevices") or []

    def flat(d):
        out = [d]
        for c in d.get("children") or []:
            out.extend(flat(c))
        return out

    def mounts(d):
        return [m for x in flat(d) for m in (x.get("mountpoints") or []) if m]

    def disk(path):
        if not DEV.match(path or ""):
            fail("Not a drive: %s" % path)
        for d in block_devices():
            if d.get("path") == path and d.get("type") == "disk":
                return d
        fail("No drive at %s" % path)

    def resolve_disk(path):
        p = "" if path is None else str(path)
        if BY_ID.match(p) and not re.search(r"-part\d+$", p):
            try:
                p = realpath(p)
            except OSError:
                fail("No drive at %s" % path)
        return disk(p)

    def fstab():
        try:
            return read_text("/etc/fstab").splitlines()
        except OSError:
            return []

    def mkdir_p(path):
        if files is not None:
            return
        os.makedirs(path, exist_ok=True)

    def chown_path(path):
        if chown is not None:
            chown(path, uid, gid)
            return
        if files is not None:
            return
        os.chown(path, uid, gid)

    def blank_disk(path):
        d = disk(path)
        if any(m in SYSTEM_MOUNTS for m in mounts(d)):
            fail("%s holds the system" % path)
        if mounts(d):
            fail("%s is in use" % path)
        if (d.get("children") or []) or d.get("fstype"):
            fail("%s isn’t blank. Format this drive first (choose blank)." % path)
        try:
            sig = (run("wipefs", ["--no-act", "--json", path]) or "").strip()
        except Exception:
            sig = ""
        if sig and (json.loads(sig).get("signatures") or []):
            fail("%s isn’t blank. Format this drive first (choose blank)." % path)
        return d

    def add_fstab(name, uuid):
        lines = [l for l in fstab() if not l.endswith("%s %s" % (FSTAB_MARK, name))]
        while lines and lines[-1] == "":
            lines.pop()
        lines.append("UUID=%s %s btrfs %s 0 0 %s %s" % (uuid, mount_of(name), POOL_OPTIONS, FSTAB_MARK, name))
        lines.append("")
        write_text("/etc/fstab", "\n".join(lines))

    def pool_mount(name):
        if not NAME.match(name or ""):
            fail("Pool names use a-z, 0-9 and -")
        if not any(l.endswith("%s %s" % (FSTAB_MARK, name)) for l in fstab()):
            fail("No pool called %s" % name)
        return mount_of(name)

    def mount_pool(name, uuid):
        mkdir_p(mount_of(name))
        mkdir_p(pools_dir)
        chown_path(pools_dir)
        add_fstab(name, uuid)
        try:
            run("systemctl", ["daemon-reload"])
        except Exception:
            pass
        run("mount", [mount_of(name)])
        chown_path(mount_of(name))

    def pool_member(d):
        if any("/Pools/" in m for m in mounts(d)):
            return True
        uuids = {x.get("uuid") for x in flat(d) if x.get("uuid")}
        return any(FSTAB_MARK in l and any(u in l for u in uuids) for l in fstab())

    def fstab_pools():
        out = []
        for l in fstab():
            if FSTAB_MARK not in l:
                continue
            uuid_m = re.match(r"^UUID=(\S+)", l.strip())
            parts = l.split()
            name = l[l.index(FSTAB_MARK) + len(FSTAB_MARK) :].strip()
            if uuid_m and len(parts) >= 2 and NAME.match(name):
                out.append({"uuid": uuid_m.group(1), "mountpoint": parts[1], "name": name})
        return out

    def sleep_map():
        rev = {v: k for k, v in SLEEP_MINUTES.items()}
        out = {}
        try:
            text = read_text(UDEV_SLEEP)
        except OSError:
            return out
        for line in text.splitlines():
            sm = re.search(r'ENV\{ID_SERIAL_SHORT\}=="([^"]+)"', line)
            hm = re.search(r"hdparm -S (\d+)", line)
            if sm and hm:
                minutes = rev.get(int(hm.group(1)))
                if minutes is not None:
                    out[sm.group(1)] = minutes
        return out

    def pool_status_data(name):
        mnt = pool_mount(name)
        df = run("btrfs", ["filesystem", "df", "-b", mnt])
        pm = re.search(r"^Data,\s*(\w+)", df, re.M)
        profile = pm.group(1).lower() if pm else "unknown"
        stats = run("btrfs", ["device", "stats", mnt])
        devices = {}
        for m in re.finditer(r"^\[(/dev/[^\]]+)\]\.(\w+)\s+(\d+)", stats, re.M):
            devices.setdefault(m.group(1), {})[m.group(2)] = int(m.group(3))
        try:
            scrub = run("btrfs", ["scrub", "status", mnt])
        except Exception:
            scrub = ""
        sm = re.search(r"Status:\s*(\w+)", scrub)
        if sm:
            scrub_state = sm.group(1)
        elif "no stats available" in scrub:
            scrub_state = "never"
        else:
            scrub_state = "unknown"
        em = re.search(r"Error summary:\s*(.*)", scrub)
        scrub_errors = em.group(1).strip() if em else ""
        if scrub_errors == "no errors found":
            scrub_errors = ""
        started_m = re.search(r"Scrub started:\s*(.*)", scrub)
        started = started_m.group(1).strip() if started_m else None
        return {"profile": profile, "devices": devices, "scrub": {"state": scrub_state, "errors": scrub_errors, "started": started}}

    def zfs_available():
        try:
            run("zpool", ["version"])
            return True
        except Exception:
            return False

    def zfs_pool_names():
        try:
            return [l.strip() for l in run("zpool", ["list", "-H", "-o", "name"]).split("\n") if l.strip()]
        except Exception:
            return []

    def by_id(dev):
        directory = "/dev/disk/by-id"
        try:
            names = os.listdir(directory)
            target = realpath(dev)
        except OSError:
            return dev
        matches = []
        for n in names:
            if re.search(r"-part\d+$", n):
                continue
            try:
                if realpath(os.path.join(directory, n)) == target:
                    matches.append(n)
            except OSError:
                continue
        best = next((n for n in matches if re.match(r"^(nvme|ata|scsi|usb)-", n)), None)
        if not best:
            best = next((n for n in matches if not n.startswith("wwn-")), None)
        if not best and matches:
            best = matches[0]
        return os.path.join(directory, best) if best else dev

    def parse_status(text):
        state_m = re.search(r"^\s*state:\s*(\S+)", text, re.M)
        scan_m = re.search(r"^\s*scan:\s*(.+(?:\n\t.+)*)", text, re.M)
        errors_m = re.search(r"^errors:\s*(.+)$", text, re.M)
        cfg = ""
        parts = re.split(r"^\s*config:\s*$", text, flags=re.M)
        if len(parts) > 1:
            cfg = re.split(r"^errors:", parts[1], flags=re.M)[0]
        layout = set()
        devices = []
        for line in cfg.split("\n"):
            m = re.match(r"^\s+(\S+)\s+(ONLINE|DEGRADED|FAULTED|OFFLINE|UNAVAIL|REMOVED)\s+(\d+\S*)\s+(\d+\S*)\s+(\d+\S*)", line)
            if not m:
                continue
            if re.match(r"^(mirror|raidz[123]?|draid)", m.group(1)):
                layout.add(re.sub(r"-\d+$", "", m.group(1)))
            elif m.group(1).startswith("/"):
                devices.append({
                    "path": m.group(1),
                    "state": m.group(2),
                    "errors": sum(int(re.match(r"\d+", x).group(0)) if re.match(r"\d+", x) else 0 for x in (m.group(3), m.group(4), m.group(5))),
                })
        return {
            "state": state_m.group(1) if state_m else "UNKNOWN",
            "scan": re.sub(r"\s+", " ", scan_m.group(1)).strip() if scan_m else "",
            "errors": errors_m.group(1).strip() if errors_m else "",
            "layout": "+".join(sorted(layout)) if layout else "stripe",
            "devices": devices,
        }

    def zfs_pool_mount(name):
        if not re.match(r"^[a-z][a-z0-9_.-]{0,31}$", name or "", re.I):
            fail("Bad pool name")
        if name not in zfs_pool_names():
            fail("No ZFS pool called %s" % name)
        return name

    def ensure_zfs_services():
        for unit in ("zfs-import-cache.service", "zfs-mount.service", "zfs-import.target", "zfs.target"):
            try:
                run("systemctl", ["enable", unit])
            except Exception:
                pass

    def zfs_pools_data():
        out = []
        tab = fstab()
        try:
            listing = run("zpool", ["list", "-H", "-p", "-o", "name,size,alloc,free,health"])
        except Exception:
            listing = ""
        for line in listing.split("\n"):
            parts = line.split("\t")
            if len(parts) < 5 or not parts[0]:
                continue
            name, size, alloc, free, health = parts[:5]
            try:
                st = parse_status(run("zpool", ["status", "-P", name]))
            except Exception:
                st = parse_status("")
            try:
                mountpoint = run("zfs", ["get", "-H", "-o", "value", "mountpoint", name]).strip()
            except Exception:
                mountpoint = ""
            bind = next((l for l in tab if l.endswith("%s %s" % (ZFS_MARK, name))), None)
            if bind:
                folder = bind.split()[1]
            elif mountpoint.startswith(pools_dir + "/"):
                folder = mountpoint
            else:
                folder = None
            out.append({"name": name, "size": int(size), "used": int(alloc), "free": int(free), "health": health, "mountpoint": mountpoint, "folder": folder, **st})
        return out

    def zfs_importable_data():
        try:
            text = run("zpool", ["import"])
        except Exception as e:
            if re.search(r"no pools available", str(e), re.I):
                text = ""
            else:
                raise
        pools = []
        for block in re.split(r"^\s*pool:\s*", text, flags=re.M)[1:]:
            name = block.split("\n")[0].strip()
            id_m = re.search(r"^\s*id:\s*(\d+)", block, re.M)
            state_m = re.search(r"^\s*state:\s*(\S+)", block, re.M)
            status_m = re.search(r"^\s*status:\s*(.+(?:\n\s{2,}.+)*)", block, re.M)
            pools.append({
                "name": name,
                "id": id_m.group(1) if id_m else None,
                "state": state_m.group(1) if state_m else "UNKNOWN",
                "otherSystem": bool(re.search(r"another system|was last accessed by|-f flag", block, re.I)),
                "note": re.sub(r"\s+", " ", status_m.group(1)).strip() if status_m else "",
            })
        return pools

    if verb == "ping":
        return "ok"
    if verb == "smart":
        d = resolve_disk(args[0] if args else "")
        return run("smartctl", ["-j", "-a", d["path"]])
    if verb == "umount":
        d = resolve_disk(args[0] if args else "")
        if any(m in SYSTEM_MOUNTS for m in mounts(d)):
            fail("%s holds the system" % d["path"])
        if pool_member(d):
            fail("%s is in a pool" % d["path"])
        for m in mounts(d):
            run("umount", [m])
        return "ok"
    if verb == "mount":
        d = resolve_disk(args[0] if args else "")
        if any(m in SYSTEM_MOUNTS for m in mounts(d)):
            fail("%s holds the system" % d["path"])
        if pool_member(d):
            fail("%s is in a pool" % d["path"])
        if mounts(d):
            fail("%s is already mounted" % d["path"])
        nodes = [x for x in flat(d) if x is not d] if d.get("children") else [d]
        targets = [x for x in nodes if x.get("fstype") and x["fstype"] not in SKIP_FS]
        if not targets:
            fail("Nothing to mount")
        used = set()
        for t in targets:
            name = safe_mount_name(t.get("label")) or safe_mount_name(t.get("uuid")) or safe_mount_name(t.get("name")) or "disk"
            base = name
            n = 2
            while name in used:
                name = "%s-%s" % (base, n)
                n += 1
            used.add(name)
            parent = os.path.join("/run/media", user["name"])
            dest = os.path.join(parent, name)
            mkdir_p(dest)
            try:
                chown_path(parent)
            except OSError:
                pass
            chown_path(dest)
            flags = ["nosuid", "nodev"]
            if t.get("fstype") in FAT_FS:
                flags.extend(["uid=%s" % uid, "gid=%s" % gid])
            run("mount", ["-o", ",".join(flags), t["path"], dest])
            if t.get("fstype") not in FAT_FS:
                chown_path(dest)
        return "ok"
    if verb == "format":
        fs_kind = args[1] if len(args) > 1 else ""
        if fs_kind not in ("blank", "ext4", "exfat"):
            fail("Choose blank, ext4 or exfat")
        d = resolve_disk(args[0] if args else "")
        if any(m in SYSTEM_MOUNTS for m in mounts(d)):
            fail("%s holds the system" % d["path"])
        if pool_member(d):
            fail("%s is in a pool" % d["path"])
        if mounts(d):
            fail("%s is in use. Unmount it first." % d["path"])
        run("wipefs", ["-a", d["path"]])
        if fs_kind == "ext4":
            run("mkfs.ext4", ["-F", d["path"]])
        if fs_kind == "exfat":
            run("mkfs.exfat", [d["path"]])
        return "ok"
    if verb == "disks":
        skip = re.compile(r"^(zram|loop|sr|ram)")

        def disk_id(path):
            try:
                names = os.listdir("/dev/disk/by-id")
            except OSError:
                return path
            for name in names:
                if re.search(r"-part\d+$", name):
                    continue
                full = "/dev/disk/by-id/" + name
                try:
                    if realpath(full) == path:
                        return full
                except OSError:
                    continue
            return path

        def health(path):
            try:
                j = json.loads(run("smartctl", ["-j", "-a", path]))
                attrs = {a.get("id"): (a.get("raw") or {}).get("value") for a in ((j.get("ata_smart_attributes") or {}).get("table") or [])}
                nvme_log = j.get("nvme_smart_health_information_log") or {}
                return {
                    "passed": (j.get("smart_status") or {}).get("passed"),
                    "temperature": (j.get("temperature") or {}).get("current") if j.get("temperature") else nvme_log.get("temperature"),
                    "powerOnHours": (j.get("power_on_time") or {}).get("hours") if j.get("power_on_time") else nvme_log.get("power_on_hours"),
                    "lifetimeUsed": nvme_log.get("percentage_used"),
                    "reallocated": attrs.get(5),
                    "pending": attrs.get(197),
                }
            except Exception:
                return None

        def pool_name(d):
            for m in mounts(d):
                if "/Pools/" in m:
                    return m.rsplit("/Pools/", 1)[-1].split("/")[0] or None
            uuids = {x.get("uuid") for x in flat(d) if x.get("uuid")}
            for l in fstab():
                if FSTAB_MARK in l and any(u in l for u in uuids):
                    return (l[l.index(FSTAB_MARK) + len(FSTAB_MARK) :].strip() or None)
            zmember = next((x for x in flat(d) if x.get("fstype") == "zfs_member"), None)
            if zmember and zmember.get("label"):
                return zmember["label"]
            return None

        sleeps = sleep_map()
        out = []
        for d in block_devices():
            name = d.get("name") or ""
            if d.get("type") != "disk" or skip.match(name) or not int(d.get("size") or 0):
                continue
            allp = flat(d)
            mnt = [m for x in allp for m in (x.get("mountpoints") or []) if m]
            btrfs = next((x for x in allp if x.get("fstype") == "btrfs"), None)
            zmember = next((x for x in allp if x.get("fstype") == "zfs_member"), None)
            pool = pool_name(d)
            system = any(m in SYSTEM_MOUNTS for m in mnt)
            blank = not d.get("fstype") and not (d.get("children") or []) and not mnt
            nvme = d.get("tran") == "nvme" or name.startswith("nvme")
            rota = d.get("rota") in (True, 1, "1")
            role = "system" if system else "pool" if pool else "blank" if blank else "data"
            path = d.get("path")
            out.append({
                "path": path,
                "id": disk_id(path),
                "name": name,
                "model": (d.get("model") or "").strip() or None,
                "serial": d.get("serial"),
                "size": int(d.get("size") or 0),
                "kind": "nvme" if nvme else "hdd" if rota else "ssd",
                "transport": d.get("tran"),
                "removable": d.get("rm") in (True, 1, "1") or d.get("hotplug") in (True, 1, "1"),
                "role": role,
                "pool": pool if role == "pool" else None,
                "mounted": len(mnt) > 0,
                "mounts": mnt,
                "btrfs": {"uuid": btrfs.get("uuid"), "label": btrfs.get("label"), "mounted": any(btrfs.get("mountpoints") or [])} if btrfs and role != "pool" else None,
                "zfs": {"pool": zmember.get("label")} if zmember and role != "pool" else None,
                "sleepMinutes": sleeps.get(d.get("serial")) if d.get("serial") else None,
                "health": health(path),
            })
        return json.dumps(out)
    if verb == "pool-create":
        name = args[0] if args else ""
        profile = args[1] if len(args) > 1 else ""
        devs = list(args[2:])
        if not NAME.match(name or ""):
            fail("Pool names use a-z, 0-9 and -, starting with a letter")
        if profile not in ("single", "raid1", "raid10"):
            fail("Choose single, raid1 or raid10")
        if not devs or len(devs) > 16 or len(set(devs)) != len(devs):
            fail("Choose the drives for the pool")
        if profile == "raid1" and len(devs) < 2:
            fail("Mirroring needs at least 2 drives")
        if profile == "raid10" and len(devs) < 4:
            fail("RAID 10 needs at least 4 drives")
        if any(l.endswith("%s %s" % (FSTAB_MARK, name)) for l in fstab()):
            fail("There’s already a pool called %s" % name)
        for d in devs:
            blank_disk(d)
        meta = "dup" if len(devs) == 1 else ("raid10" if profile == "raid10" else "raid1")
        run("mkfs.btrfs", ["-L", "omarchy-%s" % name, "-d", profile, "-m", meta, *devs])
        try:
            run("udevadm", ["settle"])
        except Exception:
            pass
        uuid = (run("blkid", ["-s", "UUID", "-o", "value", devs[0]]) or "").strip()
        if not UUID.match(uuid):
            fail("The new pool has no UUID")
        mount_pool(name, uuid)
        return json.dumps({"name": name, "uuid": uuid, "mountpoint": mount_of(name)})
    if verb == "pool-add":
        name = args[0] if args else ""
        dev = args[1] if len(args) > 1 else ""
        mnt = pool_mount(name)
        blank_disk(dev)
        run("btrfs", ["device", "add", dev, mnt])
        run("btrfs", ["balance", "start", "--bg", "--full-balance", mnt])
        return "ok"
    if verb == "pool-import":
        name = args[0] if args else ""
        uuid = args[1] if len(args) > 1 else ""
        if not NAME.match(name or ""):
            fail("Pool names use a-z, 0-9 and -, starting with a letter")
        if not UUID.match(uuid or ""):
            fail("Choose a filesystem to import")
        fs0 = [x for d in block_devices() for x in flat(d) if x.get("uuid") == uuid]
        if not fs0 or any(x.get("fstype") != "btrfs" for x in fs0):
            fail("Only Btrfs filesystems can be imported")
        if any(any(m for m in (x.get("mountpoints") or []) if m) for x in fs0):
            fail("That filesystem is already mounted")
        if any(l.endswith("%s %s" % (FSTAB_MARK, name)) or ("UUID=%s " % uuid) in l for l in fstab()):
            fail("That pool or filesystem is already set up")
        mount_pool(name, uuid)
        return "ok"
    if verb == "pool-forget":
        name = args[0] if args else ""
        mnt = pool_mount(name)
        try:
            run("umount", [mnt])
        except Exception as e:
            if "not mounted" not in str(e):
                fail("%s is in use. Stop apps and shares using it, then try again." % name)
        write_text("/etc/fstab", "\n".join(l for l in fstab() if not l.endswith("%s %s" % (FSTAB_MARK, name))))
        try:
            run("systemctl", ["daemon-reload"])
        except Exception:
            pass
        return "ok"
    if verb == "pool-scrub":
        run("btrfs", ["scrub", "start", pool_mount(args[0] if args else "")])
        return "ok"
    if verb == "pool-status":
        return json.dumps(pool_status_data(args[0] if args else ""))
    if verb == "sleep":
        d = disk(args[0] if args else "")
        if any(m in SYSTEM_MOUNTS for m in mounts(d)):
            fail("%s holds the system" % d["path"])
        try:
            m = int(args[1]) if len(args) > 1 else -1
        except (TypeError, ValueError):
            m = -1
        if m not in SLEEP_MINUTES:
            fail("Choose 0, 10, 20, 30, 60, 120 or 240 minutes")
        if d.get("rota") not in (True, 1, "1"):
            fail("Only spinning hard drives sleep")
        serial = d.get("serial") or ""
        if not re.match(r"^[\w.-]{1,64}$", serial):
            fail("This drive doesn’t report a serial number, so its setting can’t be kept")
        run("hdparm", ["-S", str(SLEEP_MINUTES[m]), d["path"]])
        try:
            text = read_text(UDEV_SLEEP)
        except OSError:
            text = ""
        needle = 'ENV{ID_SERIAL_SHORT}=="%s"' % serial
        lines = [l for l in text.split("\n") if l and not l.startswith("#") and needle not in l]
        if m:
            lines.append('ACTION=="add", SUBSYSTEM=="block", ENV{DEVTYPE}=="disk", %s, RUN+="/usr/bin/hdparm -S %s /dev/%%k"' % (needle, SLEEP_MINUTES[m]))
        write_text(UDEV_SLEEP, "# Drive sleep, set by Omarchy Server\n%s\n" % "\n".join(lines) if lines else "")
        return "ok"
    if verb == "zfs-available":
        return "yes" if zfs_available() else "no"
    if verb == "zfs-pools":
        return json.dumps(zfs_pools_data())
    if verb == "zfs-importable":
        return json.dumps(zfs_importable_data())
    if verb == "zfs-create":
        name = args[0] if args else ""
        layout = args[1] if len(args) > 1 else ""
        devs = list(args[2:])
        if not NAME.match(name or ""):
            fail("Pool names use a-z, 0-9 and -, starting with a letter")
        min_n = {"stripe": 1, "mirror": 2, "raidz1": 3, "raidz2": 4}.get(layout)
        if not min_n:
            fail("Choose combined, mirror, raidz1 or raidz2")
        if not devs or len(devs) > 24 or len(set(devs)) != len(devs):
            fail("Choose the drives for the pool")
        if len(devs) < min_n:
            fail("That layout needs at least %s drives" % min_n)
        if name in zfs_pool_names():
            fail("There’s already a ZFS pool called %s" % name)
        if any(l.endswith("%s %s" % (FSTAB_MARK, name)) or l.endswith("%s %s" % (ZFS_MARK, name)) for l in fstab()):
            fail("There’s already a pool called %s" % name)
        for d in devs:
            blank_disk(d)
        ids = [by_id(d) for d in devs]
        mkdir_p(pools_dir)
        chown_path(pools_dir)
        vdev = ids if layout == "stripe" else [layout, *ids]
        run("zpool", ["create", "-o", "ashift=12", "-O", "compression=lz4", "-O", "atime=off", "-O", "xattr=sa", "-O", "acltype=posixacl", "-O", "setuid=off", "-O", "devices=off", "-O", "mountpoint=%s" % mount_of(name), name, *vdev])
        run("zpool", ["set", "cachefile=/etc/zfs/zpool.cache", name])
        ensure_zfs_services()
        chown_path(mount_of(name))
        return json.dumps({"name": name, "mountpoint": mount_of(name)})
    if verb == "zfs-import":
        name = args[0] if args else ""
        force = args[1] if len(args) > 1 else None
        if not re.match(r"^[A-Za-z][A-Za-z0-9_.-]{0,63}$", name or ""):
            fail("Bad pool name")
        if force not in (None, "force"):
            fail("Bad option")
        if name in zfs_pool_names():
            fail("%s is already imported" % name)
        run("zpool", ["import", "-N", *(["-f"] if force else []), name])
        try:
            listing = run("zfs", ["list", "-H", "-o", "name,mountpoint,canmount", "-r", name])
        except Exception:
            listing = ""
        datasets = [l.split("\t") for l in listing.split("\n") if l]
        bad = None
        for row in datasets:
            if len(row) < 3:
                continue
            n, mp, can = row[0], row[1], row[2]
            if can != "off" and mp.startswith("/") and any(mp == p or (p != "/" and mp.startswith(p + "/") and not mp.startswith(pools_dir + "/")) for p in PROTECTED):
                bad = (n, mp)
                break
        if bad:
            try:
                run("zpool", ["export", name])
            except Exception:
                pass
            fail("%s would be mounted at %s, a system folder, so the pool wasn’t imported. Change its mountpoint on the system it came from, or import it by hand." % bad)
        run("zfs", ["set", "setuid=off", name])
        run("zfs", ["set", "devices=off", name])
        run("zfs", ["mount", "-a"])
        run("zpool", ["set", "cachefile=/etc/zfs/zpool.cache", name])
        ensure_zfs_services()
        top = next((row[1] for row in datasets if row and row[0] == name), None)
        pretty = re.sub(r"^[^a-z]+", "p", re.sub(r"[^a-z0-9-]", "-", name.lower()))
        if top and top.startswith("/") and top != mount_of(pretty):
            mkdir_p(mount_of(pretty))
            chown_path(pools_dir)
            lines = [l for l in fstab() if not l.endswith("%s %s" % (ZFS_MARK, name))]
            while lines and lines[-1] == "":
                lines.pop()
            lines.append("%s %s none bind,nosuid,nodev,nofail,x-systemd.requires=zfs-mount.service 0 0 %s %s" % (top, mount_of(pretty), ZFS_MARK, name))
            lines.append("")
            write_text("/etc/fstab", "\n".join(lines))
            try:
                run("systemctl", ["daemon-reload"])
            except Exception:
                pass
            run("mount", [mount_of(pretty)])
        return "ok"
    if verb == "zfs-scrub":
        run("zpool", ["scrub", zfs_pool_mount(args[0] if args else "")])
        return "ok"
    if verb == "zfs-export":
        name = args[0] if args else ""
        zfs_pool_mount(name)
        bind = next((l for l in fstab() if l.endswith("%s %s" % (ZFS_MARK, name))), None)
        if bind:
            try:
                run("umount", [bind.split()[1]])
            except Exception:
                pass
            write_text("/etc/fstab", "\n".join(l for l in fstab() if l != bind))
            try:
                run("systemctl", ["daemon-reload"])
            except Exception:
                pass
        try:
            run("zpool", ["export", name])
        except Exception:
            fail("%s is in use. Stop apps and shares using it, then try again." % name)
        return "ok"
    if verb == "pools":
        devs = [d for d in block_devices() if d.get("type") == "disk"]
        btrfs_out = []
        for p in fstab_pools():
            members = [d.get("path") for d in devs if any(x.get("uuid") == p["uuid"] for x in flat(d))]
            mounted = any(p["mountpoint"] in (x.get("mountpoints") or []) for d in devs for x in flat(d))
            size = free = None
            if mounted and files is None:
                try:
                    s = os.statvfs(p["mountpoint"])
                    size = s.f_blocks * s.f_frsize
                    free = s.f_bavail * s.f_frsize
                except OSError:
                    pass
            detail = None
            if mounted:
                try:
                    detail = pool_status_data(p["name"])
                except Exception:
                    detail = None
            errors = 0
            if detail:
                errors = sum(sum(v.values()) for v in (detail.get("devices") or {}).values())
            btrfs_out.append({
                "kind": "btrfs",
                "name": p["name"],
                "uuid": p["uuid"],
                "mountpoint": p["mountpoint"],
                "folder": "/Home/Pools/%s" % p["name"],
                "mounted": mounted,
                "devices": members,
                "size": size,
                "free": free,
                "profile": (detail or {}).get("profile"),
                "errors": errors,
                "scrub": (detail or {}).get("scrub"),
            })
        zfs_out = []
        if zfs_available():
            def virtual_of(real):
                home = user["home"]
                if real and real.startswith(home + "/"):
                    return "/Home" + real[len(home):]
                return None
            for z in zfs_pools_data():
                scan = z.get("scan") or ""
                z_errors = sum(d.get("errors") or 0 for d in (z.get("devices") or []))
                if z.get("errors") and z.get("errors") != "No known data errors":
                    z_errors += 1
                if re.search(r"in progress", scan):
                    scrub_state = "running"
                elif scan:
                    scrub_state = "finished"
                else:
                    scrub_state = "never"
                if re.search(r" 0B repaired.* 0 errors| with 0 errors", scan) or not scan:
                    scrub_errors = ""
                elif re.search(r"errors", scan):
                    scrub_errors = scan
                else:
                    scrub_errors = ""
                zfs_out.append({
                    "kind": "zfs",
                    "name": z["name"],
                    "uuid": "zfs:%s" % z["name"],
                    "mountpoint": z.get("mountpoint"),
                    "folder": virtual_of(z.get("folder")),
                    "mounted": True,
                    "devices": [d["path"] for d in (z.get("devices") or [])],
                    "size": z.get("size"),
                    "free": z.get("free"),
                    "profile": z.get("layout"),
                    "health": z.get("health"),
                    "errors": z_errors,
                    "scrub": {"state": scrub_state, "errors": scrub_errors, "started": None, "summary": scan},
                })
        return json.dumps(btrfs_out + zfs_out)
    if verb == "importable":
        known = {p["uuid"] for p in fstab_pools()}
        by_uuid = {}
        for d in block_devices():
            for x in flat(d):
                if x.get("fstype") == "btrfs" and x.get("uuid") and x["uuid"] not in known and not any(m for m in (x.get("mountpoints") or []) if m):
                    e = by_uuid.get(x["uuid"]) or {"uuid": x["uuid"], "label": x.get("label"), "devices": []}
                    e["devices"].append(x.get("path"))
                    by_uuid[x["uuid"]] = e
        out = [{"kind": "btrfs", **b} for b in by_uuid.values()]
        if zfs_available():
            for z in zfs_importable_data():
                out.append({"kind": "zfs", "uuid": "zfs:%s" % z["name"], "label": z["name"], "devices": [], "state": z.get("state"), "otherSystem": z.get("otherSystem"), "note": z.get("note")})
        return json.dumps(out)
    fail("Unknown action: %s" % verb)


def main():
    verb = sys.argv[1] if len(sys.argv) > 1 else ""
    args = sys.argv[2:]
    try:
        if os.geteuid() != 0:
            fail("Run this through sudo as the person who installed the connector")
        name = os.environ.get("SUDO_USER") or ""
        try:
            uid = int(os.environ.get("SUDO_UID") or "0")
        except ValueError:
            uid = 0
        if not name or not uid:
            fail("Run this through sudo as the person who installed the connector")
        try:
            pw = pwd.getpwnam(name)
        except KeyError:
            fail("Unknown user")
        if pw.pw_uid != uid:
            fail("Unknown user")
        sys.stdout.write("%s\n" % handle(verb, args, user={"name": name, "uid": uid, "gid": pw.pw_gid, "home": pw.pw_dir}))
    except HelperError as e:
        sys.stderr.write("%s\n" % e)
        sys.exit(2)
    except Exception:
        sys.stderr.write("The helper failed\n")
        sys.exit(1)


if __name__ == "__main__":
    main()
