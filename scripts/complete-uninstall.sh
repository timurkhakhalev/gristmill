#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "This script will stop Gristmill, remove its installed app, and delete its caches, databases, and preferences."
echo "It does not remove files or profiles belonging to other applications or older product names."
read -r -p "Continue with the full Gristmill uninstall? [y/N]: " confirm
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

echo "Stopping running Gristmill/Electron processes..."
pkill -f "Gristmill" 2>/dev/null || true
pkill -f "gristmill" 2>/dev/null || true
pkill -f "Electron Helper.*Gristmill" 2>/dev/null || true

echo "Removing /Applications/Gristmill.app (requires admin)..."
remove_target "/Applications/Gristmill.app"

echo "Purging Gristmill Application Support data..."
remove_target "$HOME/Library/Application Support/Gristmill"
remove_target "$HOME/Library/Application Support/Gristmill-dev"
remove_target "$HOME/Library/Application Support/com.khakhalev.gristmill"

echo "Removing Gristmill caches, logs, and saved state..."
remove_target "$HOME/Library/Caches/Gristmill"
remove_target "$HOME/Library/Caches/com.khakhalev.gristmill"
remove_target "$HOME/Library/Preferences/com.khakhalev.gristmill.plist"
remove_target "$HOME/Library/Logs/Gristmill"
remove_target "$HOME/Library/Saved Application State/com.khakhalev.gristmill.savedState"

echo "Cleaning Gristmill temporary files..."
shopt -s nullglob
for tmp in /tmp/gristmill*; do
  remove_target "$tmp"
done
for crash in "$HOME/Library/Application Support/CrashReporter"/Gristmill_*; do
  remove_target "$crash"
done
shopt -u nullglob

read -r -p "Remove downloaded Gristmill models and caches (~/.cache/gristmill)? [y/N]: " wipe_models
if [[ "$wipe_models" =~ ^[Yy]$ ]]; then
  remove_target "$HOME/.cache/gristmill"
  remove_target "$HOME/Library/Application Support/Gristmill/models"
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
Reset Gristmill approvals if you want a truly fresh start:
  tccutil reset Microphone com.khakhalev.gristmill
  tccutil reset Accessibility com.khakhalev.gristmill
  tccutil reset ScreenCapture com.khakhalev.gristmill

Gristmill uninstall complete. Reboot if you removed permissions, then reinstall or run pnpm scripts on a clean tree.
EOF
