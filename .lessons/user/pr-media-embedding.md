# Embed PR media using the `pr-media` branch

## Search Metadata
- Topics: PR media, screenshots, videos, blob URLs, GitHub markdown, inline images, inline video, user-attachments
- Applies: adding screenshots or recordings to PRs programmatically, embedding media in GitHub markdown

## Instructions

- Store all screenshots and videos under `.ironsha/pr-media/` in the workspace.
- Sync that media folder to the `pr-media` branch to keep the feature branch clean.
- Publish synced assets on the `pr-media` branch under `pr-media/{worktree-name}/{file}`.
- Reference images with `![alt](https://github.com/{owner}/{repo}/blob/pr-media/pr-media/{worktree-name}/{file}?raw=true)`.
- For video files, use a plain link to `https://github.com/{owner}/{repo}/blob/pr-media/pr-media/{worktree-name}/{file}` — GitHub does not render inline video from blob URLs.

---
Learned: 2026-03-13
