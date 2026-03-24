# Commit PR media to the branch and link with blob URLs

## Search Metadata
- Topics: PR media, screenshots, videos, blob URLs, GitHub markdown, inline images, inline video, user-attachments
- Applies: adding screenshots or recordings to PRs programmatically, embedding media in GitHub markdown

## Lesson
- Commit media files to the PR branch and reference them via `https://github.com/{owner}/{repo}/blob/{branch}/{file}?raw=true`
- Use markdown image syntax `![alt](url?raw=true)` for screenshots to render inline
- NEVER use blob URLs or `<video>` tags for inline video — GitHub only renders inline video from drag-and-drop uploads (`user-attachments` URLs)
- Fall back to a plain link for video files so reviewers can click through to view

---
Learned: 2026-03-13
