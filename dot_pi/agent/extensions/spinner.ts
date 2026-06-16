import type { ExtensionAPI, ExtensionContext, WorkingIndicatorOptions } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

type SpinnerStyle =
  | "pulse"
  | "pi"
  | "braille"
  | "orbit"
  | "wave"
  | "cursor"
  | "bar"
  | "dot"
  | "none"
  | "default";

const CONFIG_PATH = join(homedir(), ".pi", "agent", "spinner-style.json");

const STYLES: Array<{ value: SpinnerStyle; label: string; description: string }> = [
  { value: "pulse", label: "Pulse", description: "Minimal dot pulse: · • ● •" },
  { value: "pi", label: "Pi pulse", description: "Branded π loading animation" },
  { value: "braille", label: "Braille flow", description: "Smooth terminal-native braille spinner" },
  { value: "orbit", label: "Orbit", description: "Small circular orbit animation" },
  { value: "wave", label: "Wave", description: "Thinking wave: ~ ≈ ≋ ≈" },
  { value: "cursor", label: "Code cursor", description: "Alternating editor cursor blocks" },
  { value: "bar", label: "Progress bar", description: "Tiny animated progress illusion" },
  { value: "dot", label: "Static dot", description: "Single quiet dot" },
  { value: "none", label: "Hidden", description: "Hide the working indicator" },
  { value: "default", label: "Pi default", description: "Restore pi's built-in spinner" },
];

function isStyle(value: string): value is SpinnerStyle {
  return STYLES.some((style) => style.value === value);
}

function readStyle(): SpinnerStyle {
  try {
    const data = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as { style?: string };
    return data.style && isStyle(data.style) ? data.style : "pulse";
  } catch {
    return "pulse";
  }
}

function saveStyle(style: SpinnerStyle): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify({ style }, null, 2));
}

function labelFor(style: SpinnerStyle): string {
  return STYLES.find((item) => item.value === style)?.label ?? style;
}

function indicatorFor(ctx: ExtensionContext, style: SpinnerStyle): WorkingIndicatorOptions | undefined {
  const theme = ctx.ui.theme;
  const accent = (s: string) => theme.fg("accent", s);
  const muted = (s: string) => theme.fg("muted", s);
  const dim = (s: string) => theme.fg("dim", s);

  switch (style) {
    case "pulse":
      return { frames: [dim("·"), muted("•"), accent("●"), muted("•")], intervalMs: 120 };
    case "pi":
      return { frames: [dim("π·"), muted("π•"), accent("π●"), muted("π•")], intervalMs: 130 };
    case "braille":
      return { frames: ["⠁", "⠂", "⠄", "⡀", "⢀", "⠠", "⠐", "⠈"].map(accent), intervalMs: 70 };
    case "orbit":
      return { frames: ["◜", "◠", "◝", "◞", "◡", "◟"].map(accent), intervalMs: 90 };
    case "wave":
      return { frames: [dim("~"), muted("≈"), accent("≋"), muted("≈")], intervalMs: 140 };
    case "cursor":
      return { frames: [accent("▌"), muted("▐")], intervalMs: 240 };
    case "bar":
      return {
        frames: ["[    ]", "[=   ]", "[==  ]", "[=== ]", "[====]", "[ ===]", "[  ==]", "[   =]"].map(accent),
        intervalMs: 100,
      };
    case "dot":
      return { frames: [accent("●")] };
    case "none":
      return { frames: [] };
    case "default":
      return undefined;
  }
}

export default function (pi: ExtensionAPI) {
  let currentStyle: SpinnerStyle = readStyle();

  const apply = (ctx: ExtensionContext) => {
    ctx.ui.setWorkingIndicator(indicatorFor(ctx, currentStyle));
    ctx.ui.setStatus("spinner", undefined);
  };

  pi.on("session_start", (_event, ctx) => {
    apply(ctx);
  });

  pi.registerCommand("spinner", {
    description: "Choose the streaming loading animation style.",
    handler: async (args, ctx) => {
      const requested = args.trim().toLowerCase();

      if (requested === "list") {
        ctx.ui.notify(`Spinner styles: ${STYLES.map((s) => s.value).join(", ")}`, "info");
        return;
      }

      let nextStyle: SpinnerStyle | undefined;
      if (requested) {
        if (!isStyle(requested)) {
          ctx.ui.notify("Usage: /spinner [pulse|pi|braille|orbit|wave|cursor|bar|dot|none|default|list]", "error");
          return;
        }
        nextStyle = requested;
      } else {
        const choices = STYLES.map((style) =>
          style.value === currentStyle ? `${style.label}  ✓ — ${style.description}` : `${style.label} — ${style.description}`,
        );
        const selected = await ctx.ui.select("Choose spinner style", choices);
        if (!selected) return;

        const selectedIndex = choices.indexOf(selected);
        nextStyle = STYLES[selectedIndex]?.value;
      }

      currentStyle = nextStyle;
      saveStyle(currentStyle);
      apply(ctx);
      ctx.ui.notify(`Spinner set to ${labelFor(currentStyle)}`, "info");
    },
  });
}
