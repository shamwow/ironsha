# Capture and review visual proof before submitting UI PRs

## Search Metadata
- Topics: screenshots, screen recordings, simulator, visual proof, UI changes, PR review, visual bugs
- Applies: creating PRs that touch views or UI code, capturing simulator output, reviewing visual changes

## Lesson
- ALWAYS build and run the app in the iOS simulator before creating a PR that touches UI code
- Capture screenshots for static visual changes and screen recordings for interactive changes (animations, sheets, navigation flows)
- Inspect captured media for visual bugs before submitting: incorrect fill states, clipped text, low-contrast elements, misaligned spacing, data/visual mismatches
- Commit captured media to the PR branch (e.g. `.github/pr-media/`) and link them in the PR description using `![alt](https://github.com/{owner}/{repo}/blob/{branch}/{file}?raw=true)` — do NOT expect the user to manually upload images
- For video files, commit to the branch and include a plain link (GitHub does not render inline video from blob URLs)
- NEVER submit a UI PR without visual evidence of the change

---
Learned: 2026-03-13
