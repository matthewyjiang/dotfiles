import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

function run(cwd: string, command: string): string | undefined {
	try {
		return execSync(command, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim() || undefined;
	} catch {
		return undefined;
	}
}

function gitRoot(cwd: string): string | undefined {
	return run(cwd, "git rev-parse --show-toplevel 2>/dev/null");
}

function projectName(cwd: string): string {
	const root = gitRoot(cwd) ?? cwd;
	const pkgPath = join(root, "package.json");
	if (existsSync(pkgPath)) {
		try {
			const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string; version?: string };
			if (pkg.name && pkg.version) return `${pkg.name}@${pkg.version}`;
			if (pkg.name) return pkg.name;
		} catch {
			// Fall back to directory name.
		}
	}
	return basename(root);
}

function gitInfo(cwd: string): string | undefined {
	if (!gitRoot(cwd)) return undefined;

	const branch = run(cwd, "git branch --show-current 2>/dev/null || git rev-parse --short HEAD 2>/dev/null");
	const commit = run(cwd, "git log -1 --format='%h %s' 2>/dev/null");
	const porcelain = run(cwd, "git status --porcelain=v1 2>/dev/null") ?? "";
	const changed = porcelain ? porcelain.split("\n").filter(Boolean).length : 0;
	const upstream = run(cwd, "git rev-list --left-right --count @{upstream}...HEAD 2>/dev/null");

	const status = [changed === 0 ? "clean" : `${changed} changed`];
	if (upstream) {
		const [behind, ahead] = upstream.split(/\s+/).map(Number);
		if (ahead) status.push(`↑${ahead}`);
		if (behind) status.push(`↓${behind}`);
	}

	return [branch, commit, status.join(" ")].filter(Boolean).join("  •  ");
}

function pad(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		ctx.ui.setHeader((_tui, theme) => ({
			render(width: number): string[] {
				const inner = Math.max(24, Math.min(width - 4, 76));
				const parts = [
					theme.fg("accent", theme.bold("π")),
					theme.fg("muted", projectName(ctx.cwd)),
					theme.fg("dim", gitInfo(ctx.cwd) ?? "not a git repository"),
				];
				const text = parts.join(theme.fg("dim", "  •  "));
				const row = theme.fg("borderMuted", "│") + " " + truncateToWidth(text, inner - 2, "…");
				const padded = row + " ".repeat(Math.max(0, inner + 1 - visibleWidth(row))) + theme.fg("borderMuted", "│");

				return [
					theme.fg("borderMuted", `╭${"─".repeat(inner)}╮`),
					truncateToWidth(padded, width, ""),
					theme.fg("borderMuted", `╰${"─".repeat(inner)}╯`),
				];
			},
			invalidate() {},
		}));
	});
}
