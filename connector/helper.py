#!/usr/bin/env python3
"""Root helper for the Omarchy Server connector's Storage ability.

Installed at /usr/local/libexec/omarchy-connector/helper.py. A sudoers rule lets the person who
installed the connector run it (and nothing else) without a password. Every argument is treated as
hostile. Verbs:

  ping           is the helper installed and allowed?
  smart DEV      drive health (smartctl JSON)
  umount DEV     unmount every mountpoint on a non-system, non-pool whole disk
  format DEV FS  wipe a non-system, non-pool, unmounted whole disk (FS is blank, ext4 or exfat)
"""
import json
import os
import pwd
import re
import subprocess
import sys

DEV = re.compile(r"^/dev/(sd[a-z]{1,2}|vd[a-z]{1,2}|nvme\d{1,2}n\d{1,2}|hd[a-z])$")
BY_ID = re.compile(r"^/dev/disk/by-id/[A-Za-z0-9._:+-]+$")
SYSTEM_MOUNTS = frozenset(["/", "/boot", "/efi", "/boot/efi", "/home", "/var", "/usr", "[SWAP]"])
FSTAB_MARK = "# omarchy-connector pool"


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


def handle(verb, args, run=None, user=None, realpath=None, fstab_text=None):
    run = run or default_run
    realpath = realpath or os.path.realpath
    if not user or not user.get("name") or not isinstance(user.get("uid"), int) or user.get("uid") == 0 or not str(user.get("home") or "").startswith("/"):
        fail("Run this through sudo as the person who installed the connector")
    if not re.match(r"^[a-z_][a-z0-9_-]{0,31}$", user["name"]):
        fail("Run this through sudo as the person who installed the connector")

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
        if fstab_text is not None:
            return str(fstab_text).splitlines()
        try:
            with open("/etc/fstab", encoding="utf-8") as f:
                return f.read().splitlines()
        except OSError:
            return []

    def pool_member(d):
        if any("/Pools/" in m for m in mounts(d)):
            return True
        uuids = {x.get("uuid") for x in flat(d) if x.get("uuid")}
        return any(FSTAB_MARK in l and any(u in l for u in uuids) for l in fstab())

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
                "sleepMinutes": None,
                "health": health(path),
            })
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
        sys.stdout.write("%s\n" % handle(verb, args, user={"name": name, "uid": uid, "home": pw.pw_dir}))
    except HelperError as e:
        sys.stderr.write("%s\n" % e)
        sys.exit(2)
    except Exception:
        sys.stderr.write("The helper failed\n")
        sys.exit(1)


if __name__ == "__main__":
    main()
