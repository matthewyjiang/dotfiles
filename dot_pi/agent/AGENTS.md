# AGENTS.md

When creating or editing GitHub issue and PR bodies with the `gh` CLI, use `--body-file` with a temporary Markdown file or a heredoc-generated file. Do not pass Markdown bodies as quoted strings with escaped newlines, because that can produce literal `\n` text in GitHub. Never use em-dashes in pr title, description, or comments. In PR title and body, format well and be professional. In PR conversations with other people, sound casual, use all lowercase to show as my typing style.

## Code judo

Practice code judo: use the natural mechanics of the existing system instead of fighting them. Prefer small, well-placed changes that remove complexity over patches that add compensating complexity. Make state transitions explicit and predictable. Favor built-in platform/framework/language capabilities over custom lifecycle, timing, or orchestration logic when they fit. Avoid clever hacks that need future explanation; aim for solutions that feel obvious in hindsight.

For SwiftUI work, prefer intended native containers and modifiers (`NavigationStack`, `NavigationSplitView`, `List`, `Form`, `.searchable`, toolbars, selection bindings) over custom geometry, fixed-width panes, safe-area compensations, or gesture/state workarounds. If a workaround seems necessary, first reassess the view hierarchy and state ownership.

## Build and test output hygiene

When running builds, tests, or other commands with verbose output, redirect logs to a temporary file and inspect/search the file for success, failure, warnings, or relevant excerpts. Do not stream or paste full build logs into the conversation context; summarize results concisely and include the temp log path when useful.
