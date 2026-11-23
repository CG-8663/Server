import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))
import agent  # noqa: E402


class ReportHelloInterval(unittest.TestCase):
    # #432: refresh hello once every 5 minutes, not 3-4 times per 10s window.
    def test_hello_sent_once_per_300_seconds(self):
        conn = agent.Connection({"abilities": {}})
        sent = []
        conn.send = sent.append
        sampler = mock.Mock()
        sampler.active.return_value = False
        last_hello = 0.0
        with mock.patch.object(agent, "info", return_value={"hostname": "box"}):
            for step in range(1, 3001):
                t = float(step * 3)
                last_hello = conn._report_step(sampler, last_hello, t)
        hellos = [m for m in sent if m.get("op") == "hello"]
        self.assertEqual(len(hellos), 30)

    def test_no_burst_after_300_second_mark(self):
        conn = agent.Connection({"abilities": {}})
        sent = []
        conn.send = sent.append
        sampler = mock.Mock()
        sampler.active.return_value = False
        last_hello = 0.0
        with mock.patch.object(agent, "info", return_value={"hostname": "box"}):
            for t in (297.0, 300.0, 303.0, 306.0, 309.0):
                last_hello = conn._report_step(sampler, last_hello, t)
        self.assertEqual(len([m for m in sent if m.get("op") == "hello"]), 1)
        self.assertEqual(last_hello, 300.0)


if __name__ == "__main__":
    unittest.main()


class DesktopSessionReported(unittest.TestCase):
    # Signing in to the desktop after the connector started is reported within seconds.
    def test_hello_when_the_desktop_appears(self):
        conn = agent.Connection({"abilities": {"desktop": True}})
        sent = []
        conn.send = sent.append
        sampler = mock.Mock()
        sampler.active.return_value = False
        states = iter([{"kind": "none", "ok": False}] * 3 + [{"kind": "wlroots", "ok": True}] * 10)
        with mock.patch.object(agent, "info", return_value={"hostname": "box"}), mock.patch.object(agent, "desktop_kind", side_effect=lambda: next(states)):
            last = conn._report_step(sampler, 0.0, 400.0)  # the regular hello
            for t in (412.0, 424.0, 436.0, 448.0):
                last = conn._report_step(sampler, last, t)
        hellos = [m for m in sent if m.get("op") == "hello"]
        self.assertEqual(len(hellos), 2)

    def test_nothing_extra_without_the_desktop_ability(self):
        conn = agent.Connection({"abilities": {}})
        sent = []
        conn.send = sent.append
        sampler = mock.Mock()
        sampler.active.return_value = False
        with mock.patch.object(agent, "info", return_value={}), mock.patch.object(agent, "desktop_kind", side_effect=AssertionError("not checked")):
            conn._report_step(sampler, 400.0, 412.0)
        self.assertEqual(sent, [])
