# ironsha-pr — Local PR Review Workflow

## Usage

`/ironsha-pr`

Runs the review → iterate → publish workflow locally on existing changes. The review loop runs entirely against local state (no GitHub round-trips) until the reviewer approves, then publishes everything to GitHub as a PR.

---

## Step 1: CI

Run build and tests:

1. Discover build/test commands from `AGENTS.md`, `CLAUDE.md`, or `README.md`
2. Run them and verify they pass
3. If they fail, fix the issues and re-run until green

## Step 2: Create local PR

Initialize local review state and write the PR description:

```bash
npm run state -- init
npm run state -- label set bot-review-needed
```

Commit all changes to the current branch.

Write a PR description and store it:

The description MUST include:
- **Summary**: What changed and why (1-3 bullet points)
- **Test plan**: Explicit steps that verify the changes work correctly. Describe what was tested and the observed results. This is NOT just "CI passed" — describe the actual verification.
- **Visual proof** (required for UI changes): If ANY changed files are UI-related (.swift, .kt, .tsx, .jsx, .css, .html, or layout files), you MUST include screenshots or screen recordings. Ask the user to provide these if you cannot capture them automatically.

Store the description:
```bash
npm run state -- description set --body "<description>"
```

## Step 3: Review

Read the ironsha review prompts to construct the reviewer instructions:
- `src/prompts/base.md` — core reviewer protocol and JSON output format
- `src/prompts/architecture-pass.md` — architecture focus
- `src/prompts/detailed-pass.md` — line-level code quality
- Detect the platform from changed file extensions (.swift → ios, .kt → android, .go → golang, .tsx/.ts → react) and read the matching guide from `src/guides/`

Read the current thread state:
```bash
npm run state -- threads
```

Spawn a **review subagent** with the combined prompt. The subagent prompt should include:

1. The content of `base.md`, BUT replace all GitHub MCP references:
   - Replace "You have access to the GitHub MCP server — use it to list PR review comments, read thread conversations, and understand the current review state" with "All review thread state is provided below. Do NOT use GitHub MCP tools."
   - Replace "Use the GitHub MCP tools to list review comments on this PR" with "Review the thread state provided below"
2. The content of `architecture-pass.md` (for the architecture focus)
3. The content of `detailed-pass.md` (for the detailed focus)
4. The platform guide content (if detected)
5. The thread state output from the CLI command above
6. The instruction: "Review the code. Read the diff with `git diff origin/{baseBranch}...HEAD`. Output a single JSON block per the format above."

**Important**: The subagent should perform BOTH the architecture pass and the detailed pass in a single review. Combine both sets of concerns.

After the subagent returns its JSON output, parse it and post to local state:

```bash
npm run state -- review post --json '<the JSON output>'
```

Check the resulting label:
```bash
npm run state -- label
```

If `human-review-needed` → go to Step 6.
If `bot-changes-needed` → go to Step 4.

## Step 4: Iterate

Read the current review threads:
```bash
npm run state -- threads
```

Read the ironsha code-fix prompt from `src/prompts/code-fix.md`.

Spawn a **fix subagent** with instructions that include:

1. The content of `code-fix.md`, BUT replace GitHub MCP references:
   - Replace "You have access to the GitHub MCP server — use it to list PR review comments, read thread conversations, and understand what changes are requested" with "All review thread state is provided below. Do NOT use GitHub MCP tools."
   - Replace "Use the GitHub MCP tools to list all review comments and threads on this PR" with "Review the thread state provided below"
2. The thread state output from the CLI
3. The instruction: "Address all UNRESOLVED threads. Make code changes, run build/tests, then output the JSON result."

After the fix subagent completes:

1. For each thread it addressed, first post the fix explanation as a reply, then resolve it:
   ```bash
   npm run state -- reply <comment-id> --body "<explanation from threads_addressed>"
   npm run state -- resolve <comment-id>
   ```

2. Re-run CI (Step 1 — build and tests)

3. Go back to Step 3 (review again)

## Step 5: Cycle limit

Repeat Steps 3-4 for a maximum of 5 cycles. If the reviewer has not approved after 5 cycles:

```bash
npm run state -- label set bot-human-intervention
```

Inform the user that the review loop did not converge and manual intervention is needed.

## Step 6: Publish

Once the label is `human-review-needed`, publish everything to GitHub:

```bash
npm run state -- publish
```

This will:
1. Push the branch to GitHub
2. Create (or update) the PR with the stored description
3. Post all review comments and thread history from local state with footer tags for thread tracking
4. Sync resolved reactions (rocket + thumbs-up) to GitHub PR comments
5. Set the `human-review-needed` label

Print the PR URL when done.

---

## Notes

- The `npm run state` CLI manages all local PR state (JSON files in `.ironsha/`)
- All review history is preserved locally and published to GitHub at the end
- The review subagent and fix subagent should be spawned via the Agent tool
- If at any point the user wants to stop, respect that — do not force the workflow to continue
