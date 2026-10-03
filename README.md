# dotfiles

This repository contains my personal dotfiles, managed with [chezmoi](https://www.chezmoi.io/).

## What is chezmoi?

`chezmoi` is a dotfile manager that helps keep configuration files versioned, organized, and synced across machines.

## Common commands

- Initialize and apply from this repo:

```bash
chezmoi init --apply git@github.com:matthewyjiang/dotfiles.git
```

- See pending changes:

```bash
chezmoi diff
```

- Apply local changes:

```bash
chezmoi apply
```

## Notes

- Files in this repo map to locations in your home directory when applied with `chezmoi`.
- Edit through `chezmoi` and then apply changes to keep everything in sync.
- Dev tools (starship, zoxide, fzf, eza, bat, vivid, neovim, fastfetch, gh) are managed by [mise](https://mise.jdx.dev/) and declared in `dot_config/mise/conf.d/dotfiles.toml`. `chezmoi apply` bootstraps mise into `~/.local/bin` if needed and runs `mise install` whenever that file changes. Personal extras still go in `~/.config/mise/config.toml` via `mise use -g`.
- Login shells (bash `~/.profile`, zsh `~/.zprofile`) source `~/.config/sh/login.sh`, which puts mise shims on `PATH` so non-interactive shells (scripts, agent `bash -lc` calls) see mise tools too.
- `zsh-syntax-highlighting` is cloned by chezmoi into `~/.local/share/zsh-syntax-highlighting` (see `.chezmoiexternal.toml`).
