# Capture visual proof before submitting UI PRs

## Search Metadata
- Topics: screenshots, screen recordings, simulator, visual proof, UI changes, PR review, visual bugs
- Applies: creating PRs that touch views or UI code, capturing simulator output, reviewing visual changes

## Instructions

- Build and run the app in the simulator before creating a PR that touches UI code.
- Capture screenshots for static changes and screen recordings for interactive changes.
- Inspect captured media for visual bugs: incorrect fill states, clipped text, low-contrast elements, misaligned spacing, data/visual mismatches.
- Store all screenshots and screen recordings under `.ironsha/pr-media/`, sync them to the `pr-media` branch under `pr-media/{worktree-name}/`, and link the resulting blob URLs in the PR description.
- Do not submit a UI PR without visual evidence of the change.

---
Learned: 2026-03-13
