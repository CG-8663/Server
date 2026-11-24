#!/usr/bin/env python3
"""Session libvirt helper. Runs as the connector user: no sudo, no shell."""
import json
import os
import re
import shutil
import subprocess
import sys

VERBS = frozenset([
    "status", "fetch", "disk-create", "seed", "define", "start", "shutdown",
    "reboot", "destroy", "suspend", "resume", "undefine", "state", "vnc-path",
    "inspect", "stats", "ga-ping", "ga-exec", "ga-status",
])
IMAGE_ID = re.compile(r"^[a-z0-9][a-z0-9.-]{1,63}$")
GUEST_ID = re.compile(r"^[a-f0-9]{8}$")
ROOT_MESSAGE = "Run this as the person who installed the connector, not root"


class HelperError(Exception):
    def __init__(self, message):
        super().__init__(message)
        self.message = message


def default_data_dir():
    base = os.environ.get("XDG_DATA_HOME") or os.path.join(os.path.expanduser("~"), ".local", "share")
    return os.path.join(base, "omarchy-connector")


def default_run(cmd, args, input=None):
    env = dict(os.environ)
    env["LC_ALL"] = "C"
    try:
        kw = {"capture_output": True, "text": True, "timeout": 30, "env": env}
        # A child must not consume the helper's stdin.
        if input is None:
            kw["stdin"] = subprocess.DEVNULL
        else:
            kw["input"] = input
        r = subprocess.run([cmd, *args], **kw)
    except FileNotFoundError:
        raise HelperError("%s is not installed" % cmd)
    except subprocess.TimeoutExpired:
        raise HelperError("%s took too long" % cmd)
    if r.returncode:
        msg = (r.stderr or r.stdout or ("%s failed" % cmd)).strip().split("\n")[-1][:300]
        raise HelperError("%s: %s" % (cmd, msg) if msg else "%s failed" % cmd)
    return r.stdout


def probe(run, cmd, args):
    # A missing binary or a failing probe is a down status, not an error from handle.
    try:
        out = run(cmd, args)
    except Exception:
        return None
    return out if isinstance(out, str) else None


def version_of(text):
    if not text:
        return None
    found = re.search(r"(\d+\.\d+(?:\.\d+)*)", text)
    return found.group(1) if found else None


def memory_mb(text):
    for line in (text or "").splitlines():
        if not line.startswith("MemTotal:"):
            continue
        parts = line.split()
        if len(parts) >= 2 and parts[1].isdigit():
            return int(parts[1]) // 1024
    return 0


def free_gb(path):
    try:
        st = os.statvfs(path)
    except OSError:
        return 0
    return int(round((st.f_bavail * (st.f_frsize or st.f_bsize)) / 1024 ** 3))


def read_meminfo():
    try:
        with open("/proc/meminfo", encoding="utf-8") as fh:
            return fh.read()
    except OSError:
        return ""


def video_models(run, arch):
    # ARM has no PC display adapters.
    if arch == "arm64":
        return ["virtio", "none"]
    text = probe(run, "qemu-system-x86_64", ["-device", "help"]) or ""
    extra = []
    if '"bochs-display"' in text:
        extra.append("bochs")
    if '"qxl-vga"' in text:
        extra.append("qxl")
    if '"cirrus-vga"' in text:
        extra.append("cirrus")
    return ["vga", "virtio", *extra, "none"]


def status_report(run, data_dir, kvm_path, uname, meminfo):
    if data_dir is None:
        data_dir = default_data_dir()
    if kvm_path is None:
        kvm_path = "/dev/kvm"
    machine = uname if isinstance(uname, str) else os.uname().machine
    if meminfo is None:
        meminfo = read_meminfo()
    virsh = probe(run, "virsh", ["--version"])
    qemu = probe(run, "qemu-img", ["--version"])
    arch = "arm64" if machine in ("aarch64", "arm64") else "amd64"
    body = {
        "libvirt": virsh is not None and qemu is not None,
        "kvm": os.access(kvm_path, os.R_OK | os.W_OK),
        "arch": arch,
        "threads": os.cpu_count() or 1,
        "memoryMb": memory_mb(meminfo),
        "freeGb": free_gb(data_dir),
        "passt": bool(shutil.which("passt")),
        "xorriso": bool(shutil.which("xorriso")),
        "videoModels": video_models(run, arch),
        "qemu": version_of(qemu),
        "libvirtVersion": version_of(virsh),
    }
    return json.dumps(body)


def catalog_url_ok(url):
    if not isinstance(url, str) or len(url) < 8 or len(url) > 500:
        return False
    if not url.startswith("https://") or "@" in url:
        return False
    return not any(ch.isspace() for ch in url)


def handle(verb, args, stdin=None, run=None, fetch=None, data_dir=None, kvm_path=None, uid=None, uname=None, meminfo=None):
    if uid is None:
        uid = os.geteuid()
    if uid == 0:
        raise HelperError(ROOT_MESSAGE)
    if args is None:
        args = []
    if verb not in VERBS or (verb == "status" and len(args) != 0):
        raise HelperError("Unknown action")
    run = run or default_run
    if verb == "status":
        return status_report(run, data_dir, kvm_path, uname, meminfo)
    if verb == "fetch":
        if len(args) != 2:
            raise HelperError("Unknown action")
        if not isinstance(args[0], str) or IMAGE_ID.fullmatch(args[0]) is None:
            raise HelperError("Not an image: %s" % (args[0] if isinstance(args[0], str) else "")[:200])
        if not catalog_url_ok(args[1]):
            raise HelperError("The catalog address must be https")
        raise HelperError("Not implemented")
    if verb == "start":
        if len(args) != 1 or not isinstance(args[0], str):
            raise HelperError("Unknown action")
        if GUEST_ID.fullmatch(args[0]) is None:
            raise HelperError("Not a virtual machine: %s" % args[0][:200])
        raise HelperError("Not implemented")
    raise HelperError("Not implemented")


def main(argv=None):
    argv = list(sys.argv if argv is None else argv)
    verb = argv[1] if len(argv) > 1 else ""
    args = argv[2:]
    stdin = None
    if not sys.stdin.isatty():
        stdin = sys.stdin.read()
    try:
        sys.stdout.write(handle(verb, args, stdin=stdin, uid=os.geteuid()))
        sys.stdout.write("\n")
    except HelperError as err:
        sys.stderr.write("%s\n" % err.message)
        sys.exit(1)


if __name__ == "__main__":
    main()
