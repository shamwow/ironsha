# Embed PR media using blob URLs from the branch

## Search Metadata
- Topics: PR media, screenshots, videos, blob URLs, GitHub markdown, inline images, inline video, user-attachments
- Applies: adding screenshots or recordings to PRs programmatically, embedding media in GitHub markdown

## Instructions

- Commit media files to the PR branch.
- Reference images with `![alt](https://github.com/{owner}/{repo}/blob/{branch}/{file}?raw=true)`.
- For video files, use a plain link — GitHub does not render inline video from blob URLs.

---
Learned: 2026-03-13
