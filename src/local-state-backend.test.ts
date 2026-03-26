import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStateBackend } from "./local/state-backend.js";
import type { PRInfo, ReviewComment } from "./review/types.js";

function createBackend() {
  const checkoutPath = mkdtempSync(join(tmpdir(), "ironsha-local-state-"));
  const pr: PRInfo = {
    owner: "local",
    repo: "test",
    number: 0,
    branch: "feature/test",
    baseBranch: "main",
    title: "Test PR",
  };
  const backend = new LocalStateBackend(checkoutPath, pr, join(checkoutPath, ".ironsha"));
  return { backend, pr, checkoutPath };
}

test("LocalStateBackend persists general comments as resolvable threads", async () => {
  const { backend, pr, checkoutPath } = createBackend();
  try {
    const comments: ReviewComment[] = [
      { path: null, line: null, body: "General QA finding." },
      { path: "src/task.txt", line: 1, body: "Inline finding." },
    ];

    await backend.postReview(pr, comments, "REQUEST_CHANGES", "qa");

    const state = backend.getState();
    assert.equal(state.reviews.length, 1);
    assert.equal(state.reviews[0].comments.length, 2);
    assert.equal(state.reviews[0].comments[0].path, null);
    assert.equal(state.reviews[0].comments[0].line, null);

    assert.equal(await backend.fetchUnresolvedThreadCount(pr, "qa"), 2);

    const generalThreadId = state.reviews[0].comments[0].id;
    await backend.replyToThread(pr, generalThreadId, "Addressed");
    await backend.addResolvedReactions(pr, generalThreadId);

    assert.equal(await backend.fetchUnresolvedThreadCount(pr, "qa"), 1);

    const threadState = await backend.formatThreadStateForAgent(pr, "qa");
    assert.match(threadState, /general comment/);
    assert.match(threadState, /RESOLVED/);
    assert.match(threadState, /Reply: Addressed/);
  } finally {
    rmSync(checkoutPath, { recursive: true, force: true });
  }
});

test("LocalStateBackend filters unresolved threads by review phase", async () => {
  const { backend, pr, checkoutPath } = createBackend();
  try {
    await backend.postReview(
      pr,
      [{ path: "src/code.txt", line: 1, body: "Code issue." }],
      "REQUEST_CHANGES",
      "code",
    );
    await backend.postReview(
      pr,
      [{ path: null, line: null, body: "QA issue." }],
      "REQUEST_CHANGES",
      "qa",
    );

    const state = backend.getState();
    assert.equal(state.reviews[0].phase, "code");
    assert.equal(state.reviews[1].phase, "qa");
    assert.equal(await backend.fetchUnresolvedThreadCount(pr, "code"), 1);
    assert.equal(await backend.fetchUnresolvedThreadCount(pr, "qa"), 1);
    assert.equal(await backend.fetchUnresolvedThreadCount(pr), 2);

    await backend.addResolvedReactions(pr, state.reviews[0].comments[0].id);

    assert.equal(await backend.fetchUnresolvedThreadCount(pr, "code"), 0);
    assert.equal(await backend.fetchUnresolvedThreadCount(pr, "qa"), 1);

    const codeThreadState = await backend.formatThreadStateForAgent(pr, "code");
    const qaThreadState = await backend.formatThreadStateForAgent(pr, "qa");
    assert.match(codeThreadState, /Code issue/);
    assert.doesNotMatch(codeThreadState, /QA issue/);
    assert.match(qaThreadState, /QA issue/);
    assert.doesNotMatch(qaThreadState, /Code issue/);
  } finally {
    rmSync(checkoutPath, { recursive: true, force: true });
  }
});
