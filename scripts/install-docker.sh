#!/usr/bin/env bash
#
# Install Docker Engine and the Compose plugin from Docker's own repository, on
# Debian or Raspberry Pi OS.
#
# Docker's repository rather than Debian's `docker.io` package, for one reason
# that matters: `docker.io` ships no Compose plugin, and Tulip's entire security
# posture — the internal network, the read-only mounts, the capability drops —
# is expressed in docker-compose.yml.
#
# The user is deliberately NOT added to the `docker` group. Membership of that
# group is equivalent to root on this host, and Tulip's whole argument is about
# not handing out more privilege than a job needs. Use sudo.

set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  SUDO="sudo"
fi

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  echo "Docker and the Compose plugin are already installed:"
  docker --version
  docker compose version
  exit 0
fi

. /etc/os-release
CODENAME=${VERSION_CODENAME:?cannot determine the Debian release}
ARCH=$(dpkg --print-architecture)

echo "Installing Docker for ${ID} ${CODENAME} (${ARCH})"

$SUDO apt-get update
$SUDO apt-get install -y --no-install-recommends ca-certificates curl gnupg

$SUDO install -m 0755 -d /etc/apt/keyrings
curl -fsSL "https://download.docker.com/linux/debian/gpg" \
  | $SUDO gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
$SUDO chmod a+r /etc/apt/keyrings/docker.gpg

echo "deb [arch=${ARCH} signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian ${CODENAME} stable" \
  | $SUDO tee /etc/apt/sources.list.d/docker.list >/dev/null

$SUDO apt-get update
$SUDO apt-get install -y --no-install-recommends \
  docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

$SUDO systemctl enable --now docker

echo
docker --version
docker compose version
echo
echo "Done. Run Tulip with sudo, or add yourself to the docker group only if you"
echo "accept that this is equivalent to granting root on this machine."
