import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

const EXEC_TIMEOUT_MS = 120_000

type ExecResult = Awaited<ReturnType<ExtensionAPI["exec"]>>

function formatFailure(command: string, result: ExecResult): string {
  const stderr = result.stderr?.trim()
  const stdout = result.stdout?.trim()
  return `${command} failed with exit ${result.code}${stderr ? `:\n${stderr}` : stdout ? `:\n${stdout}` : ""}`
}

async function git(pi: ExtensionAPI, cwd: string, args: string[], timeout = EXEC_TIMEOUT_MS) {
  return pi.exec("git", args, { cwd, timeout })
}

function stripYesFlag(args: string): { yes: boolean; message: string } {
  const parts = args.trim().split(/\s+/).filter(Boolean)
  const kept: string[] = []
  let yes = false
  for (const part of parts) {
    if (part === "-y" || part === "--yes") yes = true
    else kept.push(part)
  }
  return { yes, message: kept.join(" ") }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("yeet", {
    description: "Stage changed files, commit them, then push to the active git remote when available. Usage: /yeet [-y|--yes] [commit message]",
    handler: async (rawArgs, ctx) => {
      await ctx.waitForIdle()

      const cwd = ctx.cwd
      const { yes, message: argMessage } = stripYesFlag(rawArgs ?? "")

      const repoCheck = await git(pi, cwd, ["rev-parse", "--is-inside-work-tree"], 10_000)
      if (repoCheck.code !== 0 || repoCheck.stdout.trim() !== "true") {
        ctx.ui.notify("/yeet: not inside a git work tree", "error")
        return
      }

      const statusResult = await git(pi, cwd, ["status", "--porcelain"], 10_000)
      if (statusResult.code !== 0) {
        ctx.ui.notify(formatFailure("git status", statusResult), "error")
        return
      }

      const status = statusResult.stdout.trim()
      if (!status) {
        ctx.ui.notify("/yeet: nothing to commit", "info")
        return
      }

      if (ctx.hasUI && !yes) {
        const ok = await ctx.ui.confirm("/yeet", `Stage and commit these changes?\n\n${status}`)
        if (!ok) {
          ctx.ui.notify("/yeet: cancelled", "info")
          return
        }
      }

      let commitMessage = argMessage.trim()
      if (!commitMessage && ctx.hasUI) {
        const input = await ctx.ui.input("Commit message:", "yeet")
        if (input === undefined) {
          ctx.ui.notify("/yeet: cancelled", "info")
          return
        }
        commitMessage = input.trim()
      }
      if (!commitMessage) commitMessage = "yeet"

      ctx.ui.notify("/yeet: staging changes...", "info")
      const addResult = await git(pi, cwd, ["add", "-A"])
      if (addResult.code !== 0) {
        ctx.ui.notify(formatFailure("git add -A", addResult), "error")
        return
      }

      const stagedCheck = await git(pi, cwd, ["diff", "--cached", "--quiet"], 10_000)
      if (stagedCheck.code === 0) {
        ctx.ui.notify("/yeet: no staged changes after git add", "info")
        return
      }
      if (stagedCheck.code !== 1) {
        ctx.ui.notify(formatFailure("git diff --cached --quiet", stagedCheck), "error")
        return
      }

      ctx.ui.notify(`/yeet: committing: ${commitMessage}`, "info")
      const commitResult = await git(pi, cwd, ["commit", "-m", commitMessage])
      if (commitResult.code !== 0) {
        ctx.ui.notify(formatFailure("git commit", commitResult), "error")
        return
      }

      const upstream = await git(pi, cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], 10_000)
      if (upstream.code === 0 && upstream.stdout.trim()) {
        ctx.ui.notify(`/yeet: pushing to ${upstream.stdout.trim()}...`, "info")
        const pushResult = await git(pi, cwd, ["push"])
        if (pushResult.code !== 0) ctx.ui.notify(formatFailure("git push", pushResult), "error")
        else ctx.ui.notify("/yeet: committed and pushed", "info")
        return
      }

      const remotesResult = await git(pi, cwd, ["remote"], 10_000)
      const remotes = remotesResult.code === 0 ? remotesResult.stdout.split(/\r?\n/).map((r) => r.trim()).filter(Boolean) : []
      const branchResult = await git(pi, cwd, ["branch", "--show-current"], 10_000)
      const branch = branchResult.stdout.trim()

      if (remotes.length === 1 && branch) {
        ctx.ui.notify(`/yeet: pushing HEAD to ${remotes[0]} and setting upstream...`, "info")
        const pushResult = await git(pi, cwd, ["push", "-u", remotes[0], "HEAD"])
        if (pushResult.code !== 0) ctx.ui.notify(formatFailure(`git push -u ${remotes[0]} HEAD`, pushResult), "error")
        else ctx.ui.notify("/yeet: committed and pushed", "info")
        return
      }

      if (remotes.length === 0) {
        ctx.ui.notify("/yeet: committed; no git remote configured, so not pushed", "info")
      } else {
        ctx.ui.notify("/yeet: committed; no upstream and multiple remotes, so not pushed", "warning")
      }
    },
  })
}
