# Login-shell environment for bash (~/.profile) and zsh (~/.zprofile).
# Managed by chezmoi; .chezmoiscripts adds the source line to both profiles.

# Put mise shims on PATH so non-interactive login shells (scripts, `ssh host cmd`,
# agent `bash -lc` tool calls) get mise-managed tools. Those shells never read
# zshrc; interactive shells still run `mise activate` there, and its paths take
# precedence over the shims. The `--shims` output is plain POSIX `export PATH=`,
# so the bash flavor works for zsh too.
_mise="$(command -v mise 2>/dev/null || printf '%s' "$HOME/.local/bin/mise")"
if [ -x "$_mise" ]; then
  eval "$("$_mise" activate bash --shims)"
fi
unset _mise
