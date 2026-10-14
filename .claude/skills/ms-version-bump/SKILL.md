---
name: ms-version-bump
description: Release workflow for MemSmith. Bumps the version in package.json, syncs every manifest with the build, updates the changelog, and pushes a v* tag that publishes to npm through the trusted-publishing workflow.
---

# Version bump and release

Write the release notes before you start. At the end, nothing is left uncommitted or unpushed.

## Preparation

1. **Choose the bump**: PATCH for fixes, MINOR for features, MAJOR for breaking changes.
2. **Know what carries the version.** Edit only `package.json` by hand. `npm run build` syncs the rest from it:
   - `scripts/sync-plugin-manifests.js` writes `plugin/.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, and the `memsmith` entry in `.claude-plugin/marketplace.json`.
   - `scripts/build-hooks.js` writes `plugin/package.json` and bakes the version into the bundles.

   Nothing else needs a manual version edit.

## Workflow

1. **Bump**: `npm version X.Y.Z --no-git-tag-version`.
2. **Changelog**: In `CHANGELOG.md`, rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD` and add an empty `## [Unreleased]` above it.
3. **Build**: `npm run build`. Then confirm that every manifest carries the new version: `git grep -n "\"version\": \"X.Y.Z\""` lists `package.json`, `plugin/package.json`, the three plugin manifests, and `.claude-plugin/marketplace.json`, and `git grep -n "\"version\": \"<OLD>\""` returns nothing.
4. **Test**: `bun test` and `npx tsc --noEmit`.
5. **Commit**: `git add -A && git commit -m "chore: release X.Y.Z"`.
6. **Tag**: `git tag -a vX.Y.Z -m "Version X.Y.Z"`.
7. **Push**: `git push origin main --follow-tags`. The `v*` tag starts `.github/workflows/npm-publish.yml`, which checks that the tag matches `package.json`, builds, runs the clean-room smoke test, and publishes with npm trusted publishing. Don't run `npm publish` yourself.
8. **Watch the run**: `gh run watch`. If it fails, fix the cause, and release a new patch version rather than moving the tag.
9. **Verify**: `npm view memsmith@X.Y.Z version` prints `X.Y.Z`.
10. **GitHub release**: `gh release create vX.Y.Z --title "vX.Y.Z" --notes "RELEASE_NOTES"`.
11. **Local copy (optional)**: To run the new version locally, run `npm run build-and-sync`, then `memsmith restart`.
12. **Finalize**: `git status` shows a clean tree.

## Checklist

- [ ] `package.json` bumped, and `npm run build` synced every manifest
- [ ] `CHANGELOG.md` has the new version section and an empty `Unreleased` section
- [ ] Tests and type check pass
- [ ] Commit and `vX.Y.Z` tag pushed with `--follow-tags`
- [ ] The publish workflow run succeeded
- [ ] `npm view memsmith@X.Y.Z version` confirms the release
- [ ] GitHub release created
- [ ] `git status` shows a clean tree
