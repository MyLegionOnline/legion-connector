#!/usr/bin/env bash
# One-command install for the Legion connector.
# Usage: ./install.sh <pairing-code> [hub-ws-url] [--user NAME] [--uid N]
#
# What this does:
#   1. creates the system user the connector runs as (default legion-agent,
#      uid 59999), unless it exists — never root, never a uid other processes use
#   2. copies this package to /opt/legion-connector, owned by root, and builds
#      it there: npm ci && npm run build && npm prune --omit=dev
#   3. writes ~<user>/.legion-connector/connector.toml from the example, if
#      absent, with work_dirs set to ~<user>/work
#   4. runs `legion-connector pair <code>` as that user, so the refresh token
#      lands in its home
#   5. installs + enables the systemd unit, running as that user
#
# --user NAME  the account to run as (created if missing; root is refused)
# --uid N      the uid for a new account (default 59999; must be free)
#
# Linux with systemd: the dedicated user is created with useradd. Elsewhere
# the connector is built and paired for the current user and started by hand.
#
# Safe to re-run: install steps are idempotent, pairing is not (a used code
# fails with 409 — that's expected on a re-run after a successful pair).

set -euo pipefail

usage() { sed -n '3p' "$0" | sed 's/^# //'; }

PAIRING_CODE=""
HUB_URL=""
AGENT_USER="legion-agent"
AGENT_UID="59999"
while [ $# -gt 0 ]; do
  case "$1" in
    --user) AGENT_USER="${2:?--user needs a name}"; shift 2 ;;
    --uid) AGENT_UID="${2:?--uid needs a number}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
    *)
      if [ -z "$PAIRING_CODE" ]; then PAIRING_CODE="$1"
      elif [ -z "$HUB_URL" ]; then HUB_URL="$1"
      else echo "Unexpected argument: $1" >&2; usage >&2; exit 1
      fi
      shift ;;
  esac
done
[ -n "$PAIRING_CODE" ] || { usage >&2; exit 1; }
case "$AGENT_UID" in ''|*[!0-9]*) echo "--uid must be a number" >&2; exit 1 ;; esac

INSTALL_DIR="/opt/legion-connector"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUDO=""
[ "$(id -u)" -eq 0 ] || SUDO="sudo"

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "node >= 18 is required and was not found on PATH" >&2
  exit 1
fi

DEDICATED=0
if command -v systemctl >/dev/null 2>&1 && command -v useradd >/dev/null 2>&1; then
  DEDICATED=1
fi

# ── 1. The user the connector runs as ─────────────────────────────────────
if [ "$DEDICATED" = "1" ]; then
  if [ "$AGENT_USER" = "root" ]; then
    echo "The connector does not run as root: OpenCode would act with full rights. Pick another --user." >&2
    exit 1
  fi
  if id "$AGENT_USER" >/dev/null 2>&1; then
    AGENT_UID="$(id -u "$AGENT_USER")"
    [ "$AGENT_UID" -ne 0 ] || { echo "$AGENT_USER has uid 0; pick another --user." >&2; exit 1; }
    echo "==> Running as the existing user ${AGENT_USER} (uid ${AGENT_UID})"
    # Other processes under the same uid could be read and signalled by the agent.
    OTHERS="$(ps -eo uid=,comm= | awk -v u="$AGENT_UID" '$1 == u && $2 !~ /^(node|opencode|bash|sh|sudo)$/ { print $2 }' | sort -u | tr '\n' ' ')"
    [ -z "$OTHERS" ] || echo "warning: other processes run under uid ${AGENT_UID}: ${OTHERS}- the agent can read their environment. Use a uid of its own."
  else
    if getent passwd "$AGENT_UID" >/dev/null; then
      echo "uid ${AGENT_UID} already belongs to $(getent passwd "$AGENT_UID" | cut -d: -f1); pass a free one with --uid." >&2
      exit 1
    fi
    if ps -eo uid= | awk -v u="$AGENT_UID" '$1 == u { found = 1 } END { exit !found }'; then
      echo "Processes already run under uid ${AGENT_UID} (containers, most likely); pass a free one with --uid." >&2
      exit 1
    fi
    echo "==> Creating the system user ${AGENT_USER} (uid ${AGENT_UID})"
    $SUDO useradd --system --uid "$AGENT_UID" --user-group --create-home --shell /bin/bash "$AGENT_USER"
  fi
  AGENT_HOME="$(getent passwd "$AGENT_USER" | cut -d: -f6)"
  if command -v sudo >/dev/null 2>&1; then
    as_agent() { sudo -u "$AGENT_USER" -H "$@"; }
  else
    as_agent() { su -s /bin/sh "$AGENT_USER" -c "cd ~ && $(printf '%q ' "$@")"; }
  fi
  as_agent sh -c 'command -v opencode' >/dev/null 2>&1 \
    || echo "warning: ${AGENT_USER} does not find opencode on its PATH; install OpenCode system-wide (for example in /usr/local/bin)."
else
  AGENT_USER="$(whoami)"
  AGENT_HOME="$HOME"
  as_agent() { "$@"; }
  echo "warning: no systemd/useradd here; the connector is set up for ${AGENT_USER}. Run it under a dedicated unprivileged user (see README, Safety)."
fi

# ── 2. The package, owned by root: the agent may not change its own connector ──
echo "==> Installing connector package to ${INSTALL_DIR}"
$SUDO mkdir -p "$INSTALL_DIR"
$SUDO cp -r "$SCRIPT_DIR"/* "$INSTALL_DIR"/
$SUDO chown -R "$(id -un)" "$INSTALL_DIR"

echo "==> Installing dependencies"
(cd "$INSTALL_DIR" && npm ci && npm run build && npm prune --omit=dev)
if [ "$DEDICATED" = "1" ]; then
  $SUDO chown -R root:root "$INSTALL_DIR"
  $SUDO chmod -R go-w,a+rX "$INSTALL_DIR"
fi

# ── 3. Config in the agent's home ─────────────────────────────────────────
CONFIG_DIR="$AGENT_HOME/.legion-connector"
CONFIG_FILE="$CONFIG_DIR/connector.toml"
WORK_DIR="$AGENT_HOME/work"
as_agent mkdir -p "$CONFIG_DIR" "$WORK_DIR"
as_agent chmod 700 "$CONFIG_DIR"
if ! as_agent test -f "$CONFIG_FILE"; then
  echo "==> Writing default config to ${CONFIG_FILE} (work_dirs = [\"${WORK_DIR}\"])"
  sed "s|^work_dirs = .*|work_dirs = [\"${WORK_DIR}\"]|" "$INSTALL_DIR/connector.example.toml" \
    | as_agent tee "$CONFIG_FILE" >/dev/null
fi

# ── 4. Pairing, as the agent ──────────────────────────────────────────────
PAIR_ARGS=("pair" "$PAIRING_CODE")
if [ -n "$HUB_URL" ]; then
  PAIR_ARGS+=("--hub-url" "$HUB_URL")
fi
echo "==> Pairing"
(cd / && as_agent "$NODE_BIN" "$INSTALL_DIR/dist/index.js" "${PAIR_ARGS[@]}")

# ── 5. systemd ────────────────────────────────────────────────────────────
if command -v systemctl >/dev/null 2>&1; then
  echo "==> Installing systemd unit (runs as ${AGENT_USER})"
  sed -e "s|%i|${AGENT_USER}|" -e "s|/usr/bin/node|${NODE_BIN}|" "$INSTALL_DIR/systemd/legion-connector.service" \
    | $SUDO tee /etc/systemd/system/legion-connector.service >/dev/null
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable --now legion-connector
  echo "==> Done. Check status with: systemctl status legion-connector"
else
  echo "==> systemd not found — start manually with: node ${INSTALL_DIR}/dist/index.js start"
fi

cat <<EOF

Next, as ${AGENT_USER}:
  - sign OpenCode in to a model provider (OpenCode keeps it per user):
      sudo -iu ${AGENT_USER} opencode auth login
  - put the code the agent works on under ${WORK_DIR} (or list other
    directories it may use in work_dirs of ${CONFIG_FILE}) and give
    ${AGENT_USER} access to them; copy opencode.example.json and
    AGENTS.example.md there (see README, Safety).
EOF
