# AGENTS.md

# General Guidelines

Never use the em-dash, use plain dashes instead. Never manually modify CHANGELOG.md files or files marked as auto-generated.

Prioritize quality, simplicity, robustness, scalability, and long term maintainability over development cost. For bug fixes, first reproduce the issue in an E2E setting as close as possible to the user path. Fix obvious adjacent issues when encountered, including lint failures, test failures, and test flakiness.

# Github CLI

When creating or editing GitHub issue and PR bodies with the `gh` CLI, use `--body-file` with a temporary Markdown file or a heredoc-generated file. Do not pass Markdown bodies as quoted strings with escaped newlines, because that can produce literal `\n` text in GitHub. `gh` CLI is authenticated on this machine.

In PR titles and bodies, format well and be professional. In PR conversations with other people, sound casual, use all lowercase to show as my typing style.

## Code judo

Use the natural mechanics of the existing system instead of fighting them. Prefer small, well-placed changes, explicit state transitions, and built-in platform or framework capabilities over compensating complexity, custom lifecycle logic, timing hacks, or manual orchestration. Avoid clever workarounds that need future explanation.

For UI work, prefer intended containers, navigation models, state bindings, layout primitives, and accessibility features over custom geometry, fixed sizing, safe-area compensations, gesture workarounds, or manual state orchestration. If a workaround seems necessary, first reassess the view hierarchy, ownership boundaries, and available native patterns.

## Build and test output hygiene

When running builds, tests, or other verbose commands, redirect logs to a temporary file and inspect or search it for success, failure, warnings, and relevant excerpts. Do not stream or paste full logs into the conversation context; summarize results concisely and include the temp log path when useful.

## Web Search

Search the web for things that you are unsure about, such as external apis. 
