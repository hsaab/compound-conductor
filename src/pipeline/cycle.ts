/**
 * Pipeline cycle descriptors: one object per pass (initial ship vs hotfix loop)
 * that carries every marker, parser, and copy variant the tail stages need.
 */
import { markers } from "../config.js";
import { parsePullRequestUrl } from "../integrations/github.js";
import {
  commentCreatedAt,
  hasComment,
  hasRemediationDone,
  parseAgentResults,
  parseDoneAgentIds,
  parseHotfixVerifyAgents,
  parseRemediationResults,
  parseSpawnedAgents,
  parseVerifyAgents,
} from "../integrations/linear.js";
import type { LinearIssuePayload, SpawnedAgent, StageState } from "../types.js";

/** Build-agent bookkeeping the reconciler already computed, so cycles can reuse it. */
export interface MergeContext {
  spawned: SpawnedAgent[];
  done: Set<string>;
}

export interface PipelineCycle {
  id: "initial" | "hotfix";
  /** Human label used in log lines, Slack copy, and comment headlines. */
  label: "verify" | "hotfix verify";
  deployedMarker: string;
  /** Posted when a production deploy arrives before this cycle's merge is confirmed. */
  bufferedMarker: string;
  passMarker: string;
  failMarker: string;
  mergedMarker: string;
  /** Comment substring identifying this cycle's verify-agent spawns (window start). */
  spawnNeedle: string;
  parseAgents: (issue: LinearIssuePayload) => SpawnedAgent[];
  prUrls: (issue: LinearIssuePayload) => string[];
  /**
   * Whether a failure was reported outside this cycle's verify markers. Only the
   * initial cycle has such a channel: a Datadog alert dispatching remediation
   * (the `remediated` marker). It both blocks the verify window fallback and
   * settles the verify stage as done — the failure moved to the remediate stage.
   * The hotfix cycle has no out-of-band channel (a re-alert is blocked by the
   * `remediated` marker), so its only failure signal is the fail marker itself.
   */
  outOfBandFailure?: (issue: LinearIssuePayload) => boolean;
  /** Initial pass gates review on all build agents done; hotfix loop does not. */
  requiresBuildDoneForReview: boolean;
  /** Whether this cycle's PR(s) are ready to be checked for a merge on GitHub. */
  mergeReady: (issue: LinearIssuePayload, ctx?: MergeContext) => boolean;
  mergeHeadline: string;
  mergeNoun: (count: number) => string;
  deployedHeadline: (project: string, shortSha?: string) => string;
  verifySpawnHeadline: string;
  verifySpawnMarker: (agentId: string) => string;
}

/**
 * GitHub PR attachment URLs created strictly after `afterIso` on a repo this
 * fleet spawned. Attachments are user-writable, so a PR on some other repo
 * must not become the merge target.
 */
export function attachmentPrUrls(issue: LinearIssuePayload, afterIso: string): string[] {
  const allowedRepos = new Set(
    parseSpawnedAgents(issue).map((agent) => agent.repo.toLowerCase()),
  );
  const urls: string[] = [];
  for (const attachment of issue.attachments ?? []) {
    const { url, createdAt } = attachment;
    if (!url || !createdAt) continue;
    if (createdAt <= afterIso) continue;
    const pr = parsePullRequestUrl(url);
    if (!pr) continue;
    if (!allowedRepos.has(`${pr.owner}/${pr.repo}`.toLowerCase())) continue;
    urls.push(url);
  }
  return urls;
}

/**
 * Merge callers treat any non-empty list as "check these PRs and, if they are
 * all merged, complete review". A partial list (one attachment, one of two
 * agent PRs) would therefore ship the fleet while other agents never opened
 * or merged theirs. Return the complete set or nothing. Surplus attachments
 * after the gaps are filled are ignored — they must not empty the set.
 */
function completeMergeSet(spawnedCount: number, urls: string[]): string[] {
  if (spawnedCount <= 0) return urls;
  if (urls.length < spawnedCount) return [];
  return urls.slice(0, spawnedCount);
}

function buildPrUrls(issue: LinearIssuePayload): string[] {
  const spawned = parseSpawnedAgents(issue);
  const results = parseAgentResults(issue);
  const fromAgents = spawned
    .map((agent) => results.get(agent.agentId)?.prUrl)
    .filter((url): url is string => typeof url === "string" && url.length > 0);

  // Attachments fill missing agent PR lines. They are not a second merge set.
  if (spawned.length > 0 && fromAgents.length === spawned.length) return fromAgents;

  const fleetStartedAt = commentCreatedAt(issue, markers.fleetStarted);
  const urls = fleetStartedAt
    ? [...new Set([...fromAgents, ...attachmentPrUrls(issue, fleetStartedAt)])]
    : fromAgents;
  return completeMergeSet(spawned.length, urls);
}

/**
 * PRs this cycle is allowed to treat as the merge set. Empty until the cycle
 * is ready (every build agent done on the initial pass) and the URL list is
 * complete. Shared by reconcile and the deploy webhook so one attached PR
 * cannot complete review ahead of the rest of the fleet.
 */
export function cycleMergePrUrls(
  cycle: PipelineCycle,
  issue: LinearIssuePayload,
  ctx?: MergeContext,
): string[] {
  if (!cycle.mergeReady(issue, ctx)) return [];
  return cycle.prUrls(issue);
}

function allBuildAgentsDone(issue: LinearIssuePayload, ctx?: MergeContext): boolean {
  const spawned = ctx?.spawned ?? parseSpawnedAgents(issue);
  const done = ctx?.done ?? parseDoneAgentIds(issue);
  return spawned.length > 0 && spawned.every((agent) => done.has(agent.agentId));
}

/** Hotfix PR URLs recorded by the remediation agents' completion comments. */
export function hotfixPrUrls(issue: LinearIssuePayload): string[] {
  return [...parseRemediationResults(issue).values()]
    .map((result) => result.prUrl)
    .filter((url): url is string => typeof url === "string" && url.length > 0);
}

/**
 * True once a remediation agent has actually opened a hotfix PR — the trigger
 * for looping the pipeline back to review. A remediation run that ended with
 * no PR has nothing to review or merge, so it must not re-open the tail stages.
 */
export function hotfixPrOpened(issue: LinearIssuePayload): boolean {
  return hasRemediationDone(issue) && hotfixPrUrls(issue).length > 0;
}

/**
 * True once this cycle's verify stage has settled: an explicit pass/fail
 * verdict, or a failure reported through the cycle's out-of-band channel.
 */
export function verdictSettled(issue: LinearIssuePayload, cycle: PipelineCycle): boolean {
  return (
    hasComment(issue, cycle.passMarker) ||
    hasComment(issue, cycle.failMarker) ||
    (cycle.outOfBandFailure?.(issue) ?? false)
  );
}

export const INITIAL_PIPELINE_CYCLE: PipelineCycle = {
  id: "initial",
  label: "verify",
  deployedMarker: markers.deployed,
  bufferedMarker: markers.deployBuffered,
  passMarker: markers.verifyPass,
  failMarker: markers.verifyFail,
  mergedMarker: markers.merged,
  spawnNeedle: markers.verifySpawnNeedle,
  parseAgents: parseVerifyAgents,
  prUrls: buildPrUrls,
  outOfBandFailure: (issue) => hasComment(issue, markers.remediated),
  requiresBuildDoneForReview: true,
  mergeReady: allBuildAgentsDone,
  mergeHeadline: "🔀 Merged",
  mergeNoun: (count) => (count === 1 ? "pull request" : "pull requests"),
  deployedHeadline: (project, shortSha) =>
    `**🚀 ${project} deployed to production**${shortSha ? ` (\`${shortSha}\`)` : ""}`,
  verifySpawnHeadline: "**🔍 Verify agent dispatched** — running the test plan against the deployed site.",
  verifySpawnMarker: markers.verifySpawned,
};

export const HOTFIX_PIPELINE_CYCLE: PipelineCycle = {
  id: "hotfix",
  label: "hotfix verify",
  deployedMarker: markers.hotfixDeployed,
  bufferedMarker: markers.hotfixDeployBuffered,
  passMarker: markers.hotfixVerifyPass,
  failMarker: markers.hotfixVerifyFail,
  mergedMarker: markers.hotfixMerged,
  spawnNeedle: markers.hotfixVerifySpawnNeedle,
  parseAgents: parseHotfixVerifyAgents,
  prUrls: hotfixPrUrls,
  requiresBuildDoneForReview: false,
  mergeReady: (issue) => hasRemediationDone(issue),
  mergeHeadline: "🔀 Hotfix merged",
  mergeNoun: (count) => (count === 1 ? "hotfix pull request" : "hotfix pull requests"),
  deployedHeadline: (_project, shortSha) =>
    `**🛠️ Hotfix deployed to production**${shortSha ? ` (\`${shortSha}\`)` : ""}`,
  verifySpawnHeadline:
    "**🔍 Hotfix verify agent dispatched** — re-running the test plan against the hotfix deploy.",
  verifySpawnMarker: markers.hotfixVerifySpawned,
};

/** Ordered passes: initial ship, then hotfix loop after remediation. */
export const PIPELINE_CYCLES = [INITIAL_PIPELINE_CYCLE, HOTFIX_PIPELINE_CYCLE] as const;

/**
 * Comment body confirming PR(s) merged for one pipeline cycle. Shared by the
 * reconciler and the Vercel deploy webhook, which can each be the first to
 * observe the merge.
 */
export function mergedCommentForCycle(cycle: PipelineCycle, prUrls: string[]): string {
  const count =
    prUrls.length === 1 ? `1 ${cycle.mergeNoun(1)}` : `${prUrls.length} ${cycle.mergeNoun(prUrls.length)}`;
  return `${cycle.mergedMarker}\n**${cycle.mergeHeadline}** — ${count} merged to the default branch.\n${prUrls.join("\n")}`;
}

export interface TailStageContext {
  allBuildDone: boolean;
}

export interface TailStages {
  review: StageState;
  deploy: StageState;
  verify: StageState;
}

/**
 * Derives review/deploy/verify for one pipeline cycle from its markers.
 * The hotfix pass overrides the initial tail when a hotfix PR is open.
 */
export function deriveTailStages(
  issue: LinearIssuePayload,
  cycle: PipelineCycle,
  ctx: TailStageContext,
): TailStages {
  const deployed = hasComment(issue, cycle.deployedMarker);
  const merged = hasComment(issue, cycle.mergedMarker) || deployed;
  const verifyPass = hasComment(issue, cycle.passMarker);
  const verifyFail = hasComment(issue, cycle.failMarker);

  const review: StageState = cycle.requiresBuildDoneForReview
    ? !ctx.allBuildDone
      ? "pending"
      : merged
        ? "done"
        : "running"
    : merged
      ? "done"
      : "running";

  const deploy: StageState = deployed ? "done" : merged ? "running" : "pending";

  const verify: StageState = !deployed
    ? "pending"
    : verifyPass
      ? "done"
      : verifyFail
        ? "failed"
        : cycle.outOfBandFailure?.(issue)
          ? "done"
          : "running";

  return { review, deploy, verify };
}
