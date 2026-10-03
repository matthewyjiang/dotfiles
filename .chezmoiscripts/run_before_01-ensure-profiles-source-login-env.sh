#!/bin/sh
set -eu

# Make bash and zsh login shells source the chezmoi-managed login environment.
# Appends one line to ~/.profile and ~/.zprofile (creating them if missing).
line='if [ -f "$HOME/.config/sh/login.sh" ]; then . "$HOME/.config/sh/login.sh"; fi'

for profile in "$HOME/.profile" "$HOME/.zprofile"; do
  if [ -f "$profile" ] && grep -Fqx "$line" "$profile"; then
    continue
  fi
  printf '\n# Load chezmoi-managed login environment.\n%s\n' "$line" >> "$profile"
done
