#!/usr/bin/env bash
#
# Konsey installer for macOS.
#
# Downloads the latest Konsey.app, installs it, and removes the quarantine
# flag so the app opens without the "unidentified developer" warning
# (curl-downloaded files are not quarantined the way browser downloads are).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/ardakie/konsey/main/site/install.sh | bash

set -euo pipefail

APP_NAME="Konsey"
RELEASES_BASE="https://github.com/ardakie/konsey/releases/latest/download"

log() { printf '==> %s\n' "$1"; }
err() { printf 'error: %s\n' "$1" >&2; }

if [ "$(uname -s)" != "Darwin" ]; then
  err "this installer only supports macOS. On Windows, download the installer from:"
  err "  ${RELEASES_BASE}/Konsey-windows-x64-setup.exe"
  exit 1
fi

case "$(uname -m)" in
  arm64)
    ARCH="arm64"
    ;;
  x86_64)
    ARCH="x64"
    ;;
  *)
    err "unsupported architecture: $(uname -m)"
    exit 1
    ;;
esac

ZIP_NAME="Konsey-mac-${ARCH}.zip"
ZIP_URL="${RELEASES_BASE}/${ZIP_NAME}"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/konsey-install.XXXXXX")"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

log "downloading ${ZIP_NAME}..."
curl -fL --progress-bar -o "${TMP_DIR}/${ZIP_NAME}" "$ZIP_URL"

log "quitting any running copy of ${APP_NAME}..."
osascript -e "quit app \"${APP_NAME}\"" >/dev/null 2>&1 || true

if [ -w "/Applications" ]; then
  INSTALL_DIR="/Applications"
else
  INSTALL_DIR="${HOME}/Applications"
  mkdir -p "$INSTALL_DIR"
fi

TARGET="${INSTALL_DIR}/${APP_NAME}.app"

if [ -d "$TARGET" ]; then
  log "removing previous install at ${TARGET}..."
  rm -rf "$TARGET"
fi

log "extracting to ${INSTALL_DIR}..."
ditto -x -k "${TMP_DIR}/${ZIP_NAME}" "$INSTALL_DIR"

log "removing quarantine flag..."
xattr -dr com.apple.quarantine "$TARGET" >/dev/null 2>&1 || true

log "installed ${APP_NAME} to ${TARGET}"

log "opening ${APP_NAME}..."
open "$TARGET"
