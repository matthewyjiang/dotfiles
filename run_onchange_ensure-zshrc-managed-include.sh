#!/bin/sh
set -eu
zshrc="$HOME/.zshrc"
include='[ -f ~/.config/zsh/zshrc.managed ] && source ~/.config/zsh/zshrc.managed'

if [ ! -f "$zshrc" ]; then
  {
    echo '# This file is intentionally a dumping ground for tool installers.'
    echo '# Durable shell config is managed by chezmoi in ~/.config/zsh/zshrc.managed.'
    echo "$include"
    echo
  } > "$zshrc"
  exit 0
fi

if ! grep -Fxq "$include" "$zshrc"; then
  tmp="$(mktemp)"
  {
    echo '# This file is intentionally a dumping ground for tool installers.'
    echo '# Durable shell config is managed by chezmoi in ~/.config/zsh/zshrc.managed.'
    echo "$include"
    echo
    cat "$zshrc"
  } > "$tmp"
  cat "$tmp" > "$zshrc"
  rm -f "$tmp"
fi
