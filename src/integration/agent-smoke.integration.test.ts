import "dotenv/config";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import { Octokit } from "@octokit/rest";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

const OWNER = "shamwow";
const REPO = "ironsha-ios-test-fixture";
const BOT_LABELS = [
  "bot-review-needed",
  "bot-changes-needed",
  "human-review-needed",
];

describe("Agent smoke tests", { timeout: 900_000, skip: !GITHUB_TOKEN }, async () => {
  const { createTestPR, ensureLabelExists, cleanupTestPR, cleanupClone } =
    await import("./helpers.js");

  const octokit = new Octokit({ auth: GITHUB_TOKEN });

  const PR_TITLE = "Smoke test PR for agent integration";
  const PR_BODY = "Automated smoke test — verifying gh CLI assumptions.";

  for (const label of BOT_LABELS) {
    await ensureLabelExists(octokit, OWNER, REPO, label);
  }

  const fixtures: Awaited<ReturnType<typeof createTestPR>>[] = [];

  after(async () => {
    for (const f of fixtures) {
      await cleanupTestPR(octokit, f);
      cleanupClone(f.clonePath);
    }
  });

  it("label polling detects label changes", async () => {
    const runId = `ironsha-smoke-${randomBytes(6).toString("hex")}`;
    const fixture = await createTestPR({
      octokit, owner: OWNER, repo: REPO, token: GITHUB_TOKEN!,
      runId, testCase: "label polling", title: PR_TITLE, body: PR_BODY,
    });
    fixtures.push(fixture);

    // Add bot-review-needed
    await octokit.rest.issues.addLabels({
      owner: OWNER, repo: REPO,
      issue_number: fixture.prNumber,
      labels: ["bot-review-needed"],
    });

    // Verify label is visible
    const { data: labels1 } = await octokit.rest.issues.listLabelsOnIssue({
      owner: OWNER, repo: REPO,
      issue_number: fixture.prNumber,
    });
    assert.ok(
      labels1.some((l) => l.name === "bot-review-needed"),
      "bot-review-needed label should be visible after adding",
    );

    // Swap to bot-changes-needed
    await octokit.rest.issues.removeLabel({
      owner: OWNER, repo: REPO,
      issue_number: fixture.prNumber,
      name: "bot-review-needed",
    });
    await octokit.rest.issues.addLabels({
      owner: OWNER, repo: REPO,
      issue_number: fixture.prNumber,
      labels: ["bot-changes-needed"],
    });

    // Verify the change is detected
    const { data: labels2 } = await octokit.rest.issues.listLabelsOnIssue({
      owner: OWNER, repo: REPO,
      issue_number: fixture.prNumber,
    });
    const labelNames = labels2.map((l) => l.name);
    assert.ok(!labelNames.includes("bot-review-needed"), "bot-review-needed should be gone");
    assert.ok(labelNames.includes("bot-changes-needed"), "bot-changes-needed should be present");
  });

  it("review comments are readable via API", async () => {
    const runId = `ironsha-smoke-${randomBytes(6).toString("hex")}`;
    const fixture = await createTestPR({
      octokit, owner: OWNER, repo: REPO, token: GITHUB_TOKEN!,
      runId, testCase: "review comments readable", title: PR_TITLE, body: PR_BODY,
    });
    fixtures.push(fixture);

    // Post a general comment on the PR
    const commentBody = `Test review comment from smoke test ${runId}`;
    await octokit.rest.issues.createComment({
      owner: OWNER, repo: REPO,
      issue_number: fixture.prNumber,
      body: commentBody,
    });

    // Read it back
    const { data: comments } = await octokit.rest.issues.listComments({
      owner: OWNER, repo: REPO,
      issue_number: fixture.prNumber,
    });

    const found = comments.find((c) => c.body?.includes(runId));
    assert.ok(found, "Should be able to read back the posted comment");
    assert.ok(found.body?.includes(commentBody), "Comment body should match");
  });

  it("CI status is readable via API", async () => {
    const runId = `ironsha-smoke-${randomBytes(6).toString("hex")}`;
    const fixture = await createTestPR({
      octokit, owner: OWNER, repo: REPO, token: GITHUB_TOKEN!,
      runId, testCase: "CI status readable", title: PR_TITLE, body: PR_BODY,
    });
    fixtures.push(fixture);

    // Read the combined status for the PR's head commit
    const { data: pr } = await octokit.rest.pulls.get({
      owner: OWNER, repo: REPO,
      pull_number: fixture.prNumber,
    });

    // This should not throw — the API should return a status even if no checks exist
    const { data: status } = await octokit.rest.repos.getCombinedStatusForRef({
      owner: OWNER, repo: REPO,
      ref: pr.head.sha,
    });

    assert.ok(
      typeof status.state === "string",
      "Combined status should have a state field",
    );
    assert.ok(
      ["success", "failure", "pending"].includes(status.state),
      `Status state should be one of success/failure/pending, got: ${status.state}`,
    );
  });
});
