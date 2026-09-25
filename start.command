#!/bin/bash
# SHDW Unstake launcher for macOS (and Linux).
# Installs dependencies on the first run, then starts the app.
cd "$(dirname "$0")" || exit 1

# Finder-launched shells may not see Homebrew / nvm installs
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed."
  echo "The download page will open now. Install the LTS version, then run start.command again."
  (open "https://nodejs.org/" 2>/dev/null || xdg-open "https://nodejs.org/" 2>/dev/null) &
  read -r -p "Press Enter to close..."
  exit 1
fi

if [ ! -f "node_modules/@solana/web3.js/package.json" ]; then
  echo "First run: installing components, this takes 1-2 minutes..."
  if ! npm install --no-audit --no-fund --loglevel=error; then
    echo "Could not install components. Check your internet connection and try again."
    read -r -p "Press Enter to close..."
    exit 1
  fi
fi

node src/server.mjs
