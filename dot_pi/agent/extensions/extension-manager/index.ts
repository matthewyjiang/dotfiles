import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

type Ext = { name: string; path: string; enabled: boolean; source: string };

const agentDir = path.join(os.homedir(), ".pi", "agent");
const settingsPath = path.join(agentDir, "settings.json");

function readJson(file: string): any {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
}

function writeJson(file: string, data: any) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

function ensureQuietStartup() {
  const settings = readJson(settingsPath);
  if (settings.quietStartup !== true) {
    settings.quietStartup = true;
    writeJson(settingsPath, settings);
  }
}

function resolveEntry(p: string): string[] {
  const abs = path.resolve(p.replace(/^~/, os.homedir()));
  if (!fs.existsSync(abs)) return [abs];
  const stat = fs.statSync(abs);
  if (!stat.isDirectory()) return [abs];
  const pkg = path.join(abs, "package.json");
  if (fs.existsSync(pkg)) {
    const manifest = readJson(pkg)?.pi?.extensions;
    if (Array.isArray(manifest) && manifest.length) return manifest.map((e: string) => path.resolve(abs, e));
  }
  for (const idx of ["index.ts", "index.js"]) {
    const f = path.join(abs, idx);
    if (fs.existsSync(f)) return [f];
  }
  return [];
}

function discoverDir(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if ((ent.isFile() || ent.isSymbolicLink()) && /\.(ts|js)$/.test(ent.name)) out.push(p);
    else if (ent.isDirectory() || ent.isSymbolicLink()) out.push(...resolveEntry(p));
  }
  return out;
}

function discoverPackages(settings: any): string[] {
  const result: string[] = [];
  for (const pkgSrc of settings.packages ?? []) {
    const source = typeof pkgSrc === "string" ? pkgSrc : pkgSrc?.source;
    const allowed = typeof pkgSrc === "object" ? pkgSrc.extensions : undefined;
    if (Array.isArray(allowed) && allowed.length === 0) continue;
    if (!source?.startsWith("npm:")) continue;
    const spec = source.slice(4).replace(/@[^/@]+$/, "");
    const pkgDir = path.join(agentDir, "npm", "node_modules", spec);
    const pkg = readJson(path.join(pkgDir, "package.json"));
    const entries = pkg?.pi?.extensions;
    if (Array.isArray(entries)) result.push(...entries.flatMap((e: string) => resolveEntry(path.resolve(pkgDir, e))));
    else result.push(...resolveEntry(pkgDir));
  }
  return result;
}

function nearestPackageName(file: string): string | undefined {
  let dir = path.dirname(path.resolve(file));
  const stop = path.parse(dir).root;
  while (dir !== stop) {
    const pkgPath = path.join(dir, "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = readJson(pkgPath);
      if (typeof pkg.name === "string" && pkg.name.length > 0) return pkg.name;
    }
    dir = path.dirname(dir);
  }
  return undefined;
}

function displayName(file: string): string {
  const base = path.basename(file).replace(/\.(ts|js)$/, "");
  if (base !== "index") return base;
  const pkgName = nearestPackageName(file);
  if (pkgName) return pkgName;
  const dir = path.dirname(file);
  return path.basename(dir) === "src" ? path.basename(path.dirname(dir)) : path.basename(dir);
}

function isDisabled(file: string, settings: any): boolean {
  const abs = path.resolve(file);
  const list: string[] = settings.extensions ?? [];
  return list.some((x) => x === `-${abs}` || x === `!${abs}` || path.resolve(x.slice(1)) === abs && x.startsWith("-"));
}

function listExtensions(cwd: string): Ext[] {
  const settings = readJson(settingsPath);
  const paths = new Set<string>();
  discoverDir(path.join(cwd, ".pi", "extensions")).forEach((p) => paths.add(path.resolve(p)));
  discoverDir(path.join(agentDir, "extensions")).forEach((p) => paths.add(path.resolve(p)));
  discoverPackages(settings).forEach((p) => paths.add(path.resolve(p)));
  for (const e of settings.extensions ?? []) if (!/^[!+-]/.test(e)) resolveEntry(e).forEach((p) => paths.add(path.resolve(p)));
  return [...paths].sort((a, b) => displayName(a).localeCompare(displayName(b))).map((p) => ({
    name: displayName(p), path: p, enabled: !isDisabled(p, settings), source: p,
  }));
}

function isSelf(file: string): boolean {
  return path.resolve(file) === path.resolve(__filename);
}

function setEnabled(file: string, enabled: boolean) {
  const abs = path.resolve(file);
  if (!enabled && isSelf(abs)) return false;
  const settings = readJson(settingsPath);
  const without = (settings.extensions ?? []).filter((x: string) => x !== `-${abs}` && x !== `+${abs}` && x !== abs);
  without.push(enabled ? `+${abs}` : `-${abs}`);
  settings.extensions = without;
  writeJson(settingsPath, settings);
  return true;
}

export default function(pi: ExtensionAPI) {
  ensureQuietStartup();

  pi.registerCommand("extensions", {
    description: "Show and toggle extensions",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      while (true) {
        const exts = listExtensions(ctx.cwd);
        if (exts.length === 0) { ctx.ui.notify("No extensions found", "info"); return; }
        const choices = exts.map((e) => {
          const locked = isSelf(e.path) ? "  LOCKED" : "";
          return `${e.enabled ? "● ON " : "○ OFF"}  ${e.name}${locked}`;
        });
        choices.push("Done");
        const pick = await ctx.ui.select("Extensions (select to toggle; /reload after changes)", choices);
        if (!pick || pick === "Done") return;
        const ext = exts[choices.indexOf(pick)];
        if (!ext) continue;
        if (isSelf(ext.path)) {
          ctx.ui.notify("extension-manager cannot be disabled", "warning");
          continue;
        }
        const changed = setEnabled(ext.path, !ext.enabled);
        if (changed) ctx.ui.notify(`${!ext.enabled ? "Enabled" : "Disabled"}: ${ext.name}`, "info");
      }
    },
  });
}
