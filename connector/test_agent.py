import io
import json
import os
import re
import signal
import socket
import sys
import tempfile
import threading
import time
import http.client
import http.server
import unittest
import urllib.error
import urllib.parse
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))
import agent  # noqa: E402


class Run(unittest.TestCase):
    # #117
    def test_whitespace_only_output(self):
        with self.assertRaisesRegex(RuntimeError, "^sh failed$"):
            agent.run(["sh", "-c", "echo; exit 1"])
        with self.assertRaisesRegex(RuntimeError, "boom"):
            agent.run(["sh", "-c", "echo boom >&2; exit 1"])


class Plugins(unittest.TestCase):
    # #177
    def test_manifest_that_is_not_an_object(self):
        with tempfile.TemporaryDirectory() as home:
            for name, body in (("a", "[]"), ("b", "null"), ("c", '{"id": "real"}')):
                os.makedirs(os.path.join(home, ".config/omarchy/plugins", name))
                with open(os.path.join(home, ".config/omarchy/plugins", name, "manifest.json"), "w") as f:
                    f.write(body)
            with mock.patch.dict(os.environ, {"HOME": home}), mock.patch("shutil.which", lambda n: "/x" if n == "omarchy" else None):
                self.assertEqual(agent.omarchy_facts()["plugins"], ["a", "b", "real"])


class CloseStopsPump(unittest.TestCase):
    # A server {op:close} sets closed, so Shell.pump and Screen.pump stop forwarding.
    def test_close_op_stops_screen_pump(self):
        left, right = socket.socketpair()
        sent = []
        conn = mock.Mock()
        conn.ws.send_binary = sent.append
        conn.send = sent.append
        screen = agent.Screen.__new__(agent.Screen)
        agent.Channel.__init__(screen, conn, 4)
        screen.sock = left
        thread = threading.Thread(target=screen.pump, daemon=True)
        thread.start()
        try:
            right.sendall(b"one")
            for _ in range(50):
                if any(isinstance(item, (bytes, bytearray)) and b"one" in item for item in sent):
                    break
                time.sleep(0.02)
            else:
                self.fail("pump did not forward the first frame")
            connection = agent.Connection.__new__(agent.Connection)
            connection.channels = {4: screen}
            connection.handle({"op": "close", "ch": 4})
            self.assertTrue(screen.closed)
            self.assertNotIn(4, connection.channels)
            thread.join(timeout=1)
            self.assertFalse(thread.is_alive())
            sent.clear()
            try:
                right.sendall(b"two")
            except OSError:
                pass
            time.sleep(0.1)
            self.assertFalse(any(isinstance(item, (bytes, bytearray)) and b"two" in item for item in sent))
        finally:
            right.close()
            try:
                left.close()
            except OSError:
                pass

    def test_close_op_stops_shell_pump(self):
        conn = mock.Mock()
        conn.send = lambda msg: None
        conn.ws.send_binary = lambda data: None
        shell = agent.Shell(conn, 9, 80, 24)
        pid = shell.pid
        try:
            connection = agent.Connection.__new__(agent.Connection)
            connection.channels = {9: shell}
            connection.handle({"op": "close", "ch": 9})
            self.assertTrue(shell.closed)
            self.assertNotIn(9, connection.channels)
            for _ in range(60):
                try:
                    os.kill(pid, 0)
                except ProcessLookupError:
                    break
                time.sleep(0.1)
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)
        finally:
            if not shell.closed:
                shell.close()


class ShellReap(unittest.TestCase):
    # #180: a closed terminal is reaped, not left as a zombie.
    def test_closed_shell_is_reaped(self):
        sent = []
        conn = mock.Mock()
        conn.send = sent.append
        conn.binary = lambda *a, **k: None
        sh = agent.Shell(conn, 1, 80, 24)
        pid = sh.pid
        time.sleep(0.3)
        sh.close()
        for _ in range(60):
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                break
            time.sleep(0.1)
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)


class Disks(unittest.TestCase):
    # #185: only the real system folders are hidden, not names that merely start the same way.
    def test_prefix_is_a_whole_folder(self):
        mounts = "/dev/sda1 /mnt/x ext4 rw 0 0\n/dev/sdb1 /snapshots btrfs rw 0 0\n/dev/sdc1 /boot vfat rw 0 0\n/dev/sdd1 /var/lib/docker-data ext4 rw 0 0\n"
        st = mock.Mock(f_blocks=100, f_frsize=4096, f_bavail=50, f_bfree=50)
        with mock.patch.object(agent, "read", lambda p, *a: mounts if p == "/proc/mounts" else ""), mock.patch("os.statvfs", lambda p: st):
            got = [d["mount"] for d in agent.disks()]
        self.assertIn("/snapshots", got)
        self.assertIn("/var/lib/docker-data", got)
        self.assertNotIn("/boot", got)

    # #745: one ZFS pool is one disk, so a later real disk is not cut off at 12.
    def test_zfs_pool_listed_once_and_later_ext4_kept(self):
        points = ["/", "/home/me", "/var/log", "/var/lib", "/var/spool", "/var/cache", "/srv", "/tmp", "/opt", "/games", "/vm", "/a", "/b"]
        lines = []
        for i, mount in enumerate(points):
            dev = "rpool" if i == 0 else f"rpool/ds{i}"
            lines.append(f"{dev} {mount} zfs rw 0 0")
        lines.append("/dev/sdb1 /mnt/backup ext4 rw 0 0")
        mounts = "\n".join(lines) + "\n"
        st = mock.Mock(f_blocks=100, f_frsize=4096, f_bavail=50, f_bfree=50)
        with mock.patch.object(agent, "read", lambda p, *a: mounts if p == "/proc/mounts" else ""), mock.patch("os.statvfs", lambda p: st):
            got = [d["mount"] for d in agent.disks()]
        listed_pool = [m for m in got if m in points]
        self.assertEqual(listed_pool, ["/"])
        self.assertIn("/mnt/backup", got)
        self.assertEqual(len(got), 2)

    # #543: one non-UTF-8 byte in mounts must not drop the root disk.
    def test_non_utf8_mount_byte_keeps_root_disk(self):
        body = b"/dev/sda1 / ext4 rw 0 0\n/dev/sdb1 /mnt/caf\xe9 ext4 rw 0 0\n"
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "mounts")
            with open(path, "wb") as f:
                f.write(body)
            real_open = open

            def opener(p, *a, **k):
                if p == "/proc/mounts":
                    return real_open(path, *a, **k)
                return real_open(p, *a, **k)

            st = mock.Mock(f_blocks=100, f_frsize=4096, f_bavail=40, f_bfree=40)
            with mock.patch("builtins.open", opener), mock.patch("os.statvfs", return_value=st):
                try:
                    got = [item["mount"] for item in agent.disks()]
                except ValueError as e:
                    self.fail(f"disks() raised {type(e).__name__}: {e}")
        self.assertIn("/", got)
        self.assertIn("/mnt/caf\ufffd", got)


class ShellSignals(unittest.TestCase):
    # #783: programs started from the pty shell inherit ignored SIGPIPE and SIGXFSZ.
    # Bash clears those for itself, then puts the ignored state back on every child.
    def test_child_does_not_ignore_sigpipe_or_sigxfsz(self):
        conn = mock.Mock()
        conn.ws.send_binary = lambda *a, **k: None
        sh = agent.Shell(conn, 1, 80, 24)
        child = None
        try:
            for _ in range(100):
                try:
                    exe = os.readlink(f"/proc/{sh.pid}/exe")
                except OSError:
                    exe = ""
                if exe and "python" not in os.path.basename(exe):
                    break
                time.sleep(0.05)
            with tempfile.TemporaryDirectory() as d:
                marker = os.path.join(d, "child-pid")
                os.write(sh.fd, f"sh -c 'echo $$ > {marker}; sleep 20'\n".encode())
                deadline = time.time() + 8
                while time.time() < deadline and not (os.path.isfile(marker) and os.path.getsize(marker) > 0):
                    time.sleep(0.05)
                self.assertTrue(os.path.isfile(marker) and os.path.getsize(marker) > 0, "shell never started a child")
                with open(marker) as f:
                    child = int(f.read().strip())
                with open(f"/proc/{child}/status") as f:
                    text = f.read()
        finally:
            sh.close()
            if child:
                try:
                    os.kill(child, signal.SIGKILL)
                except OSError:
                    pass
        found = re.search(r"SigIgn:\s*([0-9a-fA-F]+)", text)
        self.assertIsNotNone(found, text)
        mask = int(found.group(1), 16)
        self.assertEqual(mask & (1 << (signal.SIGPIPE - 1)), 0, text)
        self.assertEqual(mask & (1 << (signal.SIGXFSZ - 1)), 0, text)


class BackupFolders(unittest.TestCase):
    # #187: a folder that leads outside home is neither offered nor fatal.
    def test_link_out_of_home(self):
        with tempfile.TemporaryDirectory() as home, tempfile.TemporaryDirectory() as other:
            os.mkdir(os.path.join(home, "Documents"))
            os.symlink(other, os.path.join(home, "Pictures"))
            with mock.patch.dict(os.environ, {"HOME": home}):
                names = [f["name"] for f in agent.backup_folders({})["folders"]]
                self.assertEqual(names, ["Documents"])

    # #548: the name backup_folders lists is the name home_folder resolves.
    def test_trailing_space_in_name_is_kept(self):
        spaced = "Photos "
        with tempfile.TemporaryDirectory() as home:
            os.mkdir(os.path.join(home, "Photos"))
            os.mkdir(os.path.join(home, spaced))
            os.mkdir(os.path.join(home, "Documents"))
            with mock.patch.dict(os.environ, {"HOME": home}):
                names = [f["name"] for f in agent.backup_folders({})["folders"]]
                self.assertIn(spaced, names)
                self.assertEqual(agent.home_folder(spaced), os.path.realpath(os.path.join(home, spaced)))
                self.assertEqual(agent.home_folder("Documents"), os.path.realpath(os.path.join(home, "Documents")))
                self.assertEqual(agent.home_folder("Documents/"), os.path.realpath(os.path.join(home, "Documents")))
                for bad in ("   ", " \t ", "Photos\n", "/Photos", "/"):
                    with self.assertRaises(RuntimeError, msg=repr(bad)):
                        agent.home_folder(bad)


class Restore(unittest.TestCase):
    # #188: a failed restore leaves no empty folder.
    def test_failed_restore_cleans_up(self):
        with tempfile.TemporaryDirectory() as home:
            with mock.patch.dict(os.environ, {"HOME": home}), mock.patch.object(agent, "restic_path", lambda: "/x"), mock.patch.object(agent, "start_relay", side_effect=RuntimeError("unreachable")):
                with self.assertRaises(RuntimeError):
                    agent.backup_restore(None, 1, {"password": "p", "snapshot": "abcdef12"}, {})
            restored = os.path.join(home, "Restored")
            self.assertEqual(os.listdir(restored) if os.path.isdir(restored) else [], [])


class CLI(unittest.TestCase):
    # #612: argument handling and --help
    def test_help_prints_usage_even_when_configured(self):
        with tempfile.TemporaryDirectory() as d:
            cfg = os.path.join(d, "config.json")
            with open(cfg, "w") as f:
                json.dump({"server": "https://127.0.0.1:7780", "id": "1", "key": "k"}, f)
            for args in (["--help"], ["-h"], ["help"], ["help", "enroll"], ["enroll", "--help"], ["info", "--help"]):
                out = io.StringIO()
                with mock.patch.object(agent, "CONFIG", cfg), mock.patch.object(agent, "Connection", side_effect=AssertionError("must not connect")), mock.patch("sys.stdout", out):
                    agent.main(args)
                self.assertIn("enroll", out.getvalue())

    def test_bad_arguments_exit_2_with_usage(self):
        for args in (["--version"], ["--bogus"], ["status"], ["enroll"], ["enroll", "https://s"], ["enroll", "https://s", "tok", "a", "extra"], ["enroll", "--opt", "tok"], ["info", "extra"]):
            err = io.StringIO()
            with mock.patch("sys.stderr", err), self.assertRaises(SystemExit) as ctx:
                agent.main(args)
            self.assertEqual(ctx.exception.code, 2, args)
            self.assertIn("Use:", err.getvalue())

    def test_enroll_accepts_empty_abilities_arg(self):
        with tempfile.TemporaryDirectory() as d:
            cfg_dir = os.path.join(d, "cfg")
            cfg = os.path.join(cfg_dir, "config.json")
            out = io.StringIO()
            with mock.patch.object(agent, "CONFIG_DIR", cfg_dir), mock.patch.object(agent, "CONFIG", cfg), mock.patch.object(agent, "enroll", return_value={"id": "i1", "key": "k1", "name": "box"}) as m_enroll, mock.patch("sys.stdout", out):
                agent.main(["enroll", "https://127.0.0.1:7780", "tok", ""])
            m_enroll.assert_called_once()
            self.assertEqual(out.getvalue().strip(), "box")


class QuietHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass


class _CompleteHandler(QuietHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = b""
        while len(body) < n:
            chunk = self.rfile.read(min(65536, n - len(body)))
            if not chunk:
                break
            body += chunk
        self.server.got = body
        payload = b"hello"
        self.send_response(200)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


class _UploadHandler(QuietHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        got = 0
        while got < n:
            chunk = self.rfile.read(min(65536, n - got))
            if not chunk:
                break
            got += len(chunk)
        self.server.got = got
        self.server.done.set()
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()


class _ShortDownloadHandler(QuietHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Length", "1000000")
        self.close_connection = True
        self.end_headers()
        self.wfile.write(b"x" * 1000)
        self.wfile.flush()


class _StallHandler(QuietHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Length", "5000")
        self.end_headers()
        self.wfile.write(b"y" * 4000)
        self.wfile.flush()
        # Stay open with no more bytes until the relay times out and drops the socket.
        try:
            self.connection.settimeout(30)
            while self.connection.recv(1):
                pass
        except OSError:
            pass


class RelayCutShort(unittest.TestCase):
    # #744: a cut-short upload, a cut-short download, and an error after the headers.
    def _upstream(self, handler):
        httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        httpd.daemon_threads = True
        httpd.done = threading.Event()
        httpd.got = None
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        self.addCleanup(httpd.shutdown)
        self.addCleanup(httpd.server_close)
        return httpd

    def _relay(self, upstream, upstream_timeout):
        class Plain(http.client.HTTPConnection):
            def __init__(self, host, port=None, context=None, timeout=socket._GLOBAL_DEFAULT_TIMEOUT):
                super().__init__(host, port, timeout=upstream_timeout)

        cfg = {"server": f"https://127.0.0.1:{upstream.server_address[1]}", "id": "i", "key": "k"}
        with mock.patch.object(agent.http.client, "HTTPSConnection", Plain), mock.patch.object(agent.ssl, "create_default_context", return_value=mock.Mock()):
            relay, url = agent.start_relay(cfg)
            self.addCleanup(relay.shutdown)
            self.addCleanup(relay.server_close)
            rest = url[5:] if url.startswith("rest:") else url
            parsed = urllib.parse.urlsplit(rest)
            yield relay, parsed.port, parsed.path.strip("/")

    def _read_socket(self, sock, seconds):
        sock.settimeout(seconds)
        buf = b""
        closed = False
        try:
            while len(buf) < 2000000:
                chunk = sock.recv(65536)
                if not chunk:
                    closed = True
                    break
                buf += chunk
                if b"502" in buf:
                    break
        except socket.timeout:
            pass
        return buf, closed

    def test_complete_upload_returns_the_upstream_body(self):
        upstream = self._upstream(_CompleteHandler)
        for _relay, port, secret in self._relay(upstream, 5):
            body = b"pack"
            req = (
                f"POST /{secret}/data/abc HTTP/1.1\r\n"
                "Host: 127.0.0.1\r\n"
                "Connection: close\r\n"
                f"Content-Length: {len(body)}\r\n"
                "\r\n"
            ).encode() + body
            sock = socket.create_connection(("127.0.0.1", port), timeout=5)
            sock.sendall(req)
            buf, closed = self._read_socket(sock, 3)
            sock.close()
            self.assertEqual(upstream.got, body)
            self.assertIn(b"hello", buf)
            self.assertNotIn(b"502", buf)
            self.assertTrue(closed)

    def test_upload_cut_short_closes_upstream(self):
        upstream = self._upstream(_UploadHandler)
        for _relay, port, secret in self._relay(upstream, 30):
            req = (
                f"POST /{secret}/data/abc HTTP/1.1\r\n"
                "Host: 127.0.0.1\r\n"
                "Content-Length: 1000\r\n"
                "\r\n"
            ).encode() + b"x" * 100
            sock = socket.create_connection(("127.0.0.1", port), timeout=5)
            try:
                sock.sendall(req)
                time.sleep(0.5)
            finally:
                sock.close()
            self.assertTrue(upstream.done.wait(2), "upstream request still open after a cut-short upload")
            self.assertEqual(upstream.got, 100)

    def test_download_cut_short_closes_client(self):
        upstream = self._upstream(_ShortDownloadHandler)
        for _relay, port, secret in self._relay(upstream, 30):
            req = f"GET /{secret}/data/abc HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n".encode()
            sock = socket.create_connection(("127.0.0.1", port), timeout=5)
            sock.sendall(req)
            buf, closed = self._read_socket(sock, 6)
            sock.close()
            self.assertTrue(closed, f"client still waiting after 6 s; received {len(buf)} bytes of a response that promised 1000000+headers")
            self.assertLess(len(buf), 100000)
            self.assertIn(b"x" * 1000, buf)

    def test_error_after_headers_does_not_inject_502(self):
        upstream = self._upstream(_StallHandler)
        for _relay, port, secret in self._relay(upstream, 1):
            req = f"GET /{secret}/data/abc HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n".encode()
            sock = socket.create_connection(("127.0.0.1", port), timeout=5)
            sock.sendall(req)
            buf, closed = self._read_socket(sock, 5)
            sock.close()
            self.assertNotIn(b"502", buf)
            self.assertIn(b"200", buf)
            self.assertTrue(closed, f"client still open after a stalled body ({len(buf)} bytes)")


class EnrollErrors(unittest.TestCase):
    # #612: friendly SystemExit on bad scheme, missing CA, or unreachable server
    def test_bad_scheme(self):
        with self.assertRaises(SystemExit) as ctx:
            agent.enroll("http://127.0.0.1:7780", "tok", {})
        self.assertIn("https://", str(ctx.exception))

    def test_missing_ca_file(self):
        with tempfile.TemporaryDirectory() as d:
            ca = os.path.join(d, "missing-ca.crt")
            with mock.patch.object(agent, "CA_FILE", ca), self.assertRaises(SystemExit) as ctx:
                agent.enroll("https://127.0.0.1:7780", "tok", {})
            self.assertIn("Server certificate not found", str(ctx.exception))

    def test_url_error(self):
        with mock.patch("ssl.create_default_context"), mock.patch("urllib.request.urlopen", side_effect=urllib.error.URLError("connection refused")):
            with self.assertRaises(SystemExit) as ctx:
                agent.enroll("https://127.0.0.1:7780", "tok", {})
            self.assertIn("Couldn't reach", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
