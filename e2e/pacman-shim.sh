#!/bin/sh
# Stands in for pacman on GitHub's Ubuntu runner, so the real helper (which calls pacman, as on
# Omarchy) can install and remove the real Tailscale package from Tailscale's apt repository.
pkg=""
for a in "$@"; do case "$a" in -*) ;; *) pkg="$a" ;; esac; done
case "$1" in
  -Q)
    if dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q "install ok installed"; then
      echo "$pkg $(dpkg-query -W -f='${Version}' "$pkg")"
    else
      echo "error: package '$pkg' was not found" >&2; exit 1
    fi ;;
  -S) DEBIAN_FRONTEND=noninteractive apt-get install -y -q "$pkg" ;;
  -Rns) DEBIAN_FRONTEND=noninteractive apt-get purge -y -q "$pkg" ;;
  *) echo "pacman shim: unsupported $*" >&2; exit 2 ;;
esac
