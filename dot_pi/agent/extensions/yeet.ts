import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { complete, type UserMessage } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"

const EXEC_TIMEOUT_MS = 120_000
const DIFF_MAX_CHARS = 24_000
const CONFIG_PATH = join(homedir(), ".pi", "agent", "yeet.json")

const COMMIT_MESSAGE_SYSTEM_PROMPT = `You write concise git commit messages.

Given git status and staged diff, output exactly one commit message:
- Use imperative mood, present tense
- Keep it under 72 characters when possible
- No markdown, quotes, prefixes, explanations, or trailing punctuation
- If there are multiple unrelated changes, summarize the main theme`

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

function readConfiguredCommitModel(): string {
  try {
    if (!existsSync(CONFIG_PATH)) return ""
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as { commitModel?: unknown }
    return typeof parsed.commitModel === "string" ? parsed.commitModel.trim() : ""
  } catch {
    return ""
  }
}

function writeConfiguredCommitModel(commitModel: string) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true })
  writeFileSync(CONFIG_PATH, `${JSON.stringify({ commitModel }, null, 2)}\n`)
}

function resolveCommitMessageModel(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
  const configured = String(pi.getFlag("yeet-commit-model") || readConfiguredCommitModel()).trim()
  if (!configured) return ctx.model

  const slash = configured.indexOf("/")
  if (slash <= 0 || slash === configured.length - 1) return undefined
  return ctx.modelRegistry.find(configured.slice(0, slash), configured.slice(slash + 1))
}

async function generateCommitMessage(pi: ExtensionAPI, ctx: ExtensionCommandContext, cwd: string, status: string): Promise<string | undefined> {
  const model = resolveCommitMessageModel(pi, ctx)
  if (!model) return undefined

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model)
  if (!auth.ok || !auth.apiKey) return undefined

  const diffResult = await git(pi, cwd, ["diff", "--cached", "--stat"], 10_000)
  const patchResult = await git(pi, cwd, ["diff", "--cached"], 30_000)
  if (diffResult.code !== 0 || patchResult.code !== 0) return undefined

  const diff = `${diffResult.stdout.trim()}\n\n${patchResult.stdout.trim()}`.slice(0, DIFF_MAX_CHARS)
  const userMessage: UserMessage = {
    role: "user",
    content: [{ type: "text", text: `Git status:\n${status}\n\nStaged diff:\n${diff}` }],
    timestamp: Date.now(),
  }

  const response = await complete(
    model,
    { systemPrompt: COMMIT_MESSAGE_SYSTEM_PROMPT, messages: [userMessage] },
    { apiKey: auth.apiKey, headers: auth.headers, signal: ctx.signal },
  )

  if (response.stopReason === "aborted") return undefined
  const text = response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join(" ")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .split(/\r?\n/)[0]
    .trim()

  return text || undefined
}

export default function (pi: ExtensionAPI) {
  pi.registerFlag("yeet-commit-model", {
    description: "Model for /yeet generated commit messages, as provider/model-id. Defaults to current model.",
    type: "string",
    default: "",
  })
  pi.registerCommand("yeet-model", {
    description: "Configure the model used by /yeet to generate commit messages. Usage: /yeet-model [provider/model-id|current|clear]",
    handler: async (rawArgs, ctx) => {
      const arg = rawArgs.trim()

      if (arg === "clear") {
        writeConfiguredCommitModel("")
        ctx.ui.notify("/yeet-model: cleared; /yeet will use the current model", "info")
        return
      }

      if (arg === "current") {
        if (!ctx.model) {
          ctx.ui.notify("/yeet-model: no current model selected", "error")
          return
        }
        const value = `${ctx.model.provider}/${ctx.model.id}`
        writeConfiguredCommitModel(value)
        ctx.ui.notify(`/yeet-model: set to ${value}`, "info")
        return
      }

      if (arg) {
        const slash = arg.indexOf("/")
        const model = slash > 0 ? ctx.modelRegistry.find(arg.slice(0, slash), arg.slice(slash + 1)) : undefined
        if (!model) {
          ctx.ui.notify(`/yeet-model: model not found: ${arg}`, "error")
          return
        }
        writeConfiguredCommitModel(`${model.provider}/${model.id}`)
        ctx.ui.notify(`/yeet-model: set to ${model.provider}/${model.id}`, "info")
        return
      }

      const current = readConfiguredCommitModel() || "current model"
      if (!ctx.hasUI) {
        ctx.ui.notify(`/yeet-model: current setting is ${current}`, "info")
        return
      }

      const available = ctx.modelRegistry.getAvailable()
      const options = ["Use current model", ...available.map((m) => `${m.provider}/${m.id}`)]
      const selectedLabel = await ctx.ui.select("/yeet commit message model", options)
      const selected = selectedLabel === "Use current model" ? "" : selectedLabel
      if (selected === undefined) {
        ctx.ui.notify("/yeet-model: cancelled", "info")
        return
      }
      writeConfiguredCommitModel(selected)
      ctx.ui.notify(`/yeet-model: set to ${selected || "current model"}`, "info")
    },
  })

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

      if (!commitMessage) {
        ctx.ui.notify("/yeet: generating commit message...", "info")
        try {
          commitMessage = (await generateCommitMessage(pi, ctx, cwd, status)) ?? ""
        } catch {
          commitMessage = ""
        }
      }

      if (!commitMessage && ctx.hasUI) {
        const input = await ctx.ui.input("Commit message:", "yeet")
        if (input === undefined) {
          ctx.ui.notify("/yeet: cancelled", "info")
          return
        }
        commitMessage = input.trim()
      }
      if (!commitMessage) commitMessage = "yeet"

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
