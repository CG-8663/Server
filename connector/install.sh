#!/usr/bin/env bash
# My Own Data Center connector: join this Linux computer or Mac to your My Own Data Center's local swarm.
#
# Get the exact command (with a one-time pairing code) from your server: Machines → Local swarm →
# Add a computer. It looks like:
#   curl -fsSL <source>/main/connector/install.sh | bash -s -- --server https://<server>:7780 --ca <fingerprint> --token <code> --allow terminal,desktop,manage,backup
#
# Run it as your normal user (it asks for sudo only to install packages and to keep the connector
# running while you're signed out). Works on any Linux with systemd: Debian, Ubuntu, Fedora, Arch,
# Omarchy, openSUSE and their relatives. It finds the distribution's package manager itself.
# On a Mac (macOS 12 or later) it needs no sudo: it runs as a LaunchAgent while you're signed in.
#
# Remove it again:  curl -fsSL <source>/main/connector/install.sh | bash -s -- --uninstall
set -euo pipefail

usage() {
	cat <<'EOF'
My Own Data Center connector installer

  connector/install.sh --server <https://...> --ca <fingerprint> --token <code> [--allow <list>] [--source <url>] [--user-enroll-only]
  connector/install.sh --uninstall
  connector/install.sh -h|--help

Options:
  --server <url>        Server URL (https://...)
  --ca <fingerprint>    64-char hex SHA-256 fingerprint of the server CA
  --token <code>        One-time pairing token from Machines -> Local swarm
  --allow <abilities>   Comma-separated abilities (terminal,desktop,manage,storage,backup,services,files)
  --source <url>        Base URL to download connector files from
  --user-enroll-only    Skip packages, the storage helper and linger (already installed)
  --uninstall           Remove the connector from this computer
  -h, --help            Show this help
EOF
}

need_value() {
	if [ "$2" -lt 2 ]; then
		printf 'Missing value for %s\n\n' "$1" >&2
		usage >&2
		exit 2
	fi
}

SOURCE="https://raw.githubusercontent.com/MyOwnDataCenter/server"
SERVER="" CA="" TOKEN="" ALLOW="" UNINSTALL=0 USER_ENROLL_ONLY=0
while [ $# -gt 0 ]; do
	case "$1" in
		--server) need_value "$1" "$#"; SERVER="$2"; shift 2 ;;
		--server=*) SERVER="${1#--server=}"; shift ;;
		--ca) need_value "$1" "$#"; CA="$2"; shift 2 ;;
		--ca=*) CA="${1#--ca=}"; shift ;;
		--token) need_value "$1" "$#"; TOKEN="$2"; shift 2 ;;
		--token=*) TOKEN="${1#--token=}"; shift ;;
		--allow) need_value "$1" "$#"; ALLOW="$2"; shift 2 ;;
		--allow=*) ALLOW="${1#--allow=}"; shift ;;
		--source) need_value "$1" "$#"; SOURCE="$2"; shift 2 ;;
		--source=*) SOURCE="${1#--source=}"; shift ;;
		--user-enroll-only | --user-enroll-only=*) USER_ENROLL_ONLY=1; shift ;;
		--uninstall) UNINSTALL=1; shift ;;
		-h | --help) usage; exit 0 ;;
		*) printf 'Unknown option: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
	esac
done

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }
need_password() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 4; }
# curl | bash has no TTY on stdin; the person still has one on stderr. qemu-ga has neither.
noninteractive() {
	[ -n "${OMARCHY_CONNECTOR_NONINTERACTIVE:-}" ] || [ "$USER_ENROLL_ONLY" = 1 ] || { [ ! -t 0 ] && [ ! -t 2 ]; }
}
as_root() {
	if noninteractive; then
		sudo -n "$@"
	else
		sudo "$@"
	fi
}
# Syntax only. Parsing does not write bytecode beside the download.
python_ok() {
	python3 -c 'import ast,sys; ast.parse(open(sys.argv[1]).read())' "$1"
}

DIR="${XDG_DATA_HOME:-$HOME/.local/share}/omarchy-connector"
CONF="${XDG_CONFIG_HOME:-$HOME/.config}/omarchy-connector"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/omarchy-connector.service"

MAC=0
case "$(uname -s)" in
	Linux) ;;
	Darwin) MAC=1 ;;
	*) die "The connector is for Linux and macOS (Windows has its own command)." ;;
esac
[ "$(id -u)" -ne 0 ] || die "Run this as your normal user, not with sudo (the connector works as you)."
[ "$MAC" = 1 ] || command -v systemctl >/dev/null || die "systemd is required."
PLIST="$HOME/Library/LaunchAgents/org.myowndatacenter.connector.plist"

if [ "$MAC" = 1 ] && [ "$UNINSTALL" = 1 ]; then
	say "Removing the connector"
	launchctl bootout "gui/$(id -u)/org.myowndatacenter.connector" 2>/dev/null || true
	rm -f "$PLIST"
	rm -rf "$DIR" "$CONF" "${XDG_CACHE_HOME:-$HOME/.cache}/omarchy-connector"
	say "Done. Remove this computer in Machines → Local swarm too, if it's still listed."
	exit 0
fi

if [ "$UNINSTALL" = 1 ]; then
	say "Removing the connector"
	systemctl --user disable --now omarchy-connector.service 2>/dev/null || true
	rm -f "$UNIT"
	systemctl --user daemon-reload 2>/dev/null || true
	rm -rf "$DIR" "$CONF" "${XDG_CACHE_HOME:-$HOME/.cache}/omarchy-connector"
	if ! sudo rm -f /usr/local/libexec/omarchy-connector/helper.py /etc/sudoers.d/omarchy-connector /etc/udev/rules.d/69-omarchy-connector-sleep.rules; then
		warn "The helper, its sudoers rule and the sleep udev rule could not be removed. Run this yourself:"
		printf '  sudo rm -f /usr/local/libexec/omarchy-connector/helper.py /etc/sudoers.d/omarchy-connector /etc/udev/rules.d/69-omarchy-connector-sleep.rules\n' >&2
		printf '  sudo udevadm control --reload\n' >&2
		exit 1
	fi
	sudo udevadm control --reload >/dev/null 2>&1 || true
	say "Done. Remove this computer in Machines → Local swarm too, if it's still listed."
	exit 0
fi

[ -n "$SERVER" ] && [ -n "$CA" ] && [ -n "$TOKEN" ] || die "Use the command from your server: Machines → Local swarm → Add a computer."
case "$SERVER" in https://*) ;; *) die "The server address must start with https://" ;; esac
[[ "$CA" =~ ^[0-9a-f]{64}$ ]] || die "That command looks cut off (the server fingerprint is missing). Copy it again."
[[ "$ALLOW" =~ ^[a-z,]*$ ]] || die "Bad --allow list"
# A Mac can have its terminal, files and power; the rest needs Linux (the connector agrees).
if [ "$MAC" = 1 ]; then
	keep=""
	for a in ${ALLOW//,/ }; do case "$a" in terminal | files | manage) keep="$keep${keep:+,}$a" ;; esac; done
	ALLOW="$keep"
fi
has() { [[ ",$ALLOW," == *",$1,"* ]]; }

if [ "$MAC" = 1 ]; then
	# macOS ships a python3 that asks to install the Command Line Tools the first time.
	if ! python3 -c 'import ssl, sys; sys.exit(sys.version_info < (3, 8))' 2>/dev/null; then
		if command -v brew >/dev/null; then
			say "Installing Python (Homebrew)"
			brew install python >/dev/null || die "Couldn't install Python. Run: brew install python"
		else
			die "Python 3 is needed. Run: xcode-select --install   (or install it from python.org), then run this again."
		fi
	fi
	if has terminal && ! command -v tmux >/dev/null && command -v brew >/dev/null; then
		brew install tmux >/dev/null || warn "Couldn't install tmux (the terminal works without it)."
	fi
fi

# 1. What this computer needs: Python 3, git (for plugins), tmux (for the terminal) and screen sharing (for the desktop).
pm=""
[ "$MAC" = 1 ] && pm=mac
for p in apt-get dnf pacman zypper; do [ "$MAC" = 1 ] && break; command -v "$p" >/dev/null && { pm="$p"; break; }; done
pkgs=()
command -v python3 >/dev/null || case "$pm" in pacman) pkgs+=(python) ;; *) pkgs+=(python3) ;; esac
has manage && ! command -v git >/dev/null && pkgs+=(git)
# tmux keeps the terminal running through connector restarts and updates (it works without, too).
has terminal && ! command -v tmux >/dev/null && pkgs+=(tmux)
if has desktop; then
	command -v x11vnc >/dev/null || pkgs+=(x11vnc)
	command -v wayvnc >/dev/null || pkgs+=(wayvnc)
fi
# Disk tools live in /usr/sbin on Debian, which isn't on a normal user's PATH; the helper looks there too.
sbin() { PATH="$PATH:/usr/local/sbin:/usr/sbin:/sbin" command -v "$1" >/dev/null; }
if has storage; then
	sbin smartctl || pkgs+=(smartmontools)
	sbin mkfs.ext4 || pkgs+=(e2fsprogs)
	sbin mkfs.exfat || pkgs+=(exfatprogs)
	sbin mkfs.btrfs || pkgs+=(btrfs-progs)
	sbin hdparm || pkgs+=(hdparm)
fi
if [ "$USER_ENROLL_ONLY" != 1 ] && [ ${#pkgs[@]} -gt 0 ]; then
	say "Installing ${pkgs[*]} (sudo needed)"
	# One package at a time, so one that a distribution doesn't carry doesn't stop the rest.
	for p in "${pkgs[@]}"; do
		case "$pm" in
			apt-get) as_root apt-get install -y "$p" >/dev/null || warn "Couldn't install $p" ;;
			dnf) as_root dnf install -y "$p" >/dev/null || warn "Couldn't install $p" ;;
			pacman) if command -v omarchy >/dev/null; then omarchy pkg add "$p" || warn "Couldn't install $p"; else as_root pacman -S --needed --noconfirm "$p" >/dev/null || warn "Couldn't install $p"; fi ;;
			zypper) as_root zypper --non-interactive install "$p" >/dev/null || warn "Couldn't install $p" ;;
			mac) ;;
			*) warn "Install $p yourself (no package manager found that I know)" ;;
		esac
	done
fi
command -v python3 >/dev/null || die "Python 3 is needed. Install it, then run this again."

# 2. Trust only your server: fetch its certificate authority and check it against the fingerprint
#    in the command (which came from the server itself, over your own signed-in session).
mkdir -p "$DIR" "$CONF"
chmod 700 "$CONF"
say "Checking your server ($SERVER)"
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
curl -fsSk --max-time 20 "${SERVER%/}/api/tls/ca.crt" -o "$tmp" || die "Couldn't reach $SERVER. Is this computer on the same network (or tailnet) as the server?"
got=$(python3 -c 'import ssl,sys,hashlib; print(hashlib.sha256(ssl.PEM_cert_to_DER_cert(open(sys.argv[1]).read())).hexdigest())' "$tmp") || die "The server didn't send a certificate."
[ "$got" = "$CA" ] || die "That isn't your server (its certificate doesn't match the fingerprint in the command). Nothing was installed."
install -m 600 "$tmp" "$CONF/server-ca.crt"

# A GitHub source is https://raw.githubusercontent.com/<owner>/<repo> and the files are under
# main/connector/. This server serves the same files at <server>/api/connector/<file> when the
# install was copied from a directory curl cannot fetch.
connector_url() {
	local name="$1"
	local base="${SOURCE%/}"
	case "$base" in
		*/api/connector) printf '%s/%s' "$base" "$name" ;;
		*) printf '%s/main/connector/%s' "$base" "$name" ;;
	esac
}
fetch_connector() {
	local url="$1" dest="$2"
	# Match the server literally. An IPv6 address is in brackets, which a glob would treat as a class.
	case "$url" in
		"$SERVER"*) curl -fsSL --cacert "$CONF/server-ca.crt" --max-time 60 "$url" -o "$dest" ;;
		*) curl -fsSL --max-time 60 "$url" -o "$dest" ;;
	esac
}

# 3. The connector itself.
say "Downloading the connector"
fetch_connector "$(connector_url agent.py)" "$DIR/agent.py.new" || die "Couldn't download the connector."
python_ok "$DIR/agent.py.new" || die "The downloaded connector didn't check out."
mv "$DIR/agent.py.new" "$DIR/agent.py"
chmod 700 "$DIR/agent.py"

if has storage && [ "$USER_ENROLL_ONLY" != 1 ]; then
	say "Installing the storage helper"
	fetch_connector "$(connector_url helper.py)" "$tmp.helper.py" || die "Couldn't download the storage helper."
	python_ok "$tmp.helper.py" || die "The downloaded storage helper didn't check out."
	as_root install -D -m 755 "$tmp.helper.py" /usr/local/libexec/omarchy-connector/helper.py || need_password "This computer needs a password to finish installing."
	rm -f "$tmp.helper.py"
	as_root tee /etc/sudoers.d/omarchy-connector >/dev/null <<EOF || need_password "This computer needs a password to finish installing."
${USER} ALL=(root) NOPASSWD: /usr/local/libexec/omarchy-connector/helper.py
EOF
	as_root chmod 440 /etc/sudoers.d/omarchy-connector || need_password "This computer needs a password to finish installing."
fi

# 4. Join, with this one-time code.
say "Joining your server"
name=$(python3 "$DIR/agent.py" enroll "$SERVER" "$TOKEN" "$ALLOW") || die "Joining didn't work (see above)."

# 5. Keep it running, as you, from now on.
if [ "$MAC" = 1 ]; then
	# Escaped for the plist (a home folder may have & or < in its name); launchd's own PATH has no
	# Homebrew, so give it one (from kdegeek's #864).
	xml() { python3 -c 'import sys, xml.sax.saxutils as x; print(x.escape(sys.argv[1]))' "$1"; }
	py=$(xml "$(command -v python3)")
	dir_xml=$(xml "$DIR")
	mkdir -p "$(dirname "$PLIST")" "$DIR/log"
	cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>org.myowndatacenter.connector</string>
	<key>ProgramArguments</key><array><string>$py</string><string>$dir_xml/agent.py</string></array>
	<key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>ThrottleInterval</key><integer>5</integer>
	<key>ProcessType</key><string>Background</string>
	<key>StandardErrorPath</key><string>$dir_xml/log/connector.log</string>
</dict>
</plist>
EOF
	launchctl bootout "gui/$(id -u)/org.myowndatacenter.connector" 2>/dev/null || true
	launchctl bootstrap "gui/$(id -u)" "$PLIST" || die "Couldn't start the connector (launchctl)."
	say "Done. \"$name\" is now in your server's Machines → Local swarm."
	exit 0
fi
# Storage needs sudo to the helper, so NoNewPrivileges stays off only when Storage was allowed.
nnp=""
has storage || nnp="NoNewPrivileges=yes"
mkdir -p "$UNIT_DIR"
cat >"$UNIT" <<EOF
[Unit]
Description=MODC connector (local swarm)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/env python3 $DIR/agent.py
Restart=always
RestartSec=5
$nnp

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now omarchy-connector.service
systemctl --user restart omarchy-connector.service
# Run even while nobody is signed in (so you can still watch it and open a terminal).
if ! loginctl show-user "$USER" -p Linger 2>/dev/null | grep -q 'Linger=yes'; then
	if [ "$USER_ENROLL_ONLY" = 1 ]; then
		warn "It only runs while you're signed in. To keep it running, run: sudo loginctl enable-linger $USER"
	elif noninteractive; then
		sudo -n loginctl enable-linger "$USER" || need_password "This computer needs a password to finish installing."
	else
		sudo loginctl enable-linger "$USER" 2>/dev/null || warn "It only runs while you're signed in. To keep it running, run: sudo loginctl enable-linger $USER"
	fi
fi

say "Done. \"$name\" is now in your server's Machines → Local swarm."
