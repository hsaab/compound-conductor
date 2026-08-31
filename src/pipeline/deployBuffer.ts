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
  const headline =
    cycle.id === "hotfix"
      ? "**Hotfix deploy buffered** — production deploy arrived before merge confirmed."
      : "**Deploy buffered** — production deploy arrived before merge confirmed.";
  const lines = [cycle.bufferedMarker, headline, "", `Project: \`${dep.project}\``];
  if (dep.url) lines.push(`URL: ${dep.url}`);
  if (dep.commitSha) lines.push(`SHA: ${dep.commitSha}`);
  await postComment(issue.id, lines.join("\n"));
}

export async function stampDeployedMarker(
  issue: LinearIssuePayload,
  dep: BufferedDeployment,
  cycle: PipelineCycle,
): Promise<void> {
  if (hasComment(issue, cycle.deployedMarker)) return;
  const shortSha = dep.commitSha?.slice(0, 7);
  await postComment(
    issue.id,
    `${cycle.deployedMarker}\n${cycle.deployedHeadline(dep.project, shortSha)}\n${dep.url ?? ""}`,
  );
}

export async function spawnVerifyIfNeeded(
  issue: LinearIssuePayload,
  dep: BufferedDeployment,
  cycle: PipelineCycle,
): Promise<void> {
  if (cycle.parseAgents(issue).length > 0) return;
  const prodHost = productionDeployHostname();
  const prodUrl = dep.url ?? (prodHost ? `https://${prodHost}` : "");
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
