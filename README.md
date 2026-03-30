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
