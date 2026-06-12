import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { complete, type UserMessage } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"

const EXEC_TIMEOUT_MS = 120_000
const DIFF_MAX_CHARS = 28_000
const CONFIG_PATH = join(homedir(), ".pi", "agent", "pr.json")

const PR_SYSTEM_PROMPT = `You write pull request titles and descriptions.

Return only valid JSON with this exact shape:
{"branchName":"type/short-kebab-description","title":"type(scope): concise description","body":"markdown body"}

Branch name rules:
- Use a short git-safe branch name like feat/add-login, fix/auth-timeout, docs/update-readme
- Use lowercase kebab-case with one slash between type and summary
- Match the title's type when possible
- Keep under 64 characters

Title rules:
- Follow Conventional Commits: type(scope): description
- Use feat, fix, docs, style, refactor, perf, test, build, ci, chore, or revert
- Include a short lowercase scope when clear; omit scope if unclear
- Keep under 72 characters when possible
- Use imperative mood, present tense, lowercase

Body rules:
- If a pull request template is provided, fill it in without deleting useful headings/checklists
- If no template is provided, write a concise but descriptive markdown PR description
- Include a short summary and testing/validation when known
- Do not invent tests that were not run; say "Not run" if unknown
- No explanations outside JSON`

type ExecResult = Awaited<ReturnType<ExtensionAPI["exec"]>>

function formatFailure(command: string, result: ExecResult): string {
  const stderr = result.stderr?.trim()
  const stdout = result.stdout?.trim()
  return `${command} failed with exit ${result.code}${stderr ? `:\n${stderr}` : stdout ? `:\n${stdout}` : ""}`
}

async function git(pi: ExtensionAPI, cwd: string, args: string[], timeout = EXEC_TIMEOUT_MS) {
  return pi.exec("git", args, { cwd, timeout })
}

function readConfiguredModel(): string {
  try {
    if (!existsSync(CONFIG_PATH)) return ""
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as { model?: unknown }
    return typeof parsed.model === "string" ? parsed.model.trim() : ""
  } catch {
    return ""
  }
}

function writeConfiguredModel(model: string) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true })
  writeFileSync(CONFIG_PATH, `${JSON.stringify({ model }, null, 2)}\n`)
}

function resolveModel(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
  const configured = String(pi.getFlag("pr-model") || readConfiguredModel()).trim()
  if (!configured) return { model: ctx.model, configured }
  const slash = configured.indexOf("/")
  if (slash <= 0 || slash === configured.length - 1) return { model: undefined, configured }
  return { model: ctx.modelRegistry.find(configured.slice(0, slash), configured.slice(slash + 1)), configured }
}

function findPrTemplate(cwd: string): { path: string; content: string } | undefined {
  const direct = ["pull_request_template.md", "PULL_REQUEST_TEMPLATE.md"].map((n) => join(cwd, ".github", n))
  for (const path of direct) if (existsSync(path)) return { path, content: readFileSync(path, "utf8") }
  const dir = join(cwd, ".github", "PULL_REQUEST_TEMPLATE")
  if (existsSync(dir)) {
    const first = readdirSync(dir).find((n) => n.toLowerCase().endsWith(".md"))
    if (first) {
      const path = join(dir, first)
      return { path, content: readFileSync(path, "utf8") }
    }
  }
  return undefined
}

function extractJson(text: string): { branchName?: string; title?: string; body?: string } | undefined {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
  try { return JSON.parse(cleaned) } catch {}
  const match = cleaned.match(/\{[\s\S]*\}/)
  if (!match) return undefined
  try { return JSON.parse(match[0]) } catch { return undefined }
}

async function generatePrText(pi: ExtensionAPI, ctx: ExtensionCommandContext, cwd: string, base: string, head: string) {
  const { model, configured } = resolveModel(pi, ctx)
  if (!model) {
    if (configured) ctx.ui.notify(`/pr: configured model not found: ${configured}`, "warning")
    return undefined
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model)
  if (!auth.ok || !auth.apiKey) return undefined

  const template = findPrTemplate(cwd)
  const stat = await git(pi, cwd, ["diff", "--stat", `${base}...${head}`], 20_000)
  const diff = await git(pi, cwd, ["diff", `${base}...${head}`], 40_000)
  const workingStat = await git(pi, cwd, ["diff", "--stat", "HEAD"], 20_000)
  const workingDiff = await git(pi, cwd, ["diff", "HEAD"], 40_000)
  const log = await git(pi, cwd, ["log", "--oneline", `${base}..${head}`], 20_000)
  const status = await git(pi, cwd, ["status", "--short"], 10_000)

  const prompt = `Base branch: ${base}\nHead branch: ${head}\n\nCommits:\n${log.stdout.trim() || "(none)"}\n\nWorking tree status:\n${status.stdout.trim() || "clean"}\n\nCommitted PR diff stat:\n${stat.stdout.trim() || "(none)"}\n\nCommitted PR diff:\n${diff.stdout.slice(0, DIFF_MAX_CHARS)}\n\nUncommitted/staged working diff stat:\n${workingStat.stdout.trim() || "(none)"}\n\nUncommitted/staged working diff:\n${workingDiff.stdout.slice(0, DIFF_MAX_CHARS)}\n\nPR template (${template ? basename(template.path) : "none"}):\n${template?.content ?? ""}`
  const userMessage: UserMessage = { role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }
  const response = await complete(model, { systemPrompt: PR_SYSTEM_PROMPT, messages: [userMessage] }, { apiKey: auth.apiKey, headers: auth.headers, signal: ctx.signal })
  if (response.stopReason === "aborted") return undefined
  const text = response.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n")
  const parsed = extractJson(text)
  if (!parsed?.title || !parsed?.body) return undefined
  return {
    branchName: sanitizeBranchName(parsed.branchName || fallbackBranchName(parsed.title)),
    title: parsed.title.trim(),
    body: parsed.body.trim(),
  }
}

function fallbackBranchName(title: string) {
  const type = title.match(/^([a-z]+)/i)?.[1]?.toLowerCase() || "chore"
  const slug = title.replace(/^[a-z]+(?:\([^)]+\))?!?:\s*/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "pr"
  return `${type}/${slug}`
}

function sanitizeBranchName(name: string) {
  return name.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9/_-]+/g, "").replace(/\/+/g, "/").replace(/^[-_/]+|[-_/]+$/g, "").slice(0, 64) || "chore/pr"
}

async function fallbackGenerated(pi: ExtensionAPI, cwd: string) {
  const files = (await git(pi, cwd, ["diff", "--name-only", "HEAD"], 10_000)).stdout.split(/\r?\n/).map((f) => f.trim()).filter(Boolean)
  const first = files[0] || basename(cwd)
  const scope = (first.split(/[\\/]/)[0] || basename(cwd)).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project"
  const subject = files.length === 1 ? `update ${first.split(/[\\/]/).pop()}` : `update ${scope}`
  const title = `chore(${scope}): ${subject}`.slice(0, 72)
  return {
    branchName: sanitizeBranchName(fallbackBranchName(title)),
    title,
    body: `## Summary\n- Update ${files.length ? files.slice(0, 5).join(", ") : basename(cwd)}${files.length > 5 ? ` and ${files.length - 5} more file(s)` : ""}.\n\n## Testing\n- Not run.`,
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerFlag("pr-model", { description: "Model for /pr title/body generation, as provider/model-id. Defaults to current model.", type: "string", default: "" })

  pi.registerCommand("pr-model", {
    description: "Configure the model used by /pr. Usage: /pr-model [provider/model-id|current|clear]",
    handler: async (rawArgs, ctx) => {
      const arg = rawArgs.trim()
      if (arg === "clear") { writeConfiguredModel(""); ctx.ui.notify("/pr-model: cleared; /pr will use the current model", "info"); return }
      if (arg === "current") {
        if (!ctx.model) { ctx.ui.notify("/pr-model: no current model selected", "error"); return }
        const value = `${ctx.model.provider}/${ctx.model.id}`
        writeConfiguredModel(value); ctx.ui.notify(`/pr-model: set to ${value}`, "info"); return
      }
      if (arg) {
        const slash = arg.indexOf("/")
        const model = slash > 0 ? ctx.modelRegistry.find(arg.slice(0, slash), arg.slice(slash + 1)) : undefined
        if (!model) { ctx.ui.notify(`/pr-model: model not found: ${arg}`, "error"); return }
        writeConfiguredModel(`${model.provider}/${model.id}`); ctx.ui.notify(`/pr-model: set to ${model.provider}/${model.id}`, "info"); return
      }
      const current = readConfiguredModel()
      const currentLabel = current || "current model"
      if (!ctx.hasUI) { ctx.ui.notify(`/pr-model: current setting is ${currentLabel}`, "info"); return }
      const selectedLabel = await ctx.ui.select(`/pr generation model (current: ${currentLabel})`, [`Keep current setting (${currentLabel})`, "Use current model", ...ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`)])
      if (selectedLabel === undefined) { ctx.ui.notify("/pr-model: cancelled", "info"); return }
      const selected = selectedLabel === `Keep current setting (${currentLabel})` ? current : selectedLabel === "Use current model" ? "" : selectedLabel
      writeConfiguredModel(selected); ctx.ui.notify(`/pr-model: set to ${selected || "current model"}`, "info")
    },
  })

  pi.registerCommand("pr", {
    description: "Create a GitHub pull request from the current repo. Usage: /pr",
    handler: async (_rawArgs, ctx) => {
      await ctx.waitForIdle()
      const cwd = ctx.cwd
      const repoCheck = await git(pi, cwd, ["rev-parse", "--is-inside-work-tree"], 10_000)
      if (repoCheck.code !== 0 || repoCheck.stdout.trim() !== "true") { ctx.ui.notify("/pr: not inside a git work tree", "error"); return }
      const ghCheck = await pi.exec("gh", ["--version"], { cwd, timeout: 10_000 })
      if (ghCheck.code !== 0) { ctx.ui.notify("/pr: GitHub CLI (gh) is required", "error"); return }
      await git(pi, cwd, ["fetch", "--all", "--prune"], 60_000)

      const currentBranch = (await git(pi, cwd, ["branch", "--show-current"], 10_000)).stdout.trim()
      if (!currentBranch) { ctx.ui.notify("/pr: detached HEAD is not supported", "error"); return }

      const remoteBranches = (await git(pi, cwd, ["branch", "-r", "--format", "%(refname:short)"], 20_000)).stdout.split(/\r?\n/).map((b) => b.trim()).filter((b) => b && !b.endsWith("/HEAD"))
      const baseOptions = Array.from(new Set(remoteBranches.map((b) => b.replace(/^[^/]+\//, "")))).sort()
      const preferred = ["main", "master", "develop"].filter((b) => baseOptions.includes(b))
      const base = ctx.hasUI ? await ctx.ui.select("/pr: merge into which branch?", [...preferred, ...baseOptions.filter((b) => !preferred.includes(b))]) : preferred[0] ?? baseOptions[0]
      if (!base) { ctx.ui.notify("/pr: cancelled", "info"); return }
      const baseRef = remoteBranches.find((b) => b.endsWith(`/${base}`)) ?? base

      let head = currentBranch
      const branchMode = ctx.hasUI ? await ctx.ui.select("/pr: source branch", [`Use current branch (${currentBranch})`, "Create a new branch from current HEAD"]) : `Use current branch (${currentBranch})`
      if (!branchMode) { ctx.ui.notify("/pr: cancelled", "info"); return }

      ctx.ui.notify("/pr: generating title and body...", "info")
      let generated = await generatePrText(pi, ctx, cwd, baseRef, "HEAD")
      if (!generated) {
        ctx.ui.notify("/pr: model generation failed; using git-based fallback", "warning")
        generated = await fallbackGenerated(pi, cwd)
      }

      if (branchMode.startsWith("Create")) {
        head = sanitizeBranchName(generated.branchName)
        const checkout = await git(pi, cwd, ["checkout", "-b", head], 30_000)
        if (checkout.code !== 0) { ctx.ui.notify(formatFailure(`git checkout -b ${head}`, checkout), "error"); return }
        generated = (await generatePrText(pi, ctx, cwd, baseRef, head)) ?? generated
      }

      const title = generated.title
      const body = generated.body

      if (ctx.hasUI) {
        const ok = await ctx.ui.confirm("/pr: create pull request?", `Branch: ${head}\nBase: ${base}\nTitle: ${title}\n\n${body}`)
        if (!ok) { ctx.ui.notify("/pr: cancelled", "info"); return }
      }

      ctx.ui.notify(`/pr: pushing ${head}...`, "info")
      const push = await git(pi, cwd, ["push", "-u", "origin", head], EXEC_TIMEOUT_MS)
      if (push.code !== 0) { ctx.ui.notify(formatFailure(`git push -u origin ${head}`, push), "error"); return }

      ctx.ui.notify("/pr: creating pull request...", "info")
      const create = await pi.exec("gh", ["pr", "create", "--base", base, "--head", head, "--title", title, "--body", body], { cwd, timeout: EXEC_TIMEOUT_MS })
      if (create.code !== 0) { ctx.ui.notify(formatFailure("gh pr create", create), "error"); return }
      ctx.ui.notify(`/pr: created ${create.stdout.trim()}`, "info")
    },
  })
}
