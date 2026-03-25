import { randomBytes } from "node:crypto";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it, after } from "node:test";

// Set config env vars before any ironsha imports
process.env.TRANSCRIPT_DIR = "/tmp/ironsha-integration-test/transcripts";

const useMockLlm =
  process.env.npm_lifecycle_event === "test:integration:mock_llm";
const isExplicitIntegration =
  process.env.npm_lifecycle_event === "test:integration";
const skipRealLlm = !isExplicitIntegration || useMockLlm;

// ---------------------------------------------------------------------------
// Local backend tests — mock LLM agents
// ---------------------------------------------------------------------------
describe("Local backend review", { timeout: 300_000 }, async () => {
  const { createLocalTestRepo, cleanupLocalTestRepo } =
    await import("./local-helpers.js");
  const { runReviewPipelineCore } = await import("../review/pipeline.js");
  const { LocalStateBackend } = await import("../local/state-backend.js");
  const { mockAgentRunner, mockAgentRunnerEmpty } = await import("./mock-agent.js");

  const localFixtures: import("./local-helpers.js").LocalTestFixture[] = [];

  after(() => {
    for (const f of localFixtures) {
      cleanupLocalTestRepo(f);
    }
  });

  it("review pipeline stores comments in local state", async () => {
    const runId = `ironsha-local-${randomBytes(6).toString("hex")}`;
    const fixture = createLocalTestRepo(runId);
    localFixtures.push(fixture);

    const stateDir = join(fixture.checkoutPath, ".ironsha");
    const backend = new LocalStateBackend(fixture.checkoutPath, fixture.pr, stateDir);

    await runReviewPipelineCore(fixture.pr, backend, mockAgentRunner, {
      checkoutPath: fixture.checkoutPath,
      skipMcpGithub: true,
    });

    const state = backend.getState();

    // Mock agent returns architecture comments → review should have posted them
    assert.ok(state.reviews.length > 0, "Should have at least one review");

    // The mock agent returns comments, so label should be bot-changes-needed
    assert.equal(
      state.label,
      "bot-changes-needed",
      "Label should be bot-changes-needed when review finds issues",
    );

    // Check inline comments exist
    const totalInlineComments = state.reviews.reduce(
      (sum, r) => sum + r.comments.length,
      0,
    );
    assert.ok(totalInlineComments > 0, "Should have inline review comments");
  });

  it("blocks LGTM when unresolved threads exist in local state", async () => {
    const runId = `ironsha-local-${randomBytes(6).toString("hex")}`;
    const fixture = createLocalTestRepo(runId);
    localFixtures.push(fixture);

    const stateDir = join(fixture.checkoutPath, ".ironsha");
    const backend = new LocalStateBackend(fixture.checkoutPath, fixture.pr, stateDir);

    // First review: mockAgentRunner posts comments (creates unresolved threads)
    await runReviewPipelineCore(fixture.pr, backend, mockAgentRunner, {
      checkoutPath: fixture.checkoutPath,
      skipMcpGithub: true,
    });

    assert.equal(backend.getLabel(), "bot-changes-needed", "First review should find issues");
    const stateAfterFirst = backend.getState();
    const threadCount = stateAfterFirst.reviews.reduce(
      (sum, r) => sum + r.comments.length,
      0,
    );
    assert.ok(threadCount > 0, "Should have created threads in first review");

    // Second review: mockAgentRunnerEmpty returns no comments
    // The safety check should detect unresolved threads and block LGTM
    await runReviewPipelineCore(fixture.pr, backend, mockAgentRunnerEmpty, {
      checkoutPath: fixture.checkoutPath,
      skipMcpGithub: true,
    });

    assert.equal(
      backend.getLabel(),
      "bot-changes-needed",
      "Label should stay bot-changes-needed when unresolved threads exist",
    );
  });

  it("local state stores reactions correctly", async () => {
    const runId = `ironsha-local-${randomBytes(6).toString("hex")}`;
    const fixture = createLocalTestRepo(runId);
    localFixtures.push(fixture);

    const stateDir = join(fixture.checkoutPath, ".ironsha");
    const backend = new LocalStateBackend(fixture.checkoutPath, fixture.pr, stateDir);

    // Run a review to create comments
    await runReviewPipelineCore(fixture.pr, backend, mockAgentRunner, {
      checkoutPath: fixture.checkoutPath,
      skipMcpGithub: true,
    });

    const state = backend.getState();
    assert.ok(state.reviews.length > 0, "Should have reviews");

    // Manually add resolved reactions to a comment
    const firstComment = state.reviews[0].comments[0];
    assert.ok(firstComment, "Should have at least one inline comment");

    await backend.addResolvedReactions(fixture.pr, firstComment.id);

    // Verify reactions were stored
    const updatedState = backend.getState();
    const updatedComment = updatedState.reviews[0].comments[0];
    const rocketReaction = updatedComment.reactions.find((r) => r.content === "rocket");
    const thumbsUpReaction = updatedComment.reactions.find((r) => r.content === "+1");
    assert.ok(rocketReaction, "Should have rocket reaction");
    assert.ok(thumbsUpReaction, "Should have thumbs-up reaction");

    // Verify fetchResolvedThreadIds picks it up
    const resolved = await backend.fetchResolvedThreadIds(fixture.pr);
    assert.ok(resolved.has(firstComment.id), "Comment should be resolved");
  });
});

// ---------------------------------------------------------------------------
// Local backend test — real LLM agent (skipped in mock_llm mode)
// ---------------------------------------------------------------------------
describe("Local backend real-LLM review", { timeout: 900_000, skip: skipRealLlm }, async () => {
  const { createLocalTestRepo, cleanupLocalTestRepo } =
    await import("./local-helpers.js");
  const { runReviewPipelineCore } = await import("../review/pipeline.js");
  const { LocalStateBackend } = await import("../local/state-backend.js");
  const { runAgent } = await import("../review/agent-runner.js");

  const localFixtures: import("./local-helpers.js").LocalTestFixture[] = [];

  after(() => {
    for (const f of localFixtures) {
      cleanupLocalTestRepo(f);
    }
  });

  it("local review with real LLM posts comments", async () => {
    const runId = `ironsha-llm-${randomBytes(6).toString("hex")}`;
    const fixture = createLocalTestRepo(runId);
    localFixtures.push(fixture);

    const stateDir = join(fixture.checkoutPath, ".ironsha");
    const backend = new LocalStateBackend(fixture.checkoutPath, fixture.pr, stateDir);

    await runReviewPipelineCore(fixture.pr, backend, runAgent, {
      checkoutPath: fixture.checkoutPath,
      skipMcpGithub: true,
    });

    const state = backend.getState();

    // Real LLM should produce at least one review
    assert.ok(state.reviews.length > 0, "Should have at least one review from real LLM");

    // Label should have been set to either bot-changes-needed or human-review-needed
    assert.ok(
      state.label === "bot-changes-needed" || state.label === "human-review-needed",
      `Label should be bot-changes-needed or human-review-needed, got: ${state.label}`,
    );
  });
});
