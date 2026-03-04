#!/bin/bash
# frog installer - creates symlink in ~/.local/bin
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FROG="$SCRIPT_DIR/frog"
DEST="${HOME}/.local/bin/frog"

if [ ! -f "$FROG" ]; then
  echo "Error: frog not found in $SCRIPT_DIR"
  exit 1
fi

mkdir -p "${HOME}/.local/bin"
ln -sf "$FROG" "$DEST"
chmod +x "$FROG"

echo "Installed: $DEST -> $FROG"

# Check if ~/.local/bin is in PATH
if ! echo "$PATH" | tr ':' '\n' | grep -q "${HOME}/.local/bin"; then
  echo ""
  echo "Warning: ~/.local/bin is not in PATH"
  echo "Add this to your ~/.bashrc or ~/.zshrc:"
  echo '  export PATH="$HOME/.local/bin:$PATH"'
fi
