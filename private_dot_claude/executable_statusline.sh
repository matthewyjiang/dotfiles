#!/usr/bin/env bash
# Claude Code status line, one line:
# cwd (~ collapsed) + git branch on the left,
# tokens / context % / cost / model / effort flush right.
#
# This runs on every render, so it stays to one jq call and avoids touching
# the terminal device.

# Character counting below assumes UTF-8, or the · separators pad as 2 chars each.
case "${LC_ALL:-${LC_CTYPE:-$LANG}}" in
  *UTF-8*|*utf8*) ;;
  *) export LC_ALL=C.UTF-8 ;;
esac

# One jq pass, tab-separated, rather than a process per field.
IFS=$'\t' read -r cwd tokens window cost model effort < <(
  jq -r '[
    (.workspace.current_dir // .cwd // ""),
    (.context_window.total_input_tokens // ""),
    (.context_window.context_window_size // ""),
    (.cost.total_cost_usd // ""),
    (.model.display_name // ""),
    (.effort.level // "")
  ] | @tsv' 2>/dev/null
)

[ -z "$cwd" ] && cwd="$PWD"

# --- line 1: directory + branch ---

case "$cwd" in
  "$HOME") disp_cwd="~" ;;
  "$HOME"/*) disp_cwd="~${cwd#"$HOME"}" ;;
  *) disp_cwd="$cwd" ;;
esac

branch="$(git --no-optional-locks -C "$cwd" rev-parse --abbrev-ref HEAD 2>/dev/null)"
[ "$branch" = "HEAD" ] && branch="$(git --no-optional-locks -C "$cwd" rev-parse --short HEAD 2>/dev/null)"

left="$disp_cwd"
[ -n "$branch" ] && left="$disp_cwd ($branch)"

# --- right: tokens, context percent, cost, model, effort ---

right=""
if [ -n "$tokens" ]; then
  right="$(awk -v t="$tokens" -v w="$window" -v c="$cost" 'BEGIN {
    printf "%.1fK", t/1000
    if (w > 0) printf " (%.1f%%)", 100*t/w
    if (c != "") printf " \xc2\xb7 $%.3f", c
  }')"
fi
[ -n "$model" ] && right="${right:+$right · }$model"
[ -n "$effort" ] && right="${right:+$right · }$effort"

# --- compose, right-aligning the second group ---

# Claude Code exports COLUMNS, so there is no need to open the terminal device.
cols="${COLUMNS:-80}"
case "$cols" in ''|*[!0-9]*) cols=80 ;; esac

# Claude Code indents and boxes the status line, so a line exactly `cols` wide
# overflows and gets truncated with an ellipsis. Lower this to sit closer to the
# right edge, raise it if the effort level still gets clipped.
cols=$(( cols - ${STATUSLINE_MARGIN:-6} ))

# When the two halves do not both fit, trim the path rather than let the
# terminal clip the right-hand group.
avail=$(( cols - ${#right} - 1 ))
if [ "$avail" -lt 1 ]; then
  left=""
elif [ ${#left} -gt "$avail" ]; then
  left="…${left: -$(( avail - 1 ))}"
fi

gap=$(( cols - ${#left} - ${#right} ))
if [ -z "$left" ]; then
  gap=0
elif [ "$gap" -lt 1 ]; then
  gap=1
fi

printf '\033[2m%s%*s%s\033[0m\n' "$left" "$gap" '' "$right"
