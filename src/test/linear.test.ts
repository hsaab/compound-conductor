/**
 * Unit tests for the comment-parsing helpers that back the reconciler. These
 * are pure functions (no network), so they run without any API keys.
 *
 * Run with: pnpm test
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bridgeReactionId,
  hasComment,
  isBridgeComment,
  issueRefFromBody,
  parseAgentResults,
  parseDoneAgentIds,
  parseRemediationResults,
  parseSpawnedAgents,
  parseTestPlan,
} from "../integrations/linear.js";
import { markers } from "../config.js";
import type { LinearIssuePayload } from "../types.js";

function issueWith(bodies: string[]): LinearIssuePayload {
  return {
    id: "issue-1",
    identifier: "ENG-1",
    title: "Test",
    comments: bodies.map((body) => ({ body })),
  };
}

const compoundSpawn = "**Cursor agent spawned**\n\nAgent ID: `bc-aaa-111`\nRepo: `hsaab/compound`";
const serverSpawn = "**Cursor agent spawned**\n\nAgent ID: `bc-bbb-222`\nRepo: `hsaab/server`";
const legacyHeroSpawn = "**Cursor Hero agent spawned**\n\nAgent ID: `bc-ccc-333`\nRepo: `hsaab/compound`";

test("parseSpawnedAgents extracts agent id and repo from spawn comments", () => {
  const agents = parseSpawnedAgents(issueWith([markers.fleetStarted, compoundSpawn, serverSpawn]));
  assert.deepEqual(agents, [
    { agentId: "bc-aaa-111", repo: "hsaab/compound" },
    { agentId: "bc-bbb-222", repo: "hsaab/server" },
  ]);
});

test("parseSpawnedAgents skips spawn comments without a repo line", () => {
  const agents = parseSpawnedAgents(
    issueWith(["**Cursor agent spawned**\n\nAgent ID: `bc-aaa-111`"]),
  );
  assert.deepEqual(agents, []);
});

test("parseSpawnedAgents de-duplicates repeated agent ids", () => {
  const agents = parseSpawnedAgents(issueWith([compoundSpawn, compoundSpawn]));
  assert.equal(agents.length, 1);
});

test("parseSpawnedAgents ignores completion comments", () => {
  const done = `${markers.agentDone("bc-aaa-111")}\n**Cursor compound agent finished**`;
  assert.deepEqual(parseSpawnedAgents(issueWith([done])), []);
});

test("parseDoneAgentIds reads agent-done markers", () => {
  const issue = issueWith([
    compoundSpawn,
    `${markers.agentDone("bc-aaa-111")}\n**Cursor compound agent finished**`,
  ]);
  const done = parseDoneAgentIds(issue);
  assert.ok(done.has("bc-aaa-111"));
  assert.ok(!done.has("bc-bbb-222"));
});

test("hasComment matches embedded markers", () => {
  const issue = issueWith([`${markers.fleetComplete}\n**Cursor fleet complete**`]);
  assert.ok(hasComment(issue, markers.fleetComplete));
  assert.ok(!hasComment(issue, markers.fleetStarted));
});

test("isBridgeComment recognizes every bridge marker and ignores user comments", () => {
  assert.ok(isBridgeComment(markers.fleetStarted));
  assert.ok(isBridgeComment(markers.fleetComplete));
  assert.ok(isBridgeComment(markers.agentDone("bc-aaa-111")));
  assert.ok(isBridgeComment(`${markers.bridge}\n**Cursor agent spawned**`));
  assert.ok(isBridgeComment(legacyHeroSpawn));
  assert.ok(isBridgeComment("**Cursor fleet accepted**\n\nTrigger: `linear-webhook`"));
  assert.ok(!isBridgeComment("Looks good to me, shipping this."));
  assert.ok(!isBridgeComment(null));
});

test("isBridgeComment recognizes a deploy-buffered comment", () => {
  assert.ok(isBridgeComment("<!-- conductor:deploy-buffered -->\n**Deploy buffered**"));
});

test("isBridgeComment recognizes a hotfix-deploy-buffered comment", () => {
  assert.ok(isBridgeComment("<!-- conductor:hotfix-deploy-buffered -->\n**Hotfix deploy buffered**"));
});

test("issueRefFromBody accepts issueId, identifier, or id and trims whitespace", () => {
  // /api/trigger and /api/reset must accept the same keys; DEMO_FLOW §7 sends `identifier`.
  assert.equal(issueRefFromBody({ issueId: "FE-7" }), "FE-7");
  assert.equal(issueRefFromBody({ identifier: "FE-13" }), "FE-13");
  assert.equal(issueRefFromBody({ id: "uuid-123" }), "uuid-123");
  assert.equal(issueRefFromBody({ identifier: "  FE-5  " }), "FE-5");
  // Precedence: issueId > identifier > id.
  assert.equal(issueRefFromBody({ issueId: "A", identifier: "B", id: "C" }), "A");
});

test("issueRefFromBody returns undefined for missing/blank/non-string refs", () => {
  assert.equal(issueRefFromBody({}), undefined);
  assert.equal(issueRefFromBody({ identifier: "   " }), undefined);
  assert.equal(issueRefFromBody({ issueId: 123 }), undefined);
  assert.equal(issueRefFromBody(undefined), undefined);
  assert.equal(issueRefFromBody(null), undefined);
});

test("parseTestPlan reads cases from the fenced JSON block in a test-plan comment", () => {
  const body = `${markers.testPlan}
**Test plan**

\`\`\`json
{"cases":[{"title":"Chat opens","steps":"Click advisor widget"}]}
\`\`\``;
  const cases = parseTestPlan(issueWith([body]));
  assert.deepEqual(cases, [{ title: "Chat opens", steps: "Click advisor widget" }]);
});

const latePrUrl = "https://github.com/hsaab/compound/pull/7";
const lateHotfixPrUrl = "https://github.com/hsaab/compound/pull/9";
const agentDoneNoPr = `${markers.agentDone("bc-aaa-111")}\nPR: (no PR opened)`;
const agentDoneWithPr = `${markers.agentDone("bc-aaa-111")}\nPR: ${latePrUrl}`;
const remediationDoneNoPr = `${markers.remediationDone("bc-fix-222")}\nPR: (no PR opened)`;
const remediationDoneWithPr = `${markers.remediationDone("bc-fix-222")}\nPR: ${lateHotfixPrUrl}`;

test("parseAgentResults keeps a late PR URL when Linear lists the earlier no-PR comment last", () => {
  // Linear does not guarantee chronological order. A recovery comment with a PR
  // must win even when the first-report no-PR comment is returned last.
  const results = parseAgentResults(issueWith([agentDoneWithPr, agentDoneNoPr]));
  assert.equal(results.get("bc-aaa-111")?.prUrl, latePrUrl);
});

test("parseAgentResults takes a later agent-done PR URL after a first report with no PR", () => {
  const results = parseAgentResults(issueWith([agentDoneNoPr, agentDoneWithPr]));
  assert.equal(results.get("bc-aaa-111")?.prUrl, latePrUrl);
});

test("parseRemediationResults keeps a late hotfix PR URL when Linear lists the earlier no-PR comment last", () => {
  const results = parseRemediationResults(issueWith([remediationDoneWithPr, remediationDoneNoPr]));
  assert.equal(results.get("bc-fix-222")?.prUrl, lateHotfixPrUrl);
});

test("parseRemediationResults takes a later remediation-done PR URL after a first report with no PR", () => {
  const results = parseRemediationResults(issueWith([remediationDoneNoPr, remediationDoneWithPr]));
  assert.equal(results.get("bc-fix-222")?.prUrl, lateHotfixPrUrl);
});

test("bridgeReactionId is deterministic, unique per issue, and UUID-shaped", () => {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const a = bridgeReactionId("issue-1");
  assert.equal(a, bridgeReactionId("issue-1"));
  assert.notEqual(a, bridgeReactionId("issue-2"));
  assert.match(a, uuid);
});
