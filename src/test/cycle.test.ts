/**
 * Attachment fallback for initial-cycle merge: a GitHub PR Linear attached
 * after fleet-started stands in when agent-done comments still lack `PR:`.
 *
 * Run with: pnpm test
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { attachmentPrUrls, hotfixPrUrls, INITIAL_PIPELINE_CYCLE } from "../pipeline/cycle.js";
import { markers } from "../config.js";
import type { LinearIssuePayload } from "../types.js";

const FLEET_STARTED_AT = "2026-06-02T11:00:00.000Z";
const AFTER_FLEET_START = "2026-06-02T11:05:00.000Z";
const BEFORE_FLEET_START = "2026-06-01T10:00:00.000Z";
const PR_URL = "https://github.com/hsaab/compound/pull/145";
const HOTFIX_PR_URL = "https://github.com/hsaab/compound/pull/146";

const compoundSpawn =
  `${markers.bridge}\n**Cursor agent spawned**\n\nAgent ID: \`bc-aaa-111\`\nRepo: \`hsaab/compound\``;
const agentDoneNoPr = `${markers.agentDone("bc-aaa-111")}\nPR: (no PR opened)`;
const agentDoneWithPr = `${markers.agentDone("bc-aaa-111")}\nPR: ${PR_URL}`;
const remediationSpawned =
  `${markers.remediationSpawned("bc-fix-222")}\n${markers.remediated}\nAgent ID: \`bc-fix-222\`\nRepo: \`hsaab/compound\``;
const remediationDoneWithPr = `${markers.remediationDone("bc-fix-222")}\nPR: ${HOTFIX_PR_URL}`;

type Attachment = { url?: string; createdAt?: string };

function issue(opts: {
  comments: Array<{ body: string; createdAt?: string }>;
  attachments?: Attachment[];
}): LinearIssuePayload {
  return {
    id: "issue-1",
    identifier: "ENG-1",
    title: "Test",
    comments: opts.comments,
    attachments: opts.attachments,
  } as LinearIssuePayload;
}

function fleetWithDoneNoPr(
  fleetStartedAt?: string,
): Array<{ body: string; createdAt?: string }> {
  return [
    { body: markers.fleetStarted, createdAt: fleetStartedAt },
    { body: compoundSpawn },
    { body: agentDoneNoPr },
  ];
}

test("initial-cycle merge sees a GitHub PR Linear attached after this fleet started, even when agent-done has no PR line", () => {
  const ticket = issue({
    comments: fleetWithDoneNoPr(FLEET_STARTED_AT),
    attachments: [{ url: PR_URL, createdAt: AFTER_FLEET_START }],
  });
  assert.deepEqual(INITIAL_PIPELINE_CYCLE.prUrls(ticket), [PR_URL]);
  assert.deepEqual(attachmentPrUrls(ticket, FLEET_STARTED_AT), [PR_URL]);
});

test("a GitHub PR attached before this fleet started is ignored as an old demo PR", () => {
  const ticket = issue({
    comments: fleetWithDoneNoPr(FLEET_STARTED_AT),
    attachments: [{ url: PR_URL, createdAt: BEFORE_FLEET_START }],
  });
  assert.deepEqual(attachmentPrUrls(ticket, FLEET_STARTED_AT), []);
  assert.deepEqual(INITIAL_PIPELINE_CYCLE.prUrls(ticket), []);
});

test("a GitHub PR attached on a repo this fleet did not spawn is ignored", () => {
  const ticket = issue({
    comments: fleetWithDoneNoPr(FLEET_STARTED_AT),
    attachments: [{ url: "https://github.com/other/other/pull/1", createdAt: AFTER_FLEET_START }],
  });
  assert.deepEqual(attachmentPrUrls(ticket, FLEET_STARTED_AT), []);
  assert.deepEqual(INITIAL_PIPELINE_CYCLE.prUrls(ticket), []);
});

test("Linear attachments that are not GitHub pull requests are ignored", () => {
  const ticket = issue({
    comments: fleetWithDoneNoPr(FLEET_STARTED_AT),
    attachments: [
      { url: "https://github.com/hsaab/compound/issues/145", createdAt: AFTER_FLEET_START },
      { url: "https://github.com/hsaab/compound/compare/main...feature", createdAt: AFTER_FLEET_START },
      { url: "https://github.com/hsaab/compound/commit/abc123def456", createdAt: AFTER_FLEET_START },
      { url: "https://docs.github.com/en/pull-requests", createdAt: AFTER_FLEET_START },
    ],
  });
  assert.deepEqual(attachmentPrUrls(ticket, FLEET_STARTED_AT), []);
  assert.deepEqual(INITIAL_PIPELINE_CYCLE.prUrls(ticket), []);
});

test("attachments are ignored when the fleet-started comment has no timestamp", async () => {
  const ticket = issue({
    comments: fleetWithDoneNoPr(undefined),
    attachments: [{ url: PR_URL, createdAt: AFTER_FLEET_START }],
  });
  assert.deepEqual(INITIAL_PIPELINE_CYCLE.prUrls(ticket), []);
});

test("a Linear attachment without a createdAt is ignored", () => {
  const ticket = issue({
    comments: fleetWithDoneNoPr(FLEET_STARTED_AT),
    attachments: [{ url: PR_URL }],
  });
  assert.deepEqual(attachmentPrUrls(ticket, FLEET_STARTED_AT), []);
  assert.deepEqual(INITIAL_PIPELINE_CYCLE.prUrls(ticket), []);
});

test("a different attached PR is ignored when every spawned agent already has a PR line", () => {
  const ticket = issue({
    comments: [
      { body: markers.fleetStarted, createdAt: FLEET_STARTED_AT },
      { body: compoundSpawn },
      { body: agentDoneWithPr },
    ],
    attachments: [{ url: "https://github.com/hsaab/compound/pull/999", createdAt: AFTER_FLEET_START }],
  });
  assert.deepEqual(INITIAL_PIPELINE_CYCLE.prUrls(ticket), [PR_URL]);
});

test("the same PR URL on agent-done and a Linear attachment is listed once", () => {
  const ticket = issue({
    comments: [
      { body: markers.fleetStarted, createdAt: FLEET_STARTED_AT },
      { body: compoundSpawn },
      { body: agentDoneWithPr },
    ],
    attachments: [{ url: PR_URL, createdAt: AFTER_FLEET_START }],
  });
  assert.deepEqual(INITIAL_PIPELINE_CYCLE.prUrls(ticket), [PR_URL]);
});

test("hotfix merge uses only remediation-done PR lines and ignores Linear attachments", () => {
  const ticket = issue({
    comments: [
      { body: markers.fleetStarted, createdAt: FLEET_STARTED_AT },
      { body: compoundSpawn },
      { body: agentDoneNoPr },
      { body: markers.fleetComplete },
      { body: markers.deployed },
      { body: remediationSpawned },
      { body: remediationDoneWithPr },
    ],
    attachments: [{ url: PR_URL, createdAt: AFTER_FLEET_START }],
  });
  assert.deepEqual(hotfixPrUrls(ticket), [HOTFIX_PR_URL]);
  assert.ok(!hotfixPrUrls(ticket).includes(PR_URL));
});
