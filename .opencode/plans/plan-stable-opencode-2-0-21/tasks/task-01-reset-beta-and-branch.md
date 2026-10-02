# Task 01 — Reset beta changes and prepare stable branch

## Goal

Reset all previous uncommitted or committed changes to `ha_opencode_beta/` so that beta remains identical to `main`. Create or switch to branch `stable/opencode-2.0.21-openchamber-2.1.0` off `main` with the CI workflow repair preserved.

## Changes

1. Checkout branch `main` or create `stable/opencode-2.0.21-openchamber-2.1.0` starting from `main`.
2. Ensure `ha_opencode_beta/` matches `main` exactly (`git diff main -- ha_opencode_beta/` is empty).
3. Preserve the repair of `.github/workflows/check-opencode-update.yaml`.

## Verification commands

```bash
git diff main -- ha_opencode_beta/   # must be empty
git diff main -- .github/workflows/check-opencode-update.yaml   # contains the CI repair
```
