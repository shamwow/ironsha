# Load — Restore lessons from a git repo

## Usage: /load [repo-url]

Pulls lessons from a remote git repository and restores them to the correct local directories based on scope.

## Step 1: Determine repo URL

Resolve the git repo in this order:

1. If a repo URL was passed as an argument (`/load git@github.com:user/lessons.git`), use it.
2. Otherwise, read `.lessons/.repo` — if it contains a URL, offer it as the default.
3. If no URL is available, ask the user for one.

After resolving, persist the URL to `.lessons/.repo` for future runs.

## Step 2: Clone

```bash
TMPDIR=$(mktemp -d)
git clone "$REPO_URL" "$TMPDIR/lessons-repo"
```

If the clone fails, inform the user and stop.

## Step 3: Preview

List what's in the repo and show a summary before making any changes:

```
Lessons in <repo-url>:

  project/      — 3 lessons, 2 dismissed
  user/         — 5 lessons, 1 dismissed
  types/ios/    — 2 lessons, 0 dismissed
  types/golang/ — 4 lessons, 1 dismissed

Restore to:
  project/      → .lessons/
  user/         → .lessons/user/
  types/<type>/ → .lessons/types/<type>/

Proceed? (y/n, or pick a scope: project / user / types / all)
```

Default to **all** if the user confirms with `y`.

## Step 4: Restore lessons

Based on the user's selection:

**Project lessons** (`project/` → `.lessons/`):
- Create `.lessons/` if it doesn't exist
- Copy all `.md` files from `project/` in the repo to `.lessons/`
- Merge `project/.dismissed.json` into `.lessons/.dismissed.json` (union, deduplicated)

**User lessons** (`user/` → `.lessons/user/`):
- Create `.lessons/user/` if it doesn't exist
- Copy all `.md` files from `user/` in the repo to `.lessons/user/`
- Merge `user/.dismissed.json` into `.lessons/user/.dismissed.json` (union, deduplicated)

**Type lessons** (`types/<type>/` → `.lessons/types/<type>/`):
- For each `<type>` directory in `types/` in the repo:
  - Create `.lessons/types/<type>/` if it doesn't exist
  - Copy all `.md` files from `types/<type>/` in the repo to `.lessons/types/<type>/`
  - Merge `types/<type>/.dismissed.json` into `.lessons/types/<type>/.dismissed.json` (union, deduplicated)

**Conflict handling:** If a local lesson file already exists with the same name, compare contents. If different, keep the one with the more recent `Learned:` date. If dates are equal or missing, prefer the remote version. Inform the user of any conflicts resolved.

## Step 5: QMD indexing

If `which qmd` succeeds, re-index:

```bash
qmd collection add .lessons --name project-lessons 2>/dev/null || true
qmd context add qmd://project-lessons "Project-specific lessons and patterns" 2>/dev/null || true
qmd collection add .lessons/user --name user-lessons 2>/dev/null || true
qmd context add qmd://user-lessons "Personal preferences and patterns across projects" 2>/dev/null || true

# Add type collections for each restored type
for type_dir in .lessons/types/*/; do
  type_name=$(basename "$type_dir")
  qmd collection add "$type_dir" --name "${type_name}-lessons" 2>/dev/null || true
  qmd context add "qmd://${type_name}-lessons" "Lessons for ${type_name} projects" 2>/dev/null || true
done

qmd update 2>/dev/null
qmd embed 2>/dev/null
```

If qmd is not available, skip silently.

## Step 6: Cleanup and summary

```bash
rm -rf "$TMPDIR"
```

Print what was restored:

```
Restored from <repo-url>:
  .lessons/                      — 3 lessons added, 1 updated, 2 dismissed merged
  .lessons/user/                — 5 lessons added, 0 updated, 1 dismissed merged
  .lessons/types/ios/            — 2 lessons added, 0 updated, 0 dismissed merged
```
