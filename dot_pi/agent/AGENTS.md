# AGENTS.md

On this machine, use the `ubuntu` distrobox to run shell commands when working with ROS 2.

When creating or editing GitHub issue and PR bodies with the `gh` CLI, use `--body-file` with a temporary Markdown file or a heredoc-generated file. Do not pass Markdown bodies as quoted strings with escaped newlines, because that can produce literal `\n` text in GitHub.

## Code judo

Practice code judo: use the natural mechanics of the existing system instead of fighting them. Prefer small, well-placed changes that remove complexity over patches that add compensating complexity. Make state transitions explicit and predictable. Favor built-in platform/framework/language capabilities over custom lifecycle, timing, or orchestration logic when they fit. Avoid clever hacks that need future explanation; aim for solutions that feel obvious in hindsight.
