# Repositories must have build/test docs and ARCHITECTURE.md for ironsha

## Search Metadata
- Topics: required files, AGENTS.md, CLAUDE.md, README.md, ARCHITECTURE.md, build commands, test commands, project setup, ironsha compatibility
- Applies: setting up a new project for ironsha review, onboarding a repo to ironsha, missing project files

## Lesson
- Every repo reviewed by ironsha MUST contain:
  1. `AGENTS.md`, `CLAUDE.md`, or `README.md` — must document the project's build and test commands (ironsha runs these before reviewing; failure = immediate rejection)
  2. `ARCHITECTURE.md` — documents module structure, data flow, layer boundaries, dependency direction (ironsha reads this during architecture review)
- If a change introduces new modules or alters the architecture, update `ARCHITECTURE.md` in the same PR
- Supported stacks: iOS (*.swift), Android (*.kt, *.kts), Go webservers (*.go), React webapps (*.tsx, *.ts, *.jsx)

---
Learned: 2026-03-14
