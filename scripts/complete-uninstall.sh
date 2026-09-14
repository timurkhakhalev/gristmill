#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "This script will stop OpenHercules, remove its installed app, and delete its caches, databases, and preferences."
echo "It does not remove files or profiles belonging to other applications or older product names."
read -r -p "Continue with the full OpenHercules uninstall? [y/N]: " confirm
if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 0
fi

remove_target() {
  local target="$1"
  if [[ -e "$target" ]]; then
    echo "Removing $target"
    rm -rf "$target" 2>/dev/null || sudo rm -rf "$target"
  fi
}

echo "Stopping running OpenHercules/Electron processes..."
pkill -f "OpenHercules" 2>/dev/null || true
pkill -f "open-hercules" 2>/dev/null || true
pkill -f "Electron Helper.*OpenHercules" 2>/dev/null || true

echo "Removing /Applications/OpenHercules.app (requires admin)..."
remove_target "/Applications/OpenHercules.app"

echo "Purging OpenHercules Application Support data..."
remove_target "$HOME/Library/Application Support/OpenHercules"
remove_target "$HOME/Library/Application Support/OpenHercules-dev"
remove_target "$HOME/Library/Application Support/com.openhercules.desktop"

echo "Removing OpenHercules caches, logs, and saved state..."
remove_target "$HOME/Library/Caches/OpenHercules"
remove_target "$HOME/Library/Caches/com.openhercules.desktop"
remove_target "$HOME/Library/Preferences/com.openhercules.desktop.plist"
remove_target "$HOME/Library/Logs/OpenHercules"
remove_target "$HOME/Library/Saved Application State/com.openhercules.desktop.savedState"

echo "Cleaning OpenHercules temporary files..."
shopt -s nullglob
for tmp in /tmp/openhercules*; do
  remove_target "$tmp"
done
for crash in "$HOME/Library/Application Support/CrashReporter"/OpenHercules_*; do
  remove_target "$crash"
done
shopt -u nullglob

read -r -p "Remove downloaded OpenHercules models and caches (~/.cache/openhercules)? [y/N]: " wipe_models
if [[ "$wipe_models" =~ ^[Yy]$ ]]; then
  remove_target "$HOME/.cache/openhercules"
  remove_target "$HOME/Library/Application Support/OpenHercules/models"
fi

ENV_FILE="$PROJECT_ROOT/.env"
if [[ -f "$ENV_FILE" ]]; then
  read -r -p "Remove the local environment file at $ENV_FILE? [y/N]: " wipe_env
  if [[ "$wipe_env" =~ ^[Yy]$ ]]; then
    echo "Removing $ENV_FILE"
    rm -f "$ENV_FILE"
  fi
fi

cat <<'EOF'
macOS keeps microphone, screen recording, and accessibility approvals even after files are removed.
Reset OpenHercules approvals if you want a truly fresh start:
  tccutil reset Microphone com.openhercules.desktop
  tccutil reset Accessibility com.openhercules.desktop
  tccutil reset ScreenCapture com.openhercules.desktop

OpenHercules uninstall complete. Reboot if you removed permissions, then reinstall or run pnpm scripts on a clean tree.
EOF
