# Learn — Extract and save lessons from this conversation

## Usage

- `/learn` — Extract lessons from the conversation (interactive)
- `/learn <lesson>` — Manually add a specific lesson

## Manual lesson mode

If the user provides an argument (e.g. `/learn Always validate webhook signatures before processing payloads`), skip Steps 2–4 entirely and go straight to saving:

1. Run **Step 1: Setup** as normal.
2. Treat the argument as the lesson **summary**. If it exceeds 100 characters, condense it into a summary and use the original text as context.
3. Generate a kebab-case **slug** from the summary (e.g. `validate-webhook-signatures`).
4. Generate 2–5 sentences of **context** that explain the lesson — why it matters and how to apply it. Use conversation history for context if relevant; otherwise write a concise, general explanation.
5. **Check for duplicates** — skip if the slug matches an existing file in any lesson directory (`.lessons/`, `.lessons/user/`, or `.lessons/types/<type>/`), or if the summary is similar to a dismissed entry. Inform the user and stop.
6. Default scope to **project**. If the lesson is clearly a personal preference (style, editor, workflow), default to **user**. If the lesson applies to any project of the detected type (e.g. an iOS pattern, a Go idiom, a React best practice), default to **the detected project type**.
7. Show the lesson that will be saved (summary, context, scope) and ask the user to confirm or adjust scope before saving.
8. Save the lesson file, run **Step 6: QMD indexing**, and print confirmation.

---

## Interactive mode (no arguments)

When `/learn` is run without arguments, follow the full extraction flow below.

## Step 1: Setup

### Install qmd if missing

Check: `which qmd`

If qmd is NOT found, install it:
```bash
npm install -g @tobilu/qmd
```
If npm is not available, try `bun install -g @tobilu/qmd`. If neither works, warn the user that qmd could not be installed and continue without it — lessons will still be saved as markdown files but won't be semantically indexed.

### Detect project type

Inspect the working directory to determine the project type. Use these heuristics (check all — a project can match multiple types):

| Type       | Indicators |
|------------|------------|
| `ios`      | `*.xcodeproj`, `*.xcworkspace`, `Podfile`, `Package.swift` with iOS/macOS targets |
| `android`  | `build.gradle` with android plugin, `AndroidManifest.xml` |
| `react`    | `package.json` with `react` dependency |
| `nextjs`   | `package.json` with `next` dependency |
| `golang`   | `go.mod` |
| `rust`     | `Cargo.toml` |
| `python`   | `pyproject.toml`, `setup.py`, `requirements.txt`, `Pipfile` |
| `ruby`     | `Gemfile` |
| `flutter`  | `pubspec.yaml` |
| `java`     | `pom.xml`, `build.gradle` (without android plugin) |

If multiple types match, keep all of them — a lesson can be scoped to any detected type. If no type is detected, the project type scope is unavailable (project and user scopes still work).

Store the detected type(s) for use in later steps.

### Initialize directories and state

- Create `.lessons/` in the working directory root if it doesn't exist
- Create `.lessons/user/` if it doesn't exist
- For each detected project type, create `.lessons/types/<type>/` if it doesn't exist
- Read `.lessons/.dismissed.json` if it exists — a JSON array of dismissed summary strings. Create as `[]` if missing.
- Read `.lessons/user/.dismissed.json` similarly.
- For each detected type, read `.lessons/types/<type>/.dismissed.json` similarly.
- Merge all dismissed lists into one dismissed set.
- List existing `.md` files in `.lessons/`, `.lessons/user/`, and each `.lessons/types/<type>/` — these are already-saved lessons. Read their `#` headings to get saved summaries.

## Step 2: Extract lessons

Analyze the **full conversation history** and extract up to **8** actionable lessons.

For each lesson produce:

| Field   | Description |
|---------|-------------|
| slug    | kebab-case filename, e.g. `idempotency-key-retries` |
| summary | One line, under 100 characters |
| context | 2-5 sentences: the scenario, why it matters, how to apply it |
| scope   | `project`, `user`, or a detected project type (e.g. `ios`, `golang`, `react`) |

**Scope guidelines:**
- `project` — lesson is specific to this codebase (references its architecture, conventions, or config)
- `user` — personal preference (style, editor, workflow habits)
- `<type>` (e.g. `ios`, `golang`, `react`) — lesson applies to any project of this type. Use this when the lesson is about a language/framework pattern, idiom, or best practice that isn't specific to this one codebase. Only use detected types from Step 1.

**Filtering — SKIP any lesson that:**
- Has a summary matching (or very similar to) an entry in the dismissed lists
- Has a slug matching an existing file in `.lessons/`, `.lessons/user/`, or any `.lessons/types/<type>/`
- Was already presented earlier in this conversation (check your own prior messages from previous `/learn` invocations in this session)

**Quality bar:** Only extract lessons that are specific, actionable, and derived from real events in this conversation. A future AI session should make a *different, better* decision by knowing the lesson. Do not extract generic advice.

**Lesson framing — every lesson MUST be a reusable process or principle, NOT a biographical fact:**
- GOOD: "Consolidate related commands into fewer entry points" — actionable, applies to future work
- GOOD: "Use ${CLAUDE_PLUGIN_ROOT} instead of hardcoded paths in plugin commands" — specific technique
- BAD: "Shahmeer builds Claude Code plugins for git workflow automation" — biographical, not actionable
- BAD: "The user prefers minimal packaging" — describes a person, not a process

Write lessons as imperative statements or patterns: "Do X when Y" / "Prefer X over Y" / "X requires Y because Z". Never reference the user by name or describe who they are. The lesson should read like a entry in a team runbook — useful to anyone, not just the person who learned it.

If `/learn` was already run in this conversation and hit the cap, you MUST extract **new, different** lessons — not repeats.

If exactly 8 lessons are extracted, the cap was hit — remember this for Step 8.

## Step 3: Present lessons

Display a numbered list of **summaries only** with suggested scope:

```
Lessons from this conversation:

 1. [project] Never retry payments without idempotency key
 2. [user]    Prefers guard clauses over nested if/else
 3. [ios]     Use async/await over completion handlers in SwiftUI views
 4. [golang]  Always check error return before using the result value
 ...

  <n>                  Show full context for a lesson
  k <n ...>            Keep lessons (e.g. k 1 3 5, or k all)
  d <n ...>            Dismiss — won't reappear on next /learn
  scope <n> p|u|<type> Change scope: (p)roject, (u)ser, or a type name
  done                 Save selections and finish
```

If zero lessons could be extracted, tell the user and stop.

## Step 4: Interactive selection

Handle user input in a loop:

- **A number** (e.g. `3`): Print that lesson's full context (the 2-5 sentence explanation), then re-display the command options.
- **`k` + numbers or `all`**: Mark those lessons for saving.
- **`d` + numbers**: Mark for dismissal. These summaries will be persisted so they never reappear.
- **`scope` + number + `p`, `u`, or a type name**: Override the suggested scope for that lesson. `p` = project, `u` = user, or a type name like `ios`, `golang`, `react`, etc. Only detected types from Step 1 are valid — reject undetected types with a message listing the detected types.
- **`done`**: Proceed to save.

The user can issue multiple commands before typing `done`. Track the running state of each lesson (unmarked / keep / dismiss / scope override).

## Step 5: Save

### Kept lessons

Write each kept lesson as a markdown file:

**Project-scoped** → `.lessons/<slug>.md`
**User-scoped** → `.lessons/user/<slug>.md`
**Type-scoped** → `.lessons/types/<type>/<slug>.md`

File format:
```markdown
# <Summary>

<Context>

---
Learned: YYYY-MM-DD
```

### Dismissed lessons

Append dismissed summaries to the `.dismissed.json` for the scope directory the lesson would have gone to:
- Project → `.lessons/.dismissed.json`
- User → `.lessons/user/.dismissed.json`
- Type → `.lessons/types/<type>/.dismissed.json`

Create the file as `[]` if it doesn't exist. Deduplicate entries.

## Step 6: QMD indexing

If qmd was installed (either previously or in Step 1), index the lessons:

```bash
# Add collections (idempotent — safe to re-run)
qmd collection add .lessons --name project-lessons 2>/dev/null || true
qmd context add qmd://project-lessons "Project-specific lessons and patterns" 2>/dev/null || true
qmd collection add .lessons/user --name user-lessons 2>/dev/null || true
qmd context add qmd://user-lessons "Personal preferences and patterns across projects" 2>/dev/null || true

# Add type collections for each detected project type
# For each <type> detected in Step 1:
qmd collection add .lessons/types/<type> --name <type>-lessons 2>/dev/null || true
qmd context add qmd://<type>-lessons "Lessons for <type> projects" 2>/dev/null || true

# Re-index and generate embeddings
qmd update 2>/dev/null
qmd embed 2>/dev/null
```

If qmd is not available (install failed in Step 1), skip silently.

## Step 7: CLAUDE.md integration

After saving lessons, ensure the project's `CLAUDE.md` includes a qmd query instruction so lessons are automatically consulted in future sessions.

1. Read `./CLAUDE.md` (create it if it doesn't exist).
2. If the file already contains `qmd query`, check whether the `--collection` flags include all detected project types. If a detected type's collection is missing, update the existing query to add it. Then skip to step 4.
3. Otherwise, append this block to the end of the file (include a `--collection <type>-lessons` flag for each detected project type):

```markdown

# Lessons

Before responding to each user prompt, search for relevant lessons using `qmd query "<query>" --collection project-lessons --collection user-lessons --collection <type>-lessons --top 5 2>/dev/null`. Write two queries: one for the **technical approach** (techniques, patterns, frameworks) and one for the **workflow/process** of executing this type of task (e.g. "modifying claude code skills", "shipping a PR", "updating a dependency"). Focus on underlying skills, not surface-level task descriptions. For example, a task about "group food items from a photo on a dashboard" should query for `"SwiftUI expandable list sections API response grouping"`, not `"grouping food entries from photo scan"`. If qmd is not available, skip silently. If results are returned, consider them as context — they contain hard-won lessons from previous sessions. Do not mention that you searched for lessons unless the user asks.
```

4. Print: `Updated CLAUDE.md with qmd query instruction.` (or `CLAUDE.md already has qmd query instruction.` if no changes were needed).

## Step 8: Summary

Print what was saved and dismissed. If the cap was hit:
"Run /learn again to extract more lessons from this conversation."

## Cross-tool compatibility

Lesson files are plain markdown — any AI CLI can read them. Claude Code's `CLAUDE.md` is updated automatically in Step 7.
