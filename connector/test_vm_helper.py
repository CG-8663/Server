import importlib.util
import json
import os
import sys
import tempfile
import unittest

# vm-helper.py cannot be imported by name. Register it as vm_helper first.
_helper_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vm-helper.py")
if os.path.exists(_helper_path):
    _spec = importlib.util.spec_from_file_location("vm_helper", _helper_path)
    _module = importlib.util.module_from_spec(_spec)
    sys.modules["vm_helper"] = _module
    _spec.loader.exec_module(_module)

from vm_helper import HelperError, handle


class Status(unittest.TestCase):
    def test_status_and_rejections(self):
        log = []

        def run(cmd, args, input=None):
            log.append([cmd, *args])
            if cmd == "virsh" and args == ["--version"]:
                return "10.0.0\n"
            if cmd == "qemu-img" and args == ["--version"]:
                return "qemu-img version 9.0.0\n"
            if cmd == "qemu-system-x86_64":
                return '"bochs-display"\n'
            return ""

        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "vm-images"))
            out = handle("status", [], run=run, data_dir=d, kvm_path=os.path.join(d, "no-kvm"), uid=1000, uname="x86_64", meminfo="MemTotal: 8000000 kB\n")
        body = json.loads(out)
        self.assertEqual(body["libvirt"], True)
        self.assertEqual(body["kvm"], False)
        self.assertEqual(body["arch"], "amd64")
        self.assertIn("vga", body["videoModels"])
        self.assertIn("bochs", body["videoModels"])
        self.assertTrue(all(c[0] != "sh" for c in log))

        with self.assertRaises(HelperError):
            handle("status", [], uid=0)
        with self.assertRaises(HelperError) as unk:
            handle("rm", ["-rf", "/"])
        self.assertIn("Unknown action", str(unk.exception))
        with self.assertRaises(HelperError):
            handle("fetch", ["../etc/passwd", "https://example.test/c.json"], uid=1000)
        with self.assertRaises(HelperError):
            handle("fetch", ["debian-12", "http://example.test/c.json"], uid=1000)
        with self.assertRaises(HelperError):
            handle("fetch", ["debian-12", "https://user:pw@example.test/c.json"], uid=1000)
        with self.assertRaises(HelperError):
            handle("start", ["not-an-id"], uid=1000)


if __name__ == "__main__":
    unittest.main()
