// @ts-nocheck
import { Copy } from "lucide-react";
import { Fragment, useState } from "react";
import type { ReactNode } from "react";
import { copyTextToClipboard } from "./clipboard";
import { cn } from "./classNames";

export function CodeBlock({
	language,
	text,
}: {
	language: string;
	text: string;
}) {
	const [copied, setCopied] = useState(false);
	const label = formatCodeLanguage(language);

	async function copyCode() {
		if (await copyTextToClipboard(text)) {
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1200);
		}
	}

	return (
		<figure className={cn("message-code-block")}>
			<figcaption className={cn("message-code-header")}>
				<span>{label}</span>
				<button
					type="button"
					className={cn("message-code-copy")}
					onMouseDown={(event) => event.preventDefault()}
					onClick={copyCode}
				>
					<Copy size={15} />
					<span>{copied ? "已复制" : "复制"}</span>
				</button>
			</figcaption>
			<pre className={cn("message-code-pre")}>
				<code>{renderHighlightedCode(text, language)}</code>
			</pre>
		</figure>
	);
}

const codeLanguageNames: Record<string, string> = {
	bash: "SHELL",
	shell: "SHELL",
	sh: "SHELL",
	zsh: "SHELL",
	javascript: "JS",
	js: "JS",
	jsx: "JSX",
	typescript: "TS",
	ts: "TS",
	tsx: "TSX",
	json: "JSON",
	sql: "SQL",
	html: "HTML",
	css: "CSS",
	markdown: "MD",
	md: "MD",
};

const codeKeywords = new Set([
	"as",
	"async",
	"await",
	"break",
	"case",
	"catch",
	"class",
	"const",
	"continue",
	"default",
	"do",
	"else",
	"export",
	"extends",
	"finally",
	"for",
	"from",
	"function",
	"if",
	"import",
	"in",
	"interface",
	"let",
	"new",
	"return",
	"switch",
	"throw",
	"try",
	"type",
	"var",
	"while",
]);

const codeLiterals = new Set(["false", "null", "true", "undefined"]);

function formatCodeLanguage(language: string) {
	const normalized = language.trim().toLowerCase();
	if (!normalized) {
		return "CODE";
	}

	return codeLanguageNames[normalized] ?? normalized.toUpperCase();
}

function renderHighlightedCode(value: string, language: string) {
	const lines = value.split("\n");
	return lines.flatMap((line, index) => {
		const keyPrefix = `line-${index}`;
		const nodes = highlightCodeLine(line, language, keyPrefix);
		if (index < lines.length - 1) {
			nodes.push(<br key={`${keyPrefix}-br`} />);
		}
		return nodes;
	});
}

function highlightCodeLine(line: string, language: string, keyPrefix: string) {
	const nodes: ReactNode[] = [];
	const normalizedLanguage = language.trim().toLowerCase();
	const hashCommentPrefix = [
		"bash",
		"shell",
		"sh",
		"zsh",
		"py",
		"python",
		"yaml",
		"yml",
	].includes(normalizedLanguage)
		? "#.*|"
		: "";
	const pattern = new RegExp(
		`("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|\\\`(?:\\\\.|[^\\\`\\\\])*\\\`|\\/\\/.*|${hashCommentPrefix}--[\\w-]+|\\b\\d+(?:\\.\\d+)?\\b|\\b[A-Za-z_$][\\w$-]*\\b|[{}()[\\].,:;+\\-*/%=&|!<>?]+)`,
		"g",
	);
	let cursor = 0;
	let match: RegExpExecArray | null = pattern.exec(line);

	while (match) {
		if (match.index > cursor) {
			nodes.push(line.slice(cursor, match.index));
		}

		const token = match[0];
		const kind = getCodeTokenKind(token, line, match.index, language);
		nodes.push(
			kind ? (
				<span
					key={`${keyPrefix}-${match.index}`}
					className={cn(`code-token ${kind}`)}
				>
					{token}
				</span>
			) : (
				<Fragment key={`${keyPrefix}-${match.index}`}>{token}</Fragment>
			),
		);

		cursor = match.index + token.length;
		match = pattern.exec(line);
	}

	if (cursor < line.length) {
		nodes.push(line.slice(cursor));
	}

	return nodes;
}

function getCodeTokenKind(
	token: string,
	line: string,
	index: number,
	language: string,
) {
	const normalizedLanguage = language.trim().toLowerCase();
	const isShell = ["bash", "shell", "sh", "zsh"].includes(normalizedLanguage);

	if (token.startsWith("//") || token.startsWith("#")) {
		return "comment";
	}
	if (/^["'`]/.test(token)) {
		return "string";
	}
	if (/^--[\w-]+$/.test(token)) {
		return "attr";
	}
	if (/^\d/.test(token)) {
		return "number";
	}
	if (codeKeywords.has(token)) {
		return "keyword";
	}
	if (codeLiterals.has(token)) {
		return "literal";
	}
	if (isShell && line.slice(0, index).trim() === "") {
		return "function";
	}
	if (
		/^[A-Za-z_$][\w$-]*$/.test(token) &&
		/^\s*\(/.test(line.slice(index + token.length))
	) {
		return "function";
	}

	return "";
}
