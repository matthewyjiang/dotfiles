import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { existsSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join, relative } from "node:path"

const TIMEOUT = 120_000
const HOME = homedir()
const AGENT_DIR = join(HOME, ".pi", "agent")

const SAFE_ROOT_FILES = [
  "settings.json",
  "AGENTS.md",
  "pr.json",
  "yeet.json",
]

const SENSITIVE_ROOT_FILES = [
  "auth.json",
  "trust.json",
]

const SKIP_DIRS = new Set([
  "sessions",
  "npm",
  "node_modules",
  ".git",
])

function parseArgs(args: string) {
  const parts = args.trim().split(/\s+/).filter(Boolean)
  return {
    dryRun: parts.includes("--dry-run") || parts.includes("-n"),
    yes: parts.includes("--yes") || parts.includes("-y"),
    push: parts.includes("--push") || parts.includes("-p"),
    includeSensitive: parts.includes("--include-sensitive"),
  }
}

function walk(dir: string, out: string[] = []) {
  if (!existsSync(dir)) return out
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith(".")) continue
    const p = join(dir, ent.name)
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name)) walk(p, out)
    } else if (ent.isFile() && /\.(ts|js|json|md)$/.test(ent.name)) {
      out.push(p)
    }
  }
  return out
}

function collectFiles(includeSensitive: boolean) {
  const files = new Set<string>()

  for (const name of SAFE_ROOT_FILES) {
    const p = join(AGENT_DIR, name)
    if (existsSync(p) && statSync(p).isFile()) files.add(p)
  }

  if (includeSensitive) {
    for (const name of SENSITIVE_ROOT_FILES) {
      const p = join(AGENT_DIR, name)
      if (existsSync(p) && statSync(p).isFile()) files.add(p)
    }
  }

  for (const dir of ["extensions", "skills", "prompts", "themes"]) {
    walk(join(AGENT_DIR, dir)).forEach((p) => files.add(p))
  }

  return [...files].sort()
}

function relList(files: string[]) {
  return files.map((p) => `~/${relative(HOME, p)}`).join("\n")
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("chezmoi-pi-sync", {
    description: "Add pi config files to chezmoi; use --push to commit/push, --dry-run to preview",
    handler: async (args, ctx) => {
      const opts = parseArgs(args)
      const files = collectFiles(opts.includeSensitive)

      if (files.length === 0) {
        ctx.ui.notify("No pi config files found to sync", "warning")
        return
      }

      const source = await pi.exec("chezmoi", ["source-path"], { cwd: HOME, timeout: TIMEOUT })
      if (source.code !== 0) {
        ctx.ui.notify(`chezmoi source-path failed: ${source.stderr || source.stdout}`, "error")
        return
      }

      const preview = `Will add ${files.length} pi config files to chezmoi:\n\n${relList(files)}\n\nExcluded by default: auth.json, trust.json, sessions/, npm/. Use --include-sensitive if you really want auth/trust.`

      if (opts.dryRun) {
        ctx.ui.notify(preview, "info")
        return
      }

      if (!opts.yes && ctx.hasUI) {
        const ok = await ctx.ui.confirm("Sync pi configs with chezmoi?", preview)
        if (!ok) return
      }

      const add = await pi.exec("chezmoi", ["add", ...files], { cwd: HOME, timeout: TIMEOUT })
      if (add.code !== 0) {
        ctx.ui.notify(`chezmoi add failed: ${add.stderr || add.stdout}`, "error")
        return
      }

      const src = source.stdout.trim()
      const status = await pi.exec("git", ["status", "--short"], { cwd: src, timeout: TIMEOUT })
      const statusText = status.stdout.trim() || "chezmoi source is clean"

      if (!opts.push) {
        ctx.ui.notify(`Pi configs added to chezmoi.\n\n${statusText}\n\nCommit/push from ${src}, or rerun with --push.`, "info")
        return
      }

      const gitStatus = await pi.exec("git", ["status", "--porcelain"], { cwd: src, timeout: TIMEOUT })
      if (!gitStatus.stdout.trim()) {
        ctx.ui.notify("Pi configs already synced; nothing to commit", "info")
        return
      }

      await pi.exec("git", ["add", "-A"], { cwd: src, timeout: TIMEOUT })
      const commit = await pi.exec("git", ["commit", "-m", "chore(pi): sync pi config"], { cwd: src, timeout: TIMEOUT })
      if (commit.code !== 0) {
        ctx.ui.notify(`git commit failed: ${commit.stderr || commit.stdout}`, "error")
        return
      }

      const push = await pi.exec("git", ["push"], { cwd: src, timeout: TIMEOUT })
      if (push.code !== 0) {
        ctx.ui.notify(`git push failed: ${push.stderr || push.stdout}`, "error")
        return
      }

      ctx.ui.notify("Pi configs synced to chezmoi and pushed", "info")
    },
  })
}
