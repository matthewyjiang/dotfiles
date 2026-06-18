#!/bin/sh
set -eu

zshrc="$HOME/.zshrc"
literal_source_line='source "$HOME/.config/zsh/zshrc"'
expanded_source_line="source \"$HOME/.config/zsh/zshrc\""

# If ~/.zshrc already sources the managed config, do not add it again.
if [ -f "$zshrc" ] && { grep -Fq "$literal_source_line" "$zshrc" || grep -Fq "$expanded_source_line" "$zshrc"; }; then
  exit 0
fi

tmp="$(mktemp)"
{
  printf '%s\n' '# Load chezmoi-managed interactive config first.'
  printf '%s\n' 'if [ -f "$HOME/.config/zsh/zshrc" ]; then'
  printf '%s\n' '  source "$HOME/.config/zsh/zshrc"'
  printf '%s\n' 'fi'
  printf '\n'
  if [ -f "$zshrc" ]; then
    cat "$zshrc"
  fi
} > "$tmp"

mv "$tmp" "$zshrc"
