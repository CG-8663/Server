#!/usr/bin/env python3
"""Fake sysfs for the connector's GPU and battery collectors."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "connector"))
import agent  # noqa: E402


def from_files(files, names):
    def list_dir(path):
        if path.rstrip("/") == "/sys/class/power_supply":
            return names
        return []

    def read_file(path, default=""):
        return files.get(path, default)

    return list_dir, read_file


class Batteries(unittest.TestCase):
    def test_no_supplies(self):
        list_dir, read_file = from_files({}, [])
        self.assertEqual(agent.batteries(list_dir=list_dir, read_file=read_file), [])

    def test_skips_mains_and_device_scope(self):
        files = {
            "/sys/class/power_supply/AC/type": "Mains",
            "/sys/class/power_supply/hid-mouse/type": "Battery",
            "/sys/class/power_supply/hid-mouse/present": "1",
            "/sys/class/power_supply/hid-mouse/scope": "Device",
            "/sys/class/power_supply/hid-mouse/capacity": "90",
            "/sys/class/power_supply/hid-mouse/status": "Discharging",
        }
        list_dir, read_file = from_files(files, ["AC", "hid-mouse"])
        self.assertEqual(agent.batteries(list_dir=list_dir, read_file=read_file), [])

    def test_laptop_pack_charging(self):
        files = {
            "/sys/class/power_supply/BAT0/type": "Battery",
            "/sys/class/power_supply/BAT0/present": "1",
            "/sys/class/power_supply/BAT0/scope": "System",
            "/sys/class/power_supply/BAT0/status": "Charging",
            "/sys/class/power_supply/BAT0/capacity": "64",
            "/sys/class/power_supply/BAT0/model_name": "Internal",
            "/sys/class/power_supply/BAT0/energy_now": "32000000",
            "/sys/class/power_supply/BAT0/energy_full": "50000000",
            "/sys/class/power_supply/BAT0/power_now": "10000000",
        }
        list_dir, read_file = from_files(files, ["BAT0"])
        self.assertEqual(
            agent.batteries(list_dir=list_dir, read_file=read_file),
            [
                {
                    "id": "BAT0",
                    "index": 0,
                    "name": "Internal",
                    "percent": 64,
                    "status": "charging",
                    "secondsRemaining": 6480,
                    "power": 10,
                    "energyNow": 32000000,
                    "energyFull": 50000000,
                }
            ],
        )


class Gpus(unittest.TestCase):
    def setUp(self):
        agent._last_nvidia = None
        agent._last_engine = {}
        agent._last_rc6 = {}

    def test_nvidia_csv(self):
        csv = "0, NVIDIA GeForce RTX 3060, GPU-aaa, 32, 1477, 12288, 39\n1, NVIDIA GeForce RTX 3060, GPU-bbb, 0, 2, 12288, 36\n"

        def run(cmd, args):
            return csv if cmd == "nvidia-smi" else ""

        gpus = agent.gpus(run=run, list_dir=lambda p: [], read_file=lambda p, d="": d)
        self.assertEqual(len(gpus), 2)
        self.assertEqual(gpus[0], {"id": "GPU-aaa", "index": 0, "name": "NVIDIA GeForce RTX 3060", "used": 32})
        self.assertEqual(gpus[1]["id"], "GPU-bbb")
        self.assertEqual(gpus[1]["used"], 0)

    def test_nvidia_missing_falls_back_to_drm(self):
        files = {
            "/sys/class/drm/card0/device/gpu_busy_percent": "41\n",
            "/sys/class/drm/card0/device/product_name": "AMD Radeon RX 7900 XTX\n",
        }

        def list_dir(path):
            if path == "/sys/class/drm":
                return ["card0", "card0-DP-1", "renderD128"]
            return []

        def read_file(path, default=""):
            return files.get(path, default)

        def run(cmd, args):
            raise FileNotFoundError(cmd)

        gpus = agent.gpus(run=run, list_dir=list_dir, read_file=read_file)
        self.assertEqual(len(gpus), 1)
        self.assertEqual(gpus[0]["id"], "drm-card0")
        self.assertEqual(gpus[0]["name"], "AMD Radeon RX 7900 XTX")
        self.assertEqual(gpus[0]["used"], 41)

    def test_sleeping_nvidia_not_woken(self):
        calls = []
        state = {"status": "active"}
        csv = "0, NVIDIA GeForce RTX 4060 Laptop GPU, GPU-x, 12, 300, 8188, 44\n"

        def run(cmd, args):
            calls.append(cmd)
            return csv

        def list_dir(path):
            return ["0000:01:00.0"] if path == "/sys/bus/pci/devices" else []

        def read_file(path, default=""):
            if path.endswith("/vendor"):
                return "0x10de\n"
            if path.endswith("/class"):
                return "0x030200\n"
            if path.endswith("runtime_status"):
                return state["status"]
            return default

        self.assertEqual(agent.gpus(run=run, list_dir=list_dir, read_file=read_file)[0]["used"], 12)
        state["status"] = "suspended"
        asleep = agent.gpus(run=run, list_dir=list_dir, read_file=read_file)
        self.assertEqual(len(calls), 1)
        self.assertEqual((asleep[0]["id"], asleep[0]["used"]), ("GPU-x", 0))
        state["status"] = "active"
        agent.gpus(run=run, list_dir=list_dir, read_file=read_file)
        self.assertEqual(len(calls), 2)
        agent._last_nvidia = None

    def test_intel_listed_without_busy_percent(self):
        files = {
            "/sys/class/drm/card0/device/vendor": "0x8086\n",
            "/sys/class/drm/card0/device/product_name": "Intel Arc Graphics\n",
        }

        def list_dir(path):
            return ["card0", "card0-eDP-1"] if path == "/sys/class/drm" else []

        def run(cmd, args):
            return ""

        gpus = agent.gpus(run=run, list_dir=list_dir, read_file=lambda p, d="": files.get(p, d))
        self.assertEqual(len(gpus), 1)
        self.assertEqual(gpus[0]["id"], "drm-card0")
        self.assertEqual(gpus[0]["name"], "Intel Arc Graphics")
        self.assertIsNone(gpus[0]["used"])

    def test_intel_engine_busy_not_stuck_gpu_busy_percent(self):
        # i915 often exposes gpu_busy_percent as 0. Utilization is rcs0 busy-ns over wall time.
        files = {
            "/sys/class/drm/card1/device/vendor": "0x8086\n",
            "/sys/class/drm/card1/device/gpu_busy_percent": "0\n",
            "/sys/class/drm/card1/engine/rcs0/busy": "0\n",
            "/sys/class/drm/card1/engine/bcs0/busy": "0\n",
        }
        clock = {"t": 10.0}

        def list_dir(path):
            if path == "/sys/class/drm":
                return ["card1", "card1-eDP-1"]
            if path == "/sys/class/drm/card1/engine":
                return ["rcs0", "bcs0"]
            return []

        def read_file(path, default=""):
            return files.get(path, default)

        first = agent.gpus(run=lambda c, a: "", list_dir=list_dir, read_file=read_file, now=lambda: clock["t"])
        self.assertEqual(first[0]["id"], "drm-card1")
        self.assertEqual(first[0]["name"], "Intel Graphics")
        self.assertIsNone(first[0]["used"])
        files["/sys/class/drm/card1/engine/rcs0/busy"] = str(int(0.4 * 1e9)) + "\n"
        clock["t"] = 11.0
        second = agent.gpus(run=lambda c, a: "", list_dir=list_dir, read_file=read_file, now=lambda: clock["t"])
        self.assertEqual(second[0]["used"], 40)

    def test_intel_compute_busy_not_hidden_by_idle_render(self):
        files = {
            "/sys/class/drm/card1/device/vendor": "0x8086\n",
            "/sys/class/drm/card1/engine/rcs0/busy": "0\n",
            "/sys/class/drm/card1/engine/ccs0/busy": "0\n",
        }
        clock = {"t": 10.0}

        def list_dir(path):
            if path == "/sys/class/drm":
                return ["card1"]
            if path == "/sys/class/drm/card1/engine":
                return ["rcs0", "ccs0"]
            return []

        first = agent.gpus(run=lambda c, a: "", list_dir=list_dir, read_file=lambda p, d="": files.get(p, d), now=lambda: clock["t"])
        self.assertIsNone(first[0]["used"])
        files["/sys/class/drm/card1/engine/ccs0/busy"] = str(int(0.4 * 1e9)) + "\n"
        clock["t"] = 11.0
        second = agent.gpus(run=lambda c, a: "", list_dir=list_dir, read_file=lambda p, d="": files.get(p, d), now=lambda: clock["t"])
        self.assertEqual(second[0]["used"], 40)

    def test_bmc_and_virtio_without_busy_percent_are_not_listed(self):
        files = {
            "/sys/class/drm/card0/device/vendor": "0x1a03\n",
            "/sys/class/drm/card0/device/product_name": "ASPEED Graphics Family\n",
            "/sys/class/drm/card1/device/vendor": "0x8086\n",
            "/sys/class/drm/card1/device/product_name": "Intel Graphics\n",
        }

        def list_dir(path):
            return ["card0", "card1"] if path == "/sys/class/drm" else []

        gpus = agent.gpus(run=lambda c, a: "", list_dir=list_dir, read_file=lambda p, d="": files.get(p, d))
        self.assertEqual([g["id"] for g in gpus], ["drm-card1"])
        self.assertIsNone(gpus[0]["used"])

    def test_intel_rc6_when_engine_has_no_busy_file(self):
        # Broadwell i915: engine dirs exist, no busy files, no gpu_busy_percent.
        # RC6 residency is idle time; GPU use is the wall time not spent in RC6.
        files = {
            "/sys/class/drm/card1/device/vendor": "0x8086\n",
            "/sys/class/drm/card1/gt/gt0/rc6_enable": "1\n",
            "/sys/class/drm/card1/gt/gt0/rc6_residency_ms": "0\n",
        }
        clock = {"t": 10.0}

        def list_dir(path):
            if path == "/sys/class/drm":
                return ["card1", "card1-eDP-1"]
            if path == "/sys/class/drm/card1/engine":
                return ["rcs0", "bcs0", "vcs0", "vecs0"]
            return []

        def read_file(path, default=""):
            return files.get(path, default)

        first = agent.gpus(run=lambda c, a: "", list_dir=list_dir, read_file=read_file, now=lambda: clock["t"])
        self.assertEqual(first[0]["id"], "drm-card1")
        self.assertIsNone(first[0]["used"])
        files["/sys/class/drm/card1/gt/gt0/rc6_residency_ms"] = "600\n"
        clock["t"] = 11.0
        second = agent.gpus(run=lambda c, a: "", list_dir=list_dir, read_file=read_file, now=lambda: clock["t"])
        self.assertEqual(second[0]["used"], 40)

    def test_hybrid_nvidia_and_amd(self):
        files = {
            "/sys/class/drm/card0/device/vendor": "0x1002\n",
            "/sys/class/drm/card0/device/gpu_busy_percent": "41\n",
            "/sys/class/drm/card0/device/product_name": "AMD Radeon RX 7900 XTX\n",
        }
        csv = "0, NVIDIA GeForce RTX 3060, GPU-aaa, 32, 1477, 12288, 39\n"

        def run(cmd, args):
            return csv if cmd == "nvidia-smi" else ""

        def list_dir(path):
            return ["card0"] if path == "/sys/class/drm" else []

        gpus = agent.gpus(run=run, list_dir=list_dir, read_file=lambda p, d="": files.get(p, d))
        self.assertEqual([g["id"] for g in gpus], ["GPU-aaa", "drm-card0"])
        self.assertEqual(gpus[1]["used"], 41)

    def test_no_gpus(self):
        def run(cmd, args):
            return ""

        self.assertEqual(agent.gpus(run=run, list_dir=lambda p: [], read_file=lambda p, d="": d), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
