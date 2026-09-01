/**
 * Cloud model selection for fleet / verify / remediation / planner spawn.
 *
 * config.ts captures BRIDGE_MODEL_ID / PLANNER_MODEL_ID at module load, so a
 * developer shell that sourced .env (per the AGENTS.md runbook) would poison
 * the default-model tests. node --test runs each file in its own child
 * process, so we can safely delete those env vars here and dynamically import
 * config afterwards, guaranteeing the defaults are what get captured.
 * Override journeys call selectCloudModel directly.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

delete process.env.BRIDGE_MODEL_ID;
delete process.env.PLANNER_MODEL_ID;

const config = await import("../config.js");

const extraHigh = {
  id: "grok-4.6",
  params: [
    { id: "effort", value: "xhigh" },
    { id: "fast", value: "true" },
  ],
};

test("with no model env set, default fleet and planner model ids are grok-4.6", () => {
  assert.equal(config.modelId, "grok-4.6");
  assert.equal(config.plannerModelId, "grok-4.6");
});

test("with no model env set, fleet verify remediation and planner selections are grok-4.6 extra high", () => {
  assert.deepEqual(config.fleetModel, extraHigh);
  assert.deepEqual(config.plannerModel, extraHigh);
});

test("overriding the model id to composer-2.5 uses that id without extra-high effort", () => {
  assert.deepEqual(config.selectCloudModel("composer-2.5"), { id: "composer-2.5" });
});

test("explicit grok-4.6 still gets extra high", () => {
  assert.deepEqual(config.selectCloudModel("grok-4.6"), extraHigh);
});
