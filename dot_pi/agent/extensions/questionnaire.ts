/**
 * Questionnaire Tool - Unified tool for asking single or multiple questions
 *
 * Single question: simple options list
 * Multiple questions: tab bar navigation between questions
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	parseKey,
	Text,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

// Types
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

// Schema
const QuestionOptionSchema = Type.Object({
	value: Type.String({ description: "The value returned when selected" }),
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique identifier for this question" }),
	label: Type.Optional(
		Type.String({
			description: "Short contextual label for tab bar, e.g. 'Scope', 'Priority' (defaults to Q1, Q2)",
		}),
	),
	prompt: Type.String({ description: "The full question text to display" }),
	options: Type.Array(QuestionOptionSchema, { description: "Available options to choose from" }),
	allowOther: Type.Optional(Type.Boolean({ description: "Allow 'Type something' option (default: true)" })),
});

const QuestionnaireParams = Type.Object({
	questions: Type.Array(QuestionSchema, { description: "Questions to ask the user" }),
});

const OTHER_VALUE = "__other__";

function errorResult(
	message: string,
	questions: Question[] = [],
): { content: { type: "text"; text: string }[]; details: QuestionnaireResult } {
	return {
		content: [{ type: "text", text: message }],
		details: { questions, answers: [], cancelled: true },
	};
}

function normalizeDescription(text: string): string {
	return text.replace(/[\r\n]+/g, " ").trim();
}

function orderedAnswers(questions: Question[], answers: Map<string, Answer>): Answer[] {
	return questions.flatMap((q) => {
		const answer = answers.get(q.id);
		return answer ? [answer] : [];
	});
}

function formatAnswerLines(questions: Question[], answers: Answer[]): string[] {
	return answers.map((a) => {
		const qLabel = questions.find((q) => q.id === a.id)?.label || a.id;
		if (a.wasCustom) {
			return `${qLabel}: user wrote: ${a.label}`;
		}
		return `${qLabel}: user selected: ${a.index}. ${a.label}`;
	});
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
			if (params.questions.length === 0) {
				return errorResult("Error: No questions provided");
			}

			// Normalize questions with defaults
			const questions: Question[] = params.questions.map((q, i) => ({
				...q,
				label: q.label || `Q${i + 1}`,
				allowOther: q.allowOther !== false,
			}));

			const impossibleQuestion = questions.find((q) => q.options.length === 0 && !q.allowOther);
			if (impossibleQuestion) {
				return errorResult(`Error: Question '${impossibleQuestion.label}' has no answer options`, questions);
			}

			// Non-TUI modes cannot render custom components. If a UI protocol is available
			// (for example RPC), fall back to simple dialogs instead of failing outright.
			if (ctx.mode !== "tui") {
				if (!ctx.hasUI) {
					return errorResult("Error: UI not available (running in non-interactive mode)", questions);
				}

				const answers = new Map<string, Answer>();
				for (const q of questions) {
					const labels = q.options.map((opt, i) => `${i + 1}. ${opt.label}`);
					if (q.allowOther) labels.push(`${labels.length + 1}. Type something.`);

					const selected = await ctx.ui.select(q.prompt, labels);
					if (!selected) {
						const result = { questions, answers: orderedAnswers(questions, answers), cancelled: true };
						return { content: [{ type: "text", text: "User cancelled the questionnaire" }], details: result };
					}

					const selectedIndex = labels.indexOf(selected);
					if (selectedIndex === -1) {
						const result = { questions, answers: orderedAnswers(questions, answers), cancelled: true };
						return { content: [{ type: "text", text: "User cancelled the questionnaire" }], details: result };
					}

					if (q.allowOther && selectedIndex === q.options.length) {
						while (true) {
							const custom = await ctx.ui.input(q.prompt, "Type your answer");
							if (custom === undefined) {
								const result = { questions, answers: orderedAnswers(questions, answers), cancelled: true };
								return { content: [{ type: "text", text: "User cancelled the questionnaire" }], details: result };
							}
							const trimmed = custom.trim();
							if (!trimmed) {
								ctx.ui.notify("Please enter a response, or cancel to go back.", "warning");
								continue;
							}
							answers.set(q.id, { id: q.id, value: trimmed, label: trimmed, wasCustom: true });
							break;
						}
					} else {
						const opt = q.options[selectedIndex];
						answers.set(q.id, {
							id: q.id,
							value: opt.value,
							label: opt.label,
							wasCustom: false,
							index: selectedIndex + 1,
						});
					}
				}

				const result = { questions, answers: orderedAnswers(questions, answers), cancelled: false };
				return {
					content: [{ type: "text", text: formatAnswerLines(questions, result.answers).join("\n") }],
					details: result,
				};
			}

			const isMulti = questions.length > 1;
			const totalTabs = questions.length + 1; // questions + Submit

			const result = await ctx.ui.custom<QuestionnaireResult>((tui, theme, _kb, done) => {
				// State
				let currentTab = 0;
				let optionIndex = 0;
				let inputMode = false;
				let inputQuestionId: string | null = null;
				let inputError: string | null = null;
				let scrollOffset = 0;
				let lastBodyHeight = 1;
				let lastBodyLineCount = 1;
				let ensureSelectionVisible = true;
				let focused = false;
				let cachedRender: { width: number; rows: number; lines: string[] } | undefined;
				const answers = new Map<string, Answer>();
				const selectedOptionByQuestion = new Map<string, number>();

				// Editor for "Type something" option
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
				editor.focused = focused;

				// Helpers
				function refresh(options: { resetScroll?: boolean; ensureSelected?: boolean } = {}) {
					cachedRender = undefined;
					if (options.resetScroll) scrollOffset = 0;
					if (options.ensureSelected !== false) ensureSelectionVisible = true;
					tui.requestRender();
				}

				function submit(cancelled: boolean) {
					done({ questions, answers: orderedAnswers(questions, answers), cancelled });
				}

				function currentQuestion(): Question | undefined {
					return questions[currentTab];
				}

				function currentOptions(): RenderOption[] {
					const q = currentQuestion();
					if (!q) return [];
					const opts: RenderOption[] = [...q.options];
					if (q.allowOther) {
						opts.push({ value: OTHER_VALUE, label: "Type something.", isOther: true });
					}
					return opts;
				}

				function allAnswered(): boolean {
					return questions.every((q) => answers.has(q.id));
				}

				function getStoredOptionIndex(q: Question): number {
					const opts = currentOptions();
					const stored = selectedOptionByQuestion.get(q.id);
					if (stored !== undefined) return Math.max(0, Math.min(stored, opts.length - 1));

					const answer = answers.get(q.id);
					if (answer?.wasCustom && q.allowOther) return Math.max(0, opts.length - 1);
					if (answer?.index) return Math.max(0, Math.min(answer.index - 1, opts.length - 1));
					return 0;
				}

				function persistCurrentSelection() {
					const q = currentQuestion();
					const opts = currentOptions();
					if (!q || opts.length === 0) return;
					selectedOptionByQuestion.set(q.id, Math.max(0, Math.min(optionIndex, opts.length - 1)));
				}

				function switchToTab(tab: number) {
					persistCurrentSelection();
					currentTab = (tab + totalTabs) % totalTabs;
					const q = currentQuestion();
					optionIndex = q ? getStoredOptionIndex(q) : 0;
					inputMode = false;
					inputQuestionId = null;
					inputError = null;
					editor.setText("");
					refresh({ resetScroll: true });
				}

				function advanceAfterAnswer() {
					if (!isMulti) {
						submit(false);
						return;
					}
					if (currentTab < questions.length - 1) {
						switchToTab(currentTab + 1);
					} else {
						switchToTab(questions.length); // Submit tab
					}
				}

				function saveAnswer(questionId: string, value: string, label: string, wasCustom: boolean, index?: number) {
					answers.set(questionId, { id: questionId, value, label, wasCustom, index });
					const question = questions.find((q) => q.id === questionId);
					if (question) selectedOptionByQuestion.set(questionId, wasCustom ? currentOptions().length - 1 : Math.max(0, (index || 1) - 1));
				}

				function jumpToFirstUnanswered() {
					const firstUnanswered = questions.findIndex((q) => !answers.has(q.id));
					if (firstUnanswered >= 0) switchToTab(firstUnanswered);
				}

				function chooseOption(index: number) {
					const q = currentQuestion();
					const opts = currentOptions();
					if (!q || opts.length === 0 || index < 0 || index >= opts.length) return;

					optionIndex = index;
					selectedOptionByQuestion.set(q.id, index);
					const opt = opts[index];
					if (opt.isOther) {
						inputMode = true;
						inputQuestionId = q.id;
						inputError = null;
						const existing = answers.get(q.id);
						editor.setText(existing?.wasCustom ? existing.label : "");
						refresh();
						return;
					}
					saveAnswer(q.id, opt.value, opt.label, false, index + 1);
					advanceAfterAnswer();
				}

				// Editor submit callback
				editor.onSubmit = (value) => {
					if (!inputQuestionId) return;
					const trimmed = value.trim();
					if (!trimmed) {
						inputError = "Please enter a response, or press Esc to go back.";
						refresh({ ensureSelected: false });
						return;
					}
					saveAnswer(inputQuestionId, trimmed, trimmed, true);
					inputMode = false;
					inputQuestionId = null;
					inputError = null;
					editor.setText("");
					advanceAfterAnswer();
				};

				function handleInput(data: string) {
					// Input mode: route to editor
					if (inputMode) {
						if (matchesKey(data, Key.escape)) {
							inputMode = false;
							inputQuestionId = null;
							inputError = null;
							editor.setText("");
							refresh();
							return;
						}
						inputError = null;
						editor.handleInput(data);
						refresh({ ensureSelected: false });
						return;
					}

					const opts = currentOptions();

					// Tab navigation (multi-question only)
					if (isMulti) {
						if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
							switchToTab(currentTab + 1);
							return;
						}
						if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
							switchToTab(currentTab - 1);
							return;
						}
					}

					// Scrolling
					if (matchesKey(data, Key.pageUp)) {
						scrollOffset = Math.max(0, scrollOffset - lastBodyHeight);
						refresh({ ensureSelected: false });
						return;
					}
					if (matchesKey(data, Key.pageDown)) {
						scrollOffset = Math.min(Math.max(0, lastBodyLineCount - lastBodyHeight), scrollOffset + lastBodyHeight);
						refresh({ ensureSelected: false });
						return;
					}

					// Submit tab
					if (currentTab === questions.length) {
						if (matchesKey(data, Key.enter)) {
							if (allAnswered()) submit(false);
							else jumpToFirstUnanswered();
						} else if (matchesKey(data, Key.escape)) {
							submit(true);
						}
						return;
					}

					// Option navigation
					if (matchesKey(data, Key.up)) {
						optionIndex = Math.max(0, optionIndex - 1);
						persistCurrentSelection();
						refresh();
						return;
					}
					if (matchesKey(data, Key.down)) {
						optionIndex = Math.min(opts.length - 1, optionIndex + 1);
						persistCurrentSelection();
						refresh();
						return;
					}
					if (matchesKey(data, Key.home)) {
						optionIndex = 0;
						persistCurrentSelection();
						refresh();
						return;
					}
					if (matchesKey(data, Key.end)) {
						optionIndex = Math.max(0, opts.length - 1);
						persistCurrentSelection();
						refresh();
						return;
					}

					// Number shortcuts, 1-9
					const printable = parseKey(data) ?? (data.length === 1 ? data : undefined);
					if (printable && /^[1-9]$/.test(printable)) {
						const index = Number(printable) - 1;
						if (index < opts.length) {
							chooseOption(index);
							return;
						}
					}

					// Select option
					if (matchesKey(data, Key.enter)) {
						chooseOption(optionIndex);
						return;
					}

					// Cancel
					if (matchesKey(data, Key.escape)) {
						submit(true);
					}
				}

				function render(width: number): string[] {
					const rows = tui.terminal.rows || 24;
					if (cachedRender && cachedRender.width === width && cachedRender.rows === rows) return cachedRender.lines;

					const q = currentQuestion();
					const opts = currentOptions();
					const headerLines: string[] = [];
					const bodyLines: string[] = [];
					const footerLines: string[] = [];
					let selectedBodyLine: number | undefined;

					const add = (target: string[], s: string) => target.push(truncateToWidth(s, width));
					const addWrapped = (target: string[], text: string, indent = "") => {
						const wrapped = wrapTextWithAnsi(text, Math.max(1, width - indent.length));
						if (wrapped.length === 0) {
							add(target, indent);
							return;
						}
						for (const line of wrapped) add(target, `${indent}${line}`);
					};
					const addOptionLabel = (text: string, prefix: string) => {
						const wrapped = wrapTextWithAnsi(text, Math.max(1, width - 2));
						if (wrapped.length === 0) {
							add(bodyLines, prefix);
							return;
						}
						add(bodyLines, prefix + wrapped[0]);
						for (const line of wrapped.slice(1)) add(bodyLines, `  ${line}`);
					};

					add(headerLines, theme.fg("accent", "─".repeat(width)));

					// Tab bar (multi-question only)
					if (isMulti) {
						const tabs: string[] = ["← "];
						for (let i = 0; i < questions.length; i++) {
							const isActive = i === currentTab;
							const isAnswered = answers.has(questions[i].id);
							const lbl = questions[i].label;
							const box = isAnswered ? "■" : "□";
							const color = isAnswered ? "success" : "muted";
							const text = ` ${box} ${lbl} `;
							const styled = isActive ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg(color, text);
							tabs.push(`${styled} `);
						}
						const canSubmit = allAnswered();
						const isSubmitTab = currentTab === questions.length;
						const submitText = " ✓ Submit ";
						const submitStyled = isSubmitTab
							? theme.bg("selectedBg", theme.fg("text", submitText))
							: theme.fg(canSubmit ? "success" : "dim", submitText);
						tabs.push(`${submitStyled} →`);
						add(headerLines, ` ${tabs.join("")}`);
						headerLines.push("");
					}

					// Helper to render options list
					function renderOptions() {
						for (let i = 0; i < opts.length; i++) {
							const opt = opts[i];
							const selected = i === optionIndex;
							const isOther = opt.isOther === true;
							const existing = q ? answers.get(q.id) : undefined;
							const isCurrentAnswer =
								!!existing && ((isOther && existing.wasCustom) || (!isOther && !existing.wasCustom && existing.value === opt.value));
							const prefix = selected ? theme.fg("accent", "> ") : "  ";
							const color = selected ? "accent" : isCurrentAnswer ? "success" : "text";
							if (selected) selectedBodyLine = bodyLines.length;

							const currentMarker = isCurrentAnswer ? theme.fg("success", " ✓ current") : "";
							const editMarker = isOther && inputMode ? " ✎" : "";
							addOptionLabel(theme.fg(color, `${i + 1}. ${opt.label}${editMarker}`) + currentMarker, prefix);

							if (opt.description) {
								addWrapped(bodyLines, theme.fg("muted", normalizeDescription(opt.description)), "     ");
							}
						}
					}

					// Content
					if (inputMode && q) {
						addWrapped(bodyLines, theme.fg("text", q.prompt), " ");
						bodyLines.push("");
						renderOptions();
						bodyLines.push("");
						add(bodyLines, theme.fg("muted", " Your answer:"));
						for (const line of editor.render(width - 2)) {
							add(bodyLines, ` ${line}`);
						}
						if (inputError) addWrapped(bodyLines, theme.fg("warning", inputError), " ");
					} else if (currentTab === questions.length) {
						add(bodyLines, theme.fg("accent", theme.bold(" Ready to submit")));
						bodyLines.push("");
						for (const question of questions) {
							const answer = answers.get(question.id);
							if (answer) {
								const prefix = answer.wasCustom ? "(wrote) " : "";
								addWrapped(
									bodyLines,
									`${theme.fg("muted", `${question.label}: `)}${theme.fg("text", prefix + answer.label)}`,
									" ",
								);
							}
						}
						bodyLines.push("");
						if (allAnswered()) {
							add(bodyLines, theme.fg("success", " Press Enter to submit"));
						} else {
							const missing = questions
								.filter((q) => !answers.has(q.id))
								.map((q) => q.label)
								.join(", ");
							addWrapped(bodyLines, theme.fg("warning", `Unanswered: ${missing}`), " ");
							add(bodyLines, theme.fg("dim", " Press Enter to jump to the first unanswered question"));
						}
					} else if (q) {
						addWrapped(bodyLines, theme.fg("text", q.prompt), " ");
						const answer = answers.get(q.id);
						if (answer) {
							const prefix = answer.wasCustom ? "(wrote) " : "";
							addWrapped(bodyLines, `${theme.fg("muted", "Current answer: ")}${theme.fg("text", prefix + answer.label)}`, " ");
							add(bodyLines, theme.fg("dim", " Select another option to replace it."));
						}
						bodyLines.push("");
						renderOptions();
					}

					footerLines.push("");
					if (inputMode) {
						add(footerLines, theme.fg("dim", " Enter to submit • Esc to go back"));
					} else if (currentTab === questions.length && !allAnswered()) {
						add(footerLines, theme.fg("dim", " Enter first unanswered • Tab/←→ navigate • Esc cancel"));
					} else {
						const help = isMulti
							? " Tab/←→ navigate • ↑↓ select • 1-9 quick select • Enter confirm • PgUp/PgDn scroll • Esc cancel"
							: " ↑↓ navigate • 1-9 quick select • Enter select • PgUp/PgDn scroll • Esc cancel";
						add(footerLines, theme.fg("dim", help));
					}
					add(footerLines, theme.fg("accent", "─".repeat(width)));

					const availableRows = Math.max(4, rows - 4);
					let bodyHeight = Math.max(1, availableRows - headerLines.length - footerLines.length);
					let needsScrolling = bodyLines.length > bodyHeight;
					let scrollInfoIndex: number | undefined;
					if (needsScrolling) {
						scrollInfoIndex = footerLines.length - 1;
						footerLines.splice(scrollInfoIndex, 0, "");
						bodyHeight = Math.max(1, availableRows - headerLines.length - footerLines.length);
						needsScrolling = bodyLines.length > bodyHeight;
					}

					lastBodyHeight = bodyHeight;
					lastBodyLineCount = bodyLines.length;
					const maxScroll = Math.max(0, bodyLines.length - bodyHeight);
					scrollOffset = Math.max(0, Math.min(scrollOffset, maxScroll));

					if (ensureSelectionVisible && selectedBodyLine !== undefined) {
						if (selectedBodyLine < scrollOffset) {
							scrollOffset = selectedBodyLine;
						} else if (selectedBodyLine >= scrollOffset + bodyHeight) {
							scrollOffset = selectedBodyLine - bodyHeight + 1;
						}
						scrollOffset = Math.max(0, Math.min(scrollOffset, maxScroll));
					}
					ensureSelectionVisible = false;
					if (scrollInfoIndex !== undefined) {
						footerLines[scrollInfoIndex] = theme.fg(
							"dim",
							` Showing ${Math.min(scrollOffset + 1, bodyLines.length)}-${Math.min(scrollOffset + bodyHeight, bodyLines.length)} of ${bodyLines.length}`,
						);
					}

					const visibleBody = needsScrolling ? bodyLines.slice(scrollOffset, scrollOffset + bodyHeight) : bodyLines;
					const lines = [...headerLines, ...visibleBody, ...footerLines];

					cachedRender = { width, rows, lines };
					return lines;
				}

				return {
					get focused() {
						return focused;
					},
					set focused(value: boolean) {
						focused = value;
						editor.focused = value;
					},
					render,
					invalidate: () => {
						cachedRender = undefined;
					},
					handleInput,
				};
			});

			if (result.cancelled) {
				return {
					content: [{ type: "text", text: "User cancelled the questionnaire" }],
					details: result,
				};
			}

			return {
				content: [{ type: "text", text: formatAnswerLines(questions, result.answers).join("\n") }],
				details: result,
			};
		},

		renderCall(args, theme, _context) {
			const qs = (args.questions as Question[]) || [];
			const count = qs.length;
			const labels = qs.map((q) => q.label || q.id).join(", ");
			let text = theme.fg("toolTitle", theme.bold("questionnaire "));
			text += theme.fg("muted", `${count} question${count !== 1 ? "s" : ""}`);
			if (labels) {
				text += theme.fg("dim", ` (${truncateToWidth(labels, 40)})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as QuestionnaireResult | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}
			const lines = details.answers.map((a) => {
				if (a.wasCustom) {
					return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${theme.fg("muted", "(wrote) ")}${a.label}`;
				}
				const display = a.index ? `${a.index}. ${a.label}` : a.label;
				return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${display}`;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
