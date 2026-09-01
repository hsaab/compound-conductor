/**
 * Slack output for conductor. The observability and remediation stages post
 * human-readable status here. Output only: conductor never accepts commands from
 * Slack (agent spawning stays gated behind Linear + signed webhooks).
 *
 * Best-effort by design: a missing webhook URL or a transient Slack error never
 * breaks the pipeline, it just logs and moves on.
 */
import { slackWebhookUrl } from "../config.js";

export interface SlackMessage {
  /** Fallback text and notification summary. */
  text: string;
  /** Optional richer Block Kit payload; falls back to `text` when omitted. */
  blocks?: unknown[];
}

/**
 * Post a message to the configured Slack incoming webhook.
 * Returns true on a 2xx response, false otherwise (never throws).
 */
export async function postSlack(message: SlackMessage): Promise<boolean> {
  const url = slackWebhookUrl();
  if (!url) {
    console.warn("[slack] SLACK_WEBHOOK_URL not set; skipping message:", message.text);
    return false;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message.blocks ? { text: message.text, blocks: message.blocks } : { text: message.text }),
    });
    if (!res.ok) {
      console.error(`[slack] webhook returned ${res.status}: ${await res.text().catch(() => "")}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[slack] failed to post message:", err);
    return false;
  }
}

const SLACK_HEADER_CHAR_CAP = 150;
const SLACK_SECTION_FIELD_CAP = 10;
const SLACK_SECTION_FIELD_TEXT_CAP = 2000;

const HTML_ELEMENT_NAMES = new Set([
  "a", "abbr", "address", "area", "article", "aside", "audio", "b", "base", "bdi",
  "bdo", "blockquote", "body", "br", "button", "canvas", "caption", "cite", "code",
  "col", "colgroup", "data", "datalist", "dd", "del", "details", "dfn", "dialog",
  "div", "dl", "dt", "em", "embed", "fieldset", "figcaption", "figure", "footer",
  "form", "h1", "h2", "h3", "h4", "h5", "h6", "head", "header", "hgroup", "hr",
  "html", "i", "iframe", "img", "input", "ins", "kbd", "label", "legend", "li",
  "link", "main", "map", "mark", "menu", "meta", "meter", "nav", "noscript",
  "object", "ol", "optgroup", "option", "output", "p", "picture", "pre", "progress",
  "q", "rp", "rt", "ruby", "s", "samp", "script", "search", "section", "select",
  "slot", "small", "source", "span", "strong", "style", "sub", "summary", "sup",
  "table", "tbody", "td", "template", "textarea", "tfoot", "th", "thead", "time",
  "title", "tr", "track", "u", "ul", "var", "video", "wbr",
]);

/** HTML tags only; Slack `<https://url>` autolinks do not have a space or `/` after the name. */
const HTML_TAG_RE = /<\/?([a-zA-Z][a-zA-Z0-9]*)(\s[^>]*|\/)?>/g;
const TABLE_SEPARATOR_RE = /^:?-{2,}:?$/;
const LABELED_LINE_RE = /^([A-Za-z][A-Za-z0-9 _/-]{0,38}):\s+(\S.*)$/;

function imgAltOrEmpty(tag: string): string {
  const match = tag.match(/\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
}

/** Finds the closing `>` of a tag, ignoring `>` that sit inside quoted attribute values. */
function quoteAwareTagEnd(text: string, from: number): number {
  let quote: '"' | "'" | null = null;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ">") return i;
  }
  return -1;
}

function replaceImgTags(line: string): string {
  const startRe = /<img\b/gi;
  let out = "";
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = startRe.exec(line)) !== null) {
    const start = match.index;
    out += line.slice(last, start);
    const end = quoteAwareTagEnd(line, start + match[0].length);
    if (end === -1) {
      out += imgAltOrEmpty(line.slice(start));
      return out;
    }
    out += imgAltOrEmpty(line.slice(start, end + 1));
    last = end + 1;
    startRe.lastIndex = last;
  }
  out += line.slice(last);
  return out;
}

function stripHtmlTag(full: string, name: string, suffix?: string): string {
  if (suffix) return "";
  return HTML_ELEMENT_NAMES.has(name.toLowerCase()) ? "" : full;
}

function sanitizePhysicalLine(line: string): string {
  let out = replaceImgTags(line);
  out = out.replace(HTML_TAG_RE, stripHtmlTag);
  out = out.replace(/\*\*/g, "*");
  if (out.includes("|")) {
    out = out
      .split("|")
      .map((cell) => cell.trim())
      .filter((cell) => cell.length > 0 && !TABLE_SEPARATOR_RE.test(cell))
      .join(" ");
  }
  return out.trim();
}

/**
 * Slack-safe line: `<img alt>` becomes alt text, other HTML is dropped,
 * GitHub `**` becomes Slack `*`, and `|` table-row noise is stripped.
 */
export function sanitizeSlackLine(text: string): string {
  return text
    .split("\n")
    .map(sanitizePhysicalLine)
    .filter((line) => line.length > 0)
    .join("\n");
}

function parseLabeledLine(line: string): { label: string; value: string } | null {
  if (line.includes("\n")) return null;
  const match = line.match(LABELED_LINE_RE);
  return match ? { label: match[1].trim(), value: match[2].trim() } : null;
}

/** Truncates on code points and keeps UTF-16 length at Slack's character cap. */
function capSlackText(text: string, cap: number): string {
  const chars = [...text];
  if (chars.length <= cap && text.length <= cap) {
    return text;
  }
  const budget = cap - 1;
  let out = "";
  for (const ch of chars) {
    if (out.length + ch.length > budget) break;
    out += ch;
  }
  return `${out}…`;
}

function capHeaderText(headline: string): string {
  return capSlackText(headline.replace(/\*/g, ""), SLACK_HEADER_CHAR_CAP);
}

function capFieldText(text: string): string {
  return capSlackText(text, SLACK_SECTION_FIELD_TEXT_CAP);
}

/** Builds a header + section + context Block Kit message from a headline and detail lines. */
export function statusBlocks(headline: string, lines: string[]): SlackMessage {
  const sanitized = lines.map(sanitizeSlackLine).filter((line) => line.length > 0);
  const labeled: Array<{ label: string; value: string }> = [];
  const leftover: string[] = [];
  for (const line of sanitized) {
    const parsed = parseLabeledLine(line);
    if (parsed && labeled.length < SLACK_SECTION_FIELD_CAP) {
      labeled.push(parsed);
    } else {
      leftover.push(line);
    }
  }

  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: capHeaderText(headline) } },
  ];
  if (labeled.length > 0) {
    blocks.push({
      type: "section",
      fields: labeled.map((field) => ({
        type: "mrkdwn",
        text: capFieldText(`*${field.label}:* ${field.value}`),
      })),
    });
  }
  if (leftover.length > 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: leftover.join("\n") },
    });
  }
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "conductor" }] });

  return {
    text: `${headline}\n${sanitized.join("\n")}`,
    blocks,
  };
}
