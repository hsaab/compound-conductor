/**
 * Unit tests for Slack Block Kit helpers. These are pure functions (no
 * network), so they run without any API keys.
 *
 * Run with: pnpm test
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { statusBlocks } from "../integrations/slack.js";

interface TestBlock {
  type: string;
  text?: { type: string; text: string };
  fields?: Array<{ type: string; text: string }>;
  elements?: Array<{ type: string; text: string }>;
}

function blocksOf(msg: { blocks?: unknown[] }): TestBlock[] {
  return (msg.blocks ?? []) as TestBlock[];
}

function slackPayload(msg: { text: string; blocks?: unknown[] }): string {
  return `${msg.text}\n${JSON.stringify(msg.blocks ?? [])}`;
}

test("a deploy-shaped status still posts a readable organized Slack message", () => {
  const headline = "🛠️ compound hotfix deployed to production";
  const freeform = "Verify is re-running the test plan against production.";
  const msg = statusBlocks(headline, [
    "Ticket: ENG-9 — Fix quote TTL cache",
    "Deploy: https://compound.vercel.app",
    freeform,
  ]);
  const blocks = blocksOf(msg);

  assert.equal(blocks[0]?.type, "header");
  assert.equal(blocks[0]?.text?.type, "plain_text");
  assert.equal(blocks[0]?.text?.text, headline);
  assert.ok(!blocks[0]?.text?.text.includes("*"), "header text must not wrap the headline in asterisks");

  const fieldSection = blocks.find((block) => (block.fields?.length ?? 0) > 0);
  assert.ok(fieldSection, "labeled Ticket / Deploy lines should become section fields");
  assert.ok((fieldSection?.fields?.length ?? 0) <= 10, "Slack section fields are capped at 10");
  assert.equal(fieldSection?.fields?.length, 2);

  const fieldText = (fieldSection?.fields ?? []).map((field) => field.text).join("\n");
  assert.match(fieldText, /Ticket/);
  assert.match(fieldText, /ENG-9/);
  assert.match(fieldText, /Deploy/);
  assert.match(fieldText, /compound\.vercel\.app/);
  assert.ok(
    !(fieldSection?.fields ?? []).some((field) => field.text.includes(freeform)),
    "unlabeled leftover lines stay out of fields",
  );

  const sectionText = blocks
    .filter((block) => block.type === "section")
    .map((block) => block.text?.text ?? "")
    .join("\n");
  assert.ok(sectionText.includes(freeform), "unlabeled leftover lines stay in a sanitized mrkdwn section");

  const last = blocks[blocks.length - 1];
  assert.equal(last?.type, "context");
  assert.equal(last?.elements?.[0]?.text, "conductor");

  assert.ok(msg.text.includes("ENG-9"));
  assert.ok(msg.text.includes(freeform));
});

test("a long ticket-prefixed status headline still shows the ticket id after Slack's 150-character header cap", () => {
  const headline = `🛠️ ENG-9 — ${"quotes cache still serving stale TTL ".repeat(8)}hotfix deployed`;
  assert.ok(headline.length > 150);

  const msg = statusBlocks(headline, ["Ticket: ENG-9 — Fix quote TTL cache"]);
  const header = blocksOf(msg)[0];

  assert.equal(header?.type, "header");
  assert.equal(header?.text?.type, "plain_text");
  assert.ok((header?.text?.text.length ?? 0) <= 150);
  assert.match(header?.text?.text ?? "", /ENG-9/);
  assert.ok(!header?.text?.text.includes("*"), "truncated header text must not contain asterisks");
});

test("statusBlocks turns GitHub markdown Slack cannot render into readable Slack text", () => {
  const imgWithAlt =
    '<img alt="Quotes API URL shows ERR_CONNECTION_CLOSED" src="/opt/cursor/artifacts/fe13.webp">';
  const imgWithoutAlt = '<img src="/opt/cursor/artifacts/fe13.webp">';
  const msg = statusBlocks("🛠️ compound hotfix deployed to production", [
    `Evidence: ${imgWithAlt}`,
    imgWithoutAlt,
    "Observed **bold** failure on refresh.",
    "| table | row |",
  ]);
  const payload = slackPayload(msg);

  assert.ok(payload.includes("Quotes API URL shows ERR_CONNECTION_CLOSED"));
  assert.ok(!payload.includes("<img"), "raw <img tags must not leak into Slack text or blocks");
  assert.ok(!payload.includes("**"), "GitHub **bold** must not leak; Slack mrkdwn uses *bold*");
  assert.match(payload, /(?<!\*)\*bold\*(?!\*)/);
  assert.doesNotMatch(payload, /\|\s*table\s*\|/, "a leftover | table | row must not appear as pipe-delimited markdown");
});
