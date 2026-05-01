#!/bin/bash
# One-time GitHub setup: create private repo, push, create Project board,
# convert each top-level BACKLOG.md item into an issue + add to the project.
#
# Prerequisites:
#   1. brew install gh
#   2. gh auth login   (interactive — needs to happen before this script runs)
#
# Run once from the project root:
#   bash scripts/setup-github.sh

set -euo pipefail

REPO_NAME="FamilyResearchAgent"
PROJECT_TITLE="Family Research Agent"

cd "$(dirname "$0")/.."

# ---- Sanity checks ----------------------------------------------------------

if ! command -v gh >/dev/null 2>&1; then
  echo "ERROR: gh CLI not installed. Run: brew install gh"
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "ERROR: gh not authenticated. Run: gh auth login"
  exit 1
fi

# Project-board scope is needed for v2 projects
if ! gh auth status 2>&1 | grep -q "project"; then
  echo "Refreshing gh auth scopes to include 'project' (needed for the Project board)..."
  gh auth refresh -s project
fi

GH_USER=$(gh api user --jq .login)
echo "Authenticated as: $GH_USER"

# ---- Create or reuse the repo ----------------------------------------------

if gh repo view "$GH_USER/$REPO_NAME" >/dev/null 2>&1; then
  echo "Repo $GH_USER/$REPO_NAME already exists — skipping create."
else
  echo "Creating private repo $GH_USER/$REPO_NAME..."
  gh repo create "$REPO_NAME" --private --source=. --push
fi

# Ensure remote is set even if repo existed already
if ! git remote get-url origin >/dev/null 2>&1; then
  git remote add origin "https://github.com/$GH_USER/$REPO_NAME.git"
fi

# Push if there's anything new locally
git push -u origin main 2>&1 | tail -3

# ---- Create the Project board ----------------------------------------------

echo ""
echo "Creating Project board '$PROJECT_TITLE'..."
PROJECT_NUMBER=$(gh project list --owner "$GH_USER" --format json --jq ".projects[] | select(.title == \"$PROJECT_TITLE\") | .number" | head -1)

if [ -z "$PROJECT_NUMBER" ]; then
  PROJECT_OUTPUT=$(gh project create --owner "$GH_USER" --title "$PROJECT_TITLE" --format json)
  PROJECT_NUMBER=$(echo "$PROJECT_OUTPUT" | python3 -c "import sys,json; print(json.load(sys.stdin)['number'])")
  echo "Created Project #$PROJECT_NUMBER"
else
  echo "Project '$PROJECT_TITLE' already exists (#$PROJECT_NUMBER) — reusing."
fi

# ---- Parse BACKLOG.md and create issues ------------------------------------

echo ""
echo "Parsing BACKLOG.md and creating issues..."

python3 <<PYEOF
import re, json, subprocess, sys

with open("BACKLOG.md", "r", encoding="utf-8") as f:
    md = f.read()

# Sections are level-2 headings: "## Section Name"
sections = re.split(r"^##\s+(.+)$", md, flags=re.MULTILINE)
# sections[0] is preamble; pairs after that are (heading, body)
pairs = [(sections[i], sections[i+1]) for i in range(1, len(sections), 2)]

items = []
for section_heading, body in pairs:
    # Each top-level item starts with "- **Title.**" potentially followed by
    # a description and possibly indented sub-content.
    # Match a list item that starts with "- **" and capture until the next
    # "- **" or end of section.
    for match in re.finditer(
        r"^- \*\*([^*]+?)\.\*\*\s*([\s\S]*?)(?=\n- \*\*|\Z)",
        body,
        flags=re.MULTILINE,
    ):
        title = match.group(1).strip()
        description = match.group(2).strip()
        items.append({
            "section": section_heading.strip(),
            "title": title,
            "body": f"From BACKLOG.md → {section_heading.strip()}\n\n{description}",
        })

print(f"Found {len(items)} backlog items across {len(pairs)} sections.")
for item in items:
    # Create issue
    issue_url = subprocess.run(
        ["gh", "issue", "create",
         "--title", item["title"],
         "--body", item["body"],
         "--label", "backlog"],
        capture_output=True, text=True,
    )
    if issue_url.returncode != 0:
        # Label may not exist — retry without it
        issue_url = subprocess.run(
            ["gh", "issue", "create",
             "--title", item["title"],
             "--body", item["body"]],
            capture_output=True, text=True, check=True,
        )
    url = issue_url.stdout.strip()
    print(f"  ✔ {item['title'][:60]} → {url}")
    # Add to project
    subprocess.run(
        ["gh", "project", "item-add", "$PROJECT_NUMBER", "--owner", "$GH_USER", "--url", url],
        capture_output=True, text=True,
    )
PYEOF

echo ""
echo "Done. Open the project:"
echo "  https://github.com/users/$GH_USER/projects/$PROJECT_NUMBER"
echo ""
echo "Open the repo:"
echo "  https://github.com/$GH_USER/$REPO_NAME"
