# GitHub Actions Extension Package Design

## Goal

Add a GitHub Actions workflow that automatically verifies and packages the AIPageGo Chromium MV3 extension. The workflow should make normal branch and pull-request builds trustworthy, and create a downloadable zip when a version tag is pushed.

## Scope

- Add one workflow under `.github/workflows/`.
- Use the existing pnpm project scripts: `typecheck`, `test`, and `build`.
- Package the Vite/CRX output from `dist/` into a Chrome-extension-ready zip.
- Do not add dependencies or change extension runtime code.

## Triggers

The workflow runs on:

- `push` to any branch, so every commit can be validated.
- `pull_request`, so proposed changes are validated before merge.
- `push` tags matching `v*`, so release tags produce a zip and GitHub Release asset.
- `workflow_dispatch`, so maintainers can run packaging manually.

## Build And Package Flow

1. Check out the repository.
2. Set up Node 20 and pnpm using Corepack.
3. Install dependencies with `pnpm install --frozen-lockfile`.
4. Run `pnpm typecheck`.
5. Run `pnpm test`.
6. Run `pnpm build`.
7. Read `package.json` version and create `aipagego-${version}.zip` from the contents of `dist/`.
8. Upload the zip as a workflow artifact for all runs.
9. For `v*` tag runs, publish or update a GitHub Release and upload the same zip as a release asset.

## Permissions And Safety

- Use built-in GitHub Actions plus shell commands only; no new npm packages.
- Grant `contents: write` only so tag builds can create releases with `GITHUB_TOKEN`.
- Keep API keys out of the workflow; the extension build does not need secrets.
- Zip only `dist/` contents, not repository source files or local config.

## Validation

- Local validation: `pnpm typecheck`, `pnpm test`, `pnpm build`.
- YAML validation: inspect workflow syntax and ensure the archive command runs from inside `dist/` so `manifest.json` is at zip root.
- CI validation: on GitHub, push a branch to confirm artifact upload, then push a `v*` tag to confirm release upload.
