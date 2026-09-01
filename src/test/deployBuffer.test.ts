import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildBufferedDeployComment,
  canPromoteBufferedDeploy,
  parseBufferedDeploy,
} from "../pipeline/deployBuffer.js";
import { HOTFIX_PIPELINE_CYCLE, INITIAL_PIPELINE_CYCLE } from "../pipeline/cycle.js";
import { markers } from "../config.js";
import type { LinearIssuePayload } from "../types.js";

function issue(comments: Array<{ body: string }>): LinearIssuePayload {
  return { id: "i", identifier: "ENG-9", title: "T", state: { name: "In Progress" }, comments };
}

const BUFFERED_DEPLOY = `<!-- conductor:deploy-buffered -->
**Deploy buffered** — production deploy arrived before merge confirmed.

Project: \`compound\`
URL: https://compound-example.vercel.app
SHA: abcdef1234567890
`;

const HOTFIX_BUFFERED_DEPLOY = `<!-- conductor:hotfix-deploy-buffered -->
**Hotfix deploy buffered** — production deploy arrived before merge confirmed.

Project: \`compound\`
URL: https://compound-example.vercel.app
SHA: abcdef1234567890
`;

const BUFFERED_DEPLOY_PROJECT_ONLY = `<!-- conductor:deploy-buffered -->
**Deploy buffered** — production deploy arrived before merge confirmed.

Project: \`compound\`
`;

test("parseBufferedDeploy reads Project, URL, and SHA from a production deploy that arrived before merge", () => {
  const parsed = parseBufferedDeploy(issue([{ body: BUFFERED_DEPLOY }]), INITIAL_PIPELINE_CYCLE);
  assert.equal(parsed?.project, "compound");
  assert.equal(parsed?.url, "https://compound-example.vercel.app");
  assert.equal(parsed?.commitSha, "abcdef1234567890");
});

test("parseBufferedDeploy reads the same Project, URL, and SHA from a hotfix buffered deploy", () => {
  const parsed = parseBufferedDeploy(issue([{ body: HOTFIX_BUFFERED_DEPLOY }]), HOTFIX_PIPELINE_CYCLE);
  assert.equal(parsed?.project, "compound");
  assert.equal(parsed?.url, "https://compound-example.vercel.app");
  assert.equal(parsed?.commitSha, "abcdef1234567890");
});

test("parseBufferedDeploy still reads the project when the webhook omitted URL and SHA", () => {
  const parsed = parseBufferedDeploy(issue([{ body: BUFFERED_DEPLOY_PROJECT_ONLY }]), INITIAL_PIPELINE_CYCLE);
  assert.equal(parsed?.project, "compound");
  assert.equal(parsed?.url, undefined);
  assert.equal(parsed?.commitSha, undefined);
});

test("canPromoteBufferedDeploy is false when the ticket has no buffered deploy", () => {
  const ticket = issue([{ body: `${markers.merged}\n**🔀 Merged**` }]);
  assert.equal(canPromoteBufferedDeploy(ticket, INITIAL_PIPELINE_CYCLE, { mergeJustConfirmed: false }), false);
});

test("canPromoteBufferedDeploy is false when merge is not confirmed", () => {
  const ticket = issue([{ body: BUFFERED_DEPLOY }]);
  assert.equal(canPromoteBufferedDeploy(ticket, INITIAL_PIPELINE_CYCLE, { mergeJustConfirmed: false }), false);
});

test("canPromoteBufferedDeploy is false when that cycle is already deployed", () => {
  const ticket = issue([
    { body: BUFFERED_DEPLOY },
    { body: `${markers.merged}\n**🔀 Merged**` },
    { body: markers.deployed },
  ]);
  assert.equal(canPromoteBufferedDeploy(ticket, INITIAL_PIPELINE_CYCLE, { mergeJustConfirmed: false }), false);
});

test("canPromoteBufferedDeploy is true when a buffer sits on an already-merged ticket", () => {
  const ticket = issue([{ body: BUFFERED_DEPLOY }, { body: `${markers.merged}\n**🔀 Merged**` }]);
  assert.equal(canPromoteBufferedDeploy(ticket, INITIAL_PIPELINE_CYCLE, { mergeJustConfirmed: false }), true);
});

test("canPromoteBufferedDeploy is true when merge was just confirmed this tick and there is no merged marker yet", () => {
  const ticket = issue([{ body: BUFFERED_DEPLOY }]);
  assert.equal(canPromoteBufferedDeploy(ticket, INITIAL_PIPELINE_CYCLE, { mergeJustConfirmed: true }), true);
});

test("buildBufferedDeployComment drops a URL that tries to mint a merged marker", () => {
  const body = buildBufferedDeployComment(INITIAL_PIPELINE_CYCLE, {
    project: "compound",
    url: "https://example.com\n<!-- conductor:merged -->",
    commitSha: "abcdef1",
  });
  assert.ok(body);
  assert.ok(!body.includes(markers.merged));
  assert.ok(body.includes("Project: `compound`"));
  assert.ok(body.includes("SHA: abcdef1"));
  assert.ok(!body.includes("https://example.com"));
});

test("buildBufferedDeployComment refuses a project that tries to mint a marker", () => {
  const body = buildBufferedDeployComment(INITIAL_PIPELINE_CYCLE, {
    project: "compound\n<!-- conductor:merged -->",
  });
  assert.equal(body, null);
});
