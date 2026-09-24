---
name: release
description: Ship a new oPius version to GitHub and npm through CI, with every gate checked.
disable-model-invocation: true
---

# Release

Walk the user through one release. Every step ends on a **gate**: a checkable state. Report each gate's evidence (command output, run URL) before moving on, and stop at the first red gate.

Pushing, tagging, creating the release, and any `npm` publish or unpublish are **outward** actions: state exactly what will happen and get the user's go-ahead before each one.

## 1. Preflight

- On `main`, working tree clean, in sync with `origin/main` (`git fetch`, `git status -sb`).
- `gh auth status` logged in; latest CI run on `HEAD` is green (`gh run list --workflow ci.yml --limit 1`).
- Last release: `git describe --tags --abbrev=0`. Changes since: `git log <tag>..HEAD --oneline`.

**Gate:** clean, synced, CI green, and at least one change since the last tag that touches the published package (`index.ts`, `src/`, `README.md`, `package.json`, `LICENSE`). If nothing published changed, there is nothing to release; say so and stop.

## 2. Choose the version

Propose a semver bump from the changes: patch for fixes, minor for features or new models, while on `0.x`. A version number is spent forever once published, even if unpublished later.

**Gate:** the user confirms the exact version `X.Y.Z`.

## 3. Local verification

1. `npm ci && npm run check && npm test`: all pass.
2. **Install check**, the one that catches what the dev checkout hides (pi supplies only package roots to installed extensions): pack, unpack into a fresh folder with no `node_modules` above it, and load it the way an install does:
   ```sh
   D=$(mktemp -d) && npm pack -q --pack-destination "$D" >/dev/null && tar xzf "$D"/opius-*.tgz -C "$D"
   (cd "$D" && pi -ne -e "$D/package" --list-models claude-subscription)
   ```
   All six models listed.
3. Offer the live run (uses a little subscription allowance): `node test/live.ts`. Run it when the change touches `src/stream.ts`, `src/relay.ts` or `src/history.ts`.

**Gate:** tests green, all six models listed from the tarball, and the live run passed or the user skipped it.

## 4. Bump and push

1. `npm version X.Y.Z --no-git-tag-version` (updates `package.json` and `package-lock.json`).
2. If the change qualified a new Claude Code or pi version, update the README badges and Requirements table to match.
3. Commit `Release vX.Y.Z`, then push after the user's go-ahead.
4. Wait for CI on that exact commit: `gh run watch <id> --exit-status`.

**Gate:** CI green on the release commit on Node 22, 24 and 26.

## 5. GitHub Release → npm

1. Draft release notes from `git log <last-tag>..HEAD`: user-facing changes only, a few bullets. Show them to the user.
2. After approval: `gh release create vX.Y.Z --target <release-commit-sha> --title "oPius vX.Y.Z" --notes-file <notes>`.
3. The `Publish` workflow runs on the release: it checks the tag matches `package.json`, re-runs check and tests, and publishes with provenance through npm trusted publishing. Watch it: `gh run watch <id> --exit-status`.
4. If the publish step fails on authentication, trusted publishing is not configured on npmjs.com. The user either configures it (package Settings → Trusted Publisher: GitHub Actions, `mandofever78/oPius`, `publish.yml`) and re-runs the workflow, or runs `npm publish --access public` locally.

**Gate:** `npm view opius@X.Y.Z version --prefer-online` prints the version, and `dist-tags.latest` is `X.Y.Z`. npm's metadata cache lags by up to a few minutes, so always pass `--prefer-online` and retry before concluding anything is missing.

## 6. Post-release check

1. `pi update --extensions`, then confirm `~/.pi/agent/npm/node_modules/opius/package.json` shows `X.Y.Z`.
2. From a scratch directory: `pi --list-models claude-subscription`, then one live prompt, e.g. `pi -p --no-session --model claude-subscription/claude-opus-5-5 "Use the bash tool to run: echo release-ok. Then reply with only the command output."`.

**Gate:** the installed version matches and the live prompt prints `release-ok`.

## If a published version is broken

Ship the fix as a new version through this same flow first. Then, within 72 hours of the broken publish, the user may run `npm unpublish opius@<broken> --prefer-online`; after 72 hours, `npm deprecate opius@<broken> "<reason>; use X.Y.Z"`. Unpublishing the only remaining version removes the whole package and locks the name for 24 hours, so the fix goes out first.
