/**
 * Questionnaire Tool - ask the user one or more interactive questions from pi.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface QuestionOption {
  value: string;
  label: string;
  description?: string;
}

type RenderOption = QuestionOption & { isOther?: boolean };

interface Question {
  id: string;
  label: string;
  prompt: string;
  options: QuestionOption[];
  allowOther: boolean;
}

interface Answer {
  id: string;
  value: string;
  label: string;
  wasCustom: boolean;
  index?: number;
}

interface QuestionnaireResult {
  questions: Question[];
  answers: Answer[];
  cancelled: boolean;
}

const QuestionOptionSchema = Type.Object({
  value: Type.String({ description: "The value returned when selected" }),
  label: Type.String({ description: "Display label for the option" }),
  description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
});

const QuestionSchema = Type.Object({
  id: Type.String({ description: "Unique identifier for this question" }),
  label: Type.Optional(
    Type.String({ description: "Short contextual label for tab bar, e.g. 'Scope', 'Priority' (defaults to Q1, Q2)" }),
  ),
  prompt: Type.String({ description: "The full question text to display" }),
  options: Type.Array(QuestionOptionSchema, { description: "Available options to choose from" }),
  allowOther: Type.Optional(Type.Boolean({ description: "Allow 'Type something' option (default: true)" })),
});

const QuestionnaireParams = Type.Object({
  questions: Type.Array(QuestionSchema, { description: "Questions to ask the user" }),
});

function errorResult(message: string, questions: Question[] = []) {
  return {
    content: [{ type: "text" as const, text: message }],
    details: { questions, answers: [], cancelled: true } satisfies QuestionnaireResult,
  };
}

export default function questionnaire(pi: ExtensionAPI) {
  pi.registerTool({
    name: "questionnaire",
    label: "Questionnaire",
    description:
      "Ask the user one or more questions. Use for clarifying requirements, getting preferences, or confirming decisions. For single questions, shows a simple option list. For multiple questions, shows a tab-based interface.",
    promptSnippet: "Ask the user one or more interactive clarification questions with selectable options and optional free-text answers.",
    promptGuidelines: [
      "Use questionnaire when you need user preferences, missing requirements, or a decision before proceeding.",
      "Use questionnaire with multiple questions when several related clarifications can be collected at once.",
    ],
    parameters: QuestionnaireParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (ctx.mode !== "tui") return errorResult("Error: UI not available (running in non-interactive mode)");
      if (params.questions.length === 0) return errorResult("Error: No questions provided");

      const questions: Question[] = params.questions.map((q, i) => ({
        ...q,
        label: q.label || `Q${i + 1}`,
        allowOther: q.allowOther !== false,
      }));

      const isMulti = questions.length > 1;
      const totalTabs = questions.length + 1;

      const result = await ctx.ui.custom<QuestionnaireResult>((tui, theme, _kb, done) => {
        let currentTab = 0;
        let optionIndex = 0;
        let inputMode = false;
        let inputQuestionId: string | null = null;
        let cachedLines: string[] | undefined;
        const answers = new Map<string, Answer>();

        const editorTheme: EditorTheme = {
          borderColor: (s) => theme.fg("accent", s),
          selectList: {
            selectedPrefix: (t) => theme.fg("accent", t),
            selectedText: (t) => theme.fg("accent", t),
            description: (t) => theme.fg("muted", t),
            scrollInfo: (t) => theme.fg("dim", t),
            noMatch: (t) => theme.fg("warning", t),
          },
        };
        const editor = new Editor(tui, editorTheme);

        function refresh() {
          cachedLines = undefined;
          tui.requestRender();
        }

        function submit(cancelled: boolean) {
          done({ questions, answers: Array.from(answers.values()), cancelled });
        }

        function currentQuestion() {
          return questions[currentTab];
        }

        function currentOptions(): RenderOption[] {
          const q = currentQuestion();
          if (!q) return [];
          const opts: RenderOption[] = [...q.options];
          if (q.allowOther) opts.push({ value: "__other__", label: "Type something.", isOther: true });
          return opts;
        }

        function allAnswered() {
          return questions.every((q) => answers.has(q.id));
        }

        function saveAnswer(questionId: string, value: string, label: string, wasCustom: boolean, index?: number) {
          answers.set(questionId, { id: questionId, value, label, wasCustom, index });
        }

        function advanceAfterAnswer() {
          if (!isMulti) return submit(false);
          currentTab = currentTab < questions.length - 1 ? currentTab + 1 : questions.length;
          optionIndex = 0;
          refresh();
        }

        editor.onSubmit = (value) => {
          if (!inputQuestionId) return;
          const trimmed = value.trim() || "(no response)";
          saveAnswer(inputQuestionId, trimmed, trimmed, true);
          inputMode = false;
          inputQuestionId = null;
          editor.setText("");
          advanceAfterAnswer();
        };

        function handleInput(data: string) {
          if (inputMode) {
            if (matchesKey(data, Key.escape)) {
              inputMode = false;
              inputQuestionId = null;
              editor.setText("");
              refresh();
              return;
            }
            editor.handleInput(data);
            refresh();
            return;
          }

          const q = currentQuestion();
          const opts = currentOptions();

          if (isMulti) {
            if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
              currentTab = (currentTab + 1) % totalTabs;
              optionIndex = 0;
              refresh();
              return;
            }
            if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
              currentTab = (currentTab - 1 + totalTabs) % totalTabs;
              optionIndex = 0;
              refresh();
              return;
            }
          }

          if (currentTab === questions.length) {
            if (matchesKey(data, Key.enter) && allAnswered()) submit(false);
            else if (matchesKey(data, Key.escape)) submit(true);
            return;
          }

          if (matchesKey(data, Key.up)) {
            optionIndex = Math.max(0, optionIndex - 1);
            refresh();
            return;
          }
          if (matchesKey(data, Key.down)) {
            optionIndex = Math.min(opts.length - 1, optionIndex + 1);
            refresh();
            return;
          }
          if (matchesKey(data, Key.enter) && q) {
            const opt = opts[optionIndex];
            if (opt.isOther) {
              inputMode = true;
              inputQuestionId = q.id;
              editor.setText("");
              refresh();
              return;
            }
            saveAnswer(q.id, opt.value, opt.label, false, optionIndex + 1);
            advanceAfterAnswer();
            return;
          }
          if (matchesKey(data, Key.escape)) submit(true);
        }

        function render(width: number): string[] {
          if (cachedLines) return cachedLines;
          const lines: string[] = [];
          const q = currentQuestion();
          const opts = currentOptions();
          const add = (s: string) => lines.push(truncateToWidth(s, width));

          add(theme.fg("accent", "─".repeat(width)));

          if (isMulti) {
            const tabs: string[] = ["← "];
            for (let i = 0; i < questions.length; i++) {
              const active = i === currentTab;
              const answered = answers.has(questions[i].id);
              const text = ` ${answered ? "■" : "□"} ${questions[i].label} `;
              tabs.push(`${active ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg(answered ? "success" : "muted", text)} `);
            }
            const submitText = " ✓ Submit ";
            tabs.push(`${currentTab === questions.length ? theme.bg("selectedBg", theme.fg("text", submitText)) : theme.fg(allAnswered() ? "success" : "dim", submitText)} →`);
            add(` ${tabs.join("")}`);
            lines.push("");
          }

          const renderOptions = () => {
            for (let i = 0; i < opts.length; i++) {
              const opt = opts[i];
              const selected = i === optionIndex;
              const prefix = selected ? theme.fg("accent", "> ") : "  ";
              add(prefix + theme.fg(selected ? "accent" : "text", `${i + 1}. ${opt.label}${opt.isOther && inputMode ? " ✎" : ""}`));
              if (opt.description) add(`     ${theme.fg("muted", opt.description)}`);
            }
          };

          if (inputMode && q) {
            add(theme.fg("text", ` ${q.prompt}`));
            lines.push("");
            renderOptions();
            lines.push("");
            add(theme.fg("muted", " Your answer:"));
            for (const line of editor.render(width - 2)) add(` ${line}`);
            lines.push("");
            add(theme.fg("dim", " Enter to submit • Esc to cancel"));
          } else if (currentTab === questions.length) {
            add(theme.fg("accent", theme.bold(" Ready to submit")));
            lines.push("");
            for (const question of questions) {
              const answer = answers.get(question.id);
              if (answer) add(`${theme.fg("muted", ` ${question.label}: `)}${theme.fg("text", `${answer.wasCustom ? "(wrote) " : ""}${answer.label}`)}`);
            }
            lines.push("");
            if (allAnswered()) add(theme.fg("success", " Press Enter to submit"));
            else add(theme.fg("warning", ` Unanswered: ${questions.filter((q) => !answers.has(q.id)).map((q) => q.label).join(", ")}`));
          } else if (q) {
            add(theme.fg("text", ` ${q.prompt}`));
            lines.push("");
            renderOptions();
          }

          lines.push("");
          if (!inputMode) add(theme.fg("dim", isMulti ? " Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel" : " ↑↓ navigate • Enter select • Esc cancel"));
          add(theme.fg("accent", "─".repeat(width)));
          cachedLines = lines;
          return lines;
        }

        return { render, invalidate: () => { cachedLines = undefined; }, handleInput };
      });

      if (result.cancelled) {
        return { content: [{ type: "text" as const, text: "User cancelled the questionnaire" }], details: result };
      }

      const answerLines = result.answers.map((a) => {
        const qLabel = questions.find((q) => q.id === a.id)?.label || a.id;
        return a.wasCustom ? `${qLabel}: user wrote: ${a.label}` : `${qLabel}: user selected: ${a.index}. ${a.label}`;
      });

      return { content: [{ type: "text" as const, text: answerLines.join("\n") }], details: result };
    },

    renderCall(args, theme) {
      const qs = (args.questions as Question[]) || [];
      const labels = qs.map((q) => q.label || q.id).join(", ");
      let text = theme.fg("toolTitle", theme.bold("questionnaire "));
      text += theme.fg("muted", `${qs.length} question${qs.length !== 1 ? "s" : ""}`);
      if (labels) text += theme.fg("dim", ` (${truncateToWidth(labels, 40)})`);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const details = result.details as QuestionnaireResult | undefined;
      if (!details) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "", 0, 0);
      }
      if (details.cancelled) return new Text(theme.fg("warning", "Cancelled"), 0, 0);
      return new Text(
        details.answers
          .map((a) => {
            if (a.wasCustom) return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${theme.fg("muted", "(wrote) ")}${a.label}`;
            return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${a.index ? `${a.index}. ${a.label}` : a.label}`;
          })
          .join("\n"),
        0,
        0,
      );
    },
  });
}
