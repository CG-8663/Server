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

    def test_no_gpus(self):
        def run(cmd, args):
            return ""

        self.assertEqual(agent.gpus(run=run, list_dir=lambda p: [], read_file=lambda p, d="": d), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
