# Repository Agent Guidance

## Verification Budget

Use the smallest verification step that provides direct evidence for the change.
Testing should support development rather than repeatedly delay it.

- During routine development, run one targeted verification pass for the files or package changed.
- Run static checks only when they apply to the touched language or are explicitly required by existing repository guidance.
- Do not run full repository suites, Docker image builds, or multi-architecture builds by default.
- Reserve broad and multi-architecture verification for release readiness, an explicit user request, or a change that directly affects packaging or architecture-specific behavior.
- For authentication, privilege boundaries, migrations, and destructive behavior, add or run one focused integration scenario that exercises the changed boundary. Do not expand this into unrelated exhaustive testing.
- If the same expensive verification fails twice, stop rerunning the broad command. Isolate the failure with a smaller reproduction, make the fix, and perform at most one broad confirmation run when justified.
- Do not rerun passing checks unless subsequent edits could affect what they covered.
- Report any verification not performed and the resulting residual risk instead of pursuing complete coverage automatically.
- Always honor a test command explicitly requested by the user and mandatory checks stated elsewhere in repository guidance.

Before starting an expensive verification step, prefer asking the user when its value is uncertain.
