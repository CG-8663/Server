import json
import unittest

from agent import ABILITY_NAMES, supported_abilities, vm_call


class VmAgent(unittest.TestCase):
    def test_ability_and_dispatch(self):
        self.assertIn("vms", ABILITY_NAMES)
        win = supported_abilities({"vms": True, "terminal": True}, windows=True)
        self.assertFalse(win["vms"])
        mac = supported_abilities({"vms": True}, mac=True)
        self.assertFalse(mac["vms"])
        spawned = []

        def spawn(argv, stdin=None):
            spawned.append((argv, stdin))
            if argv[-3] == "fetch":
                return "PROGRESS 40\nPROGRESS 100\n", "/data/vm-images/debian-12"
            return "", "ok"

        progress = []
        with self.assertRaises(RuntimeError) as off:
            vm_call("vm-status", {}, allowed={"vms": False}, spawn=spawn, progress=progress.append)
        self.assertIn("doesn’t allow virtual machines", str(off.exception))
        self.assertEqual(spawned, [])
        out = vm_call("vm-fetch", {"imageId": "debian-12", "catalogUrl": "https://example.test/catalog.json"}, allowed={"vms": True}, spawn=spawn, progress=progress.append)
        self.assertEqual(out, "/data/vm-images/debian-12")
        self.assertEqual(progress, [0.4, 1.0])
        argv = spawned[-1][0]
        self.assertNotIn("sh", argv)
        self.assertNotIn("sudo", argv)
        self.assertEqual(argv[-3:], ["fetch", "debian-12", "https://example.test/catalog.json"])
        with self.assertRaises(RuntimeError):
            vm_call("vm-fetch", {"imageId": "debian-12", "catalogUrl": "https://evil.test/a b"}, allowed={"vms": True}, spawn=spawn)
        with self.assertRaises(RuntimeError):
            vm_call("vm-nope", {}, allowed={"vms": True}, spawn=spawn)


if __name__ == "__main__":
    unittest.main()
