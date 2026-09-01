/**
 * Per-cycle buffer for a production deploy that arrived before merge confirmed.
 * Linear comments are the store. This module must not import fleet or
 * observability (those import it; a reverse import is circular).
 */
import { productionDeployHostname } from "../config.js";
import { hasComment, parseTestPlan, postComment } from "../integrations/linear.js";
import { postSlack, statusBlocks } from "../integrations/slack.js";
import type { LinearIssuePayload } from "../types.js";
import { spawnVerifyAgent } from "./agents.js";
import type { PipelineCycle } from "./cycle.js";

/** Slim deploy payload stored on the buffer comment. Compatible with DeploymentInfo. */
export interface BufferedDeployment {
  project: string;
  url?: string;
  commitSha?: string;
}

function commentWithMarker(issue: LinearIssuePayload, marker: string): string | undefined {
  return issue.comments?.find((comment) => comment.body?.includes(marker))?.body ?? undefined;
}

function fieldValue(body: string, label: string): string | undefined {
  const match = body.match(new RegExp(`^${label}:\\s*(.+)$`, "m"));
  const raw = match?.[1]?.trim();
  if (!raw) return undefined;
  return raw.replace(/^`|`$/g, "");
}

/** Webhook fields become Linear comment text that `hasComment` substring-matches. */
function oneLine(value: string | undefined): string | undefined {
  if (value == null) return undefined;
  const line = String(value).replace(/[\r\n\u2028\u2029]/g, "").trim();
  if (!line || line.includes("conductor:")) return undefined;
  return line;
}

export function buildBufferedDeployComment(
  cycle: PipelineCycle,
  dep: BufferedDeployment,
): string | null {
  const project = oneLine(dep.project);
  if (!project) return null;
  const headline =
    cycle.id === "hotfix"
      ? "**Hotfix deploy buffered** — production deploy arrived before merge confirmed."
      : "**Deploy buffered** — production deploy arrived before merge confirmed.";
  const lines = [cycle.bufferedMarker, headline, "", `Project: \`${project}\``];
  const url = oneLine(dep.url);
  const sha = oneLine(dep.commitSha);
  if (url) lines.push(`URL: ${url}`);
  if (sha) lines.push(`SHA: ${sha}`);
  return lines.join("\n");
}

export function parseBufferedDeploy(
  issue: LinearIssuePayload,
  cycle: PipelineCycle,
): BufferedDeployment | null {
  const body = commentWithMarker(issue, cycle.bufferedMarker);
  if (!body) return null;
  const project = fieldValue(body, "Project");
  if (!project) return null;
  return {
    project,
    url: fieldValue(body, "URL"),
    commitSha: fieldValue(body, "SHA"),
  };
}

export function canPromoteBufferedDeploy(
  issue: LinearIssuePayload,
  cycle: PipelineCycle,
  opts: { mergeJustConfirmed: boolean },
): boolean {
  if (!hasComment(issue, cycle.bufferedMarker)) return false;
  if (hasComment(issue, cycle.deployedMarker)) return false;
  return hasComment(issue, cycle.mergedMarker) || opts.mergeJustConfirmed;
}

export async function writeBufferedDeploy(
  issue: LinearIssuePayload,
  cycle: PipelineCycle,
  dep: BufferedDeployment,
): Promise<void> {
  if (hasComment(issue, cycle.bufferedMarker) || hasComment(issue, cycle.deployedMarker)) return;
  const body = buildBufferedDeployComment(cycle, dep);
  if (!body) return;
  await postComment(issue.id, body);
}

export async function stampDeployedMarker(
  issue: LinearIssuePayload,
  dep: BufferedDeployment,
  cycle: PipelineCycle,
): Promise<void> {
  if (hasComment(issue, cycle.deployedMarker)) return;
  const project = oneLine(dep.project) ?? "";
  const shortSha = oneLine(dep.commitSha)?.slice(0, 7);
  const url = oneLine(dep.url) ?? "";
  await postComment(
    issue.id,
    `${cycle.deployedMarker}\n${cycle.deployedHeadline(project, shortSha)}\n${url}`,
  );
}

export async function spawnVerifyIfNeeded(
  issue: LinearIssuePayload,
  dep: BufferedDeployment,
  cycle: PipelineCycle,
): Promise<void> {
  if (cycle.parseAgents(issue).length > 0) return;
  const prodHost = productionDeployHostname();
  const prodUrl = oneLine(dep.url) ?? (prodHost ? `https://${prodHost}` : "");
  if (prodUrl) {
    await spawnVerifyAgent({ issue, prodUrl, testPlan: parseTestPlan(issue), cycle: cycle.id });
  }
}

export async function promoteBufferedDeploy(
  issue: LinearIssuePayload,
  cycle: PipelineCycle,
  opts: { mergeJustConfirmed: boolean },
): Promise<void> {
  if (!canPromoteBufferedDeploy(issue, cycle, opts)) return;
  const dep = parseBufferedDeploy(issue, cycle);
  if (!dep) return;

  await stampDeployedMarker(issue, dep, cycle);

  const shortSha = dep.commitSha?.slice(0, 7);
  await postSlack(
    statusBlocks(cycle.deployedHeadline(dep.project, shortSha), [
      dep.url ? `Deploy: ${dep.url}` : "",
      shortSha ? `Commit: ${shortSha}` : "",
    ].filter(Boolean)),
  );

  await spawnVerifyIfNeeded(issue, dep, cycle);
}
