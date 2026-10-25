#!/usr/bin/env bash
# One-command install for the Legion connector.
# Usage: ./install.sh <pairing-code> [hub-ws-url]
#
# What this does:
#   1. copies this package to /opt/legion-connector
#   2. npm ci && npm run build && npm prune --omit=dev (tsc is a devDependency)
#   3. writes ~/.legion-connector/connector.toml from the example, if absent
#   4. runs `legion-connector pair <code>` to exchange the code for a refresh token
#   5. installs + enables the systemd unit so the connector survives reboots
#
# Safe to re-run: install steps are idempotent, pairing is not (a used code
# fails with 409 — that's expected on a re-run after a successful pair).

set -euo pipefail

PAIRING_CODE="${1:?usage: install.sh <pairing-code> [hub-ws-url]}"
HUB_URL="${2:-}"
INSTALL_DIR="/opt/legion-connector"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "node >= 18 is required and was not found on PATH" >&2
  exit 1
fi

echo "==> Installing connector package to ${INSTALL_DIR}"
sudo mkdir -p "$INSTALL_DIR"
sudo cp -r "$SCRIPT_DIR"/* "$INSTALL_DIR"/
sudo chown -R "$(whoami)" "$INSTALL_DIR"

echo "==> Installing dependencies"
(cd "$INSTALL_DIR" && npm ci && npm run build && npm prune --omit=dev)

CONFIG_DIR="$HOME/.legion-connector"
CONFIG_FILE="$CONFIG_DIR/connector.toml"
mkdir -p "$CONFIG_DIR"
if [ ! -f "$CONFIG_FILE" ]; then
  echo "==> Writing default config to ${CONFIG_FILE} (edit work_dirs before first real task!)"
  cp "$INSTALL_DIR/connector.example.toml" "$CONFIG_FILE"
fi

PAIR_ARGS=("pair" "$PAIRING_CODE")
if [ -n "$HUB_URL" ]; then
  PAIR_ARGS+=("--hub-url" "$HUB_URL")
fi

echo "==> Pairing"
(cd "$INSTALL_DIR" && node dist/index.js "${PAIR_ARGS[@]}")

if command -v systemctl >/dev/null 2>&1; then
  echo "==> Installing systemd unit (runs as $(whoami))"
  sed "s/%i/$(whoami)/" "$INSTALL_DIR/systemd/legion-connector.service" \
    | sudo tee /etc/systemd/system/legion-connector.service >/dev/null
  sudo systemctl daemon-reload
  sudo systemctl enable --now legion-connector
  echo "==> Done. Check status with: systemctl status legion-connector"
else
  echo "==> systemd not found — start manually with: node ${INSTALL_DIR}/dist/index.js start"
fi
