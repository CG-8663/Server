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
