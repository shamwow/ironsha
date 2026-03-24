# Save — Push lessons to a git repo

## Usage: /save [repo-url]

Syncs local lessons to a remote git repository so they can be restored on another machine or shared with a team.

## Step 1: Determine scope

List existing type directories under `.lessons/types/` to discover available types.

Ask the user which lessons to save:

```
Which lessons do you want to save?

 1. [project] .lessons/ only
 2. [user]    .lessons/user/ only
 3. [types]   .lessons/types/ only (all types)
 4. [all]     Everything

>
```

## Step 2: Determine repo URL

Resolve the git repo in this order:

1. If a repo URL was passed as an argument (`/save git@github.com:user/lessons.git`), use it.
2. Otherwise, read `.lessons/.repo` — if it contains a URL, offer it as the default.
3. If no URL is available, ask the user for one.

After resolving, persist the URL to `.lessons/.repo` for future runs.

## Step 3: Clone and prepare

```bash
TMPDIR=$(mktemp -d)
git clone "$REPO_URL" "$TMPDIR/lessons-repo" 2>/dev/null || {
  # Fresh repo — initialize
  mkdir -p "$TMPDIR/lessons-repo"
  cd "$TMPDIR/lessons-repo"
  git init
  git remote add origin "$REPO_URL"
}
cd "$TMPDIR/lessons-repo"
```

Create the scope directories if they don't exist:

```bash
mkdir -p project user
# Create a types/<type>/ directory for each local type
for type_dir in .lessons/types/*/; do
  type_name=$(basename "$type_dir")
  mkdir -p "types/$type_name"
done
```

## Step 4: Copy lessons

Based on the scope selected in Step 1:

**If project or all:**
- Copy all `.md` files from `.lessons/` to `project/` in the repo
- Copy `.lessons/.dismissed.json` to `project/.dismissed.json` if it exists

**If user or all:**
- Copy all `.md` files from `.lessons/user/` (not subdirectories) to `user/` in the repo
- Copy `.lessons/user/.dismissed.json` to `user/.dismissed.json` if it exists

**If types or all:**
- For each `<type>` directory in `.lessons/types/`:
  - Copy all `.md` files from `.lessons/types/<type>/` to `types/<type>/` in the repo
  - Copy `.lessons/types/<type>/.dismissed.json` to `types/<type>/.dismissed.json` if it exists

**Merge, don't overwrite dismissed.json:** If a `.dismissed.json` already exists in the repo, merge the arrays (union of both lists, deduplicated) rather than replacing it.

## Step 5: Commit and push

```bash
cd "$TMPDIR/lessons-repo"
git add -A
git commit -m "Update lessons ($(date +%Y-%m-%d))"
git push origin "$(git branch --show-current)" || git push -u origin "$(git branch --show-current)"
```

If the push fails (e.g. repo doesn't exist yet), inform the user and suggest creating the repo first.

## Step 6: Cleanup and summary

```bash
rm -rf "$TMPDIR"
```

Print what was saved:

```
Saved to <repo-url>:
  project/    — 3 lessons, 2 dismissed
  user/       — 5 lessons, 0 dismissed
  types/ios/  — 2 lessons, 1 dismissed
  types/golang/ — 4 lessons, 0 dismissed
```
