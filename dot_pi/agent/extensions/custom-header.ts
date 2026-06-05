import { execSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

function line(width: number): string {
	return "─".repeat(Math.max(0, width));
}

function getGitBranch(cwd: string): string | undefined {
	try {
		return execSync("git branch --show-current 2>/dev/null || git rev-parse --short HEAD 2>/dev/null", {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim() || undefined;
	} catch {
		return undefined;
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setHeader((_tui, theme) => ({
			render(width: number): string[] {
				const inner = Math.max(24, Math.min(width - 4, 76));
				const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model";
				const cwd = ctx.cwd.replace(/^\/home\/[^/]+/, "~");
				const branch = getGitBranch(ctx.cwd);
				const parts = [
					theme.fg("accent", theme.bold("π")),
					theme.fg("muted", model),
					theme.fg("dim", cwd),
				];
				if (branch) parts.push(theme.fg("dim", `git:${branch}`));
				const text = parts.join(theme.fg("dim", "  •  "));
				const row = theme.fg("borderMuted", "│") + " " + truncateToWidth(text, inner - 2, "…");
				const padded = row + " ".repeat(Math.max(0, inner + 1 - visibleWidth(row))) + theme.fg("borderMuted", "│");

				return [
					theme.fg("borderMuted", `╭${line(inner)}╮`),
					truncateToWidth(padded, width, ""),
					theme.fg("borderMuted", `╰${line(inner)}╯`),
				];
			},
			invalidate() {},
		}));
	});
}
