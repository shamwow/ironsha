Look at the git diff for this branch against the base branch.
Output a single JSON object with this shape:
{ "title": "short PR title", "body": "full PR description markdown" }
The `title` must be a concise human-readable PR title, not the branch or worktree name.
When you describe verification steps, use concrete, falsifiable assertions tied to state the reviewer can actually observe. Do not rely on vague checks like "looks normal" or on markers that may also appear in the baseline flow.
The `body` markdown must include:
- **Summary**: What changed and why (1-3 bullet points)
- **Test plan**: Explicit steps that verify the changes work correctly
{{VISUAL_EVIDENCE_REQUIREMENTS}}

Output ONLY the JSON object, no other commentary.
