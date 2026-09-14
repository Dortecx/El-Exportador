---
name: issue-creation
description: "Trigger: issue report, bug report, report problem, diagnose issue, GitHub issue. Help downloaded El Exportador users prepare safe diagnostic reports without auto-publishing issues."
license: Apache-2.0
metadata:
  author: gentleman-programming
  version: "1.0"
---

## Activation Contract

Use this skill when a person who downloaded El Exportador needs help reporting, triaging, or diagnosing a problem. Assist evidence collection and draft a safe report; do not auto-publish.

## Hard Rules

- Resolve the exact target repository before any issue workflow; never assume the current directory or origin is the reporting target.
- Inspect the target repository's README, contributing guidance, issue template config, and issue forms. Preserve repository forms as authority.
- Search open and closed duplicates before proposing a new issue.
- Redact credentials, auth headers, cookies, tokens, local user paths, hostnames, and personal playlist data from every draft, log, and M3U sample.
- Never create, comment, label, close, or approve an issue without a current direct user instruction that identifies the target and action.
- For creation: make at most one create attempt, then read back the issue from the target repository and confirm the created content. If result certainty is missing, stop.

## Decision Gates

| Evidence | Gate |
| --- | --- |
| WSL + `/mnt/c` + native module errors | Recommend platform-specific `node_modules` reinstall or a separate WSL checkout; verify before concluding. |
| Missing `ytmusicapi` | Inspect virtualenv activation and installed requirements before diagnosing. |
| Browser auth failures | Check WSLg/native browser path and validation logs before diagnosing. |
| Duplicate likely | Propose adding sanitized evidence to the duplicate only after direct user instruction. |
| Repository form required | Collect answers in that form's fields; do not replace it with a custom template. |

## Execution Steps

1. Verify target repository identity and its issue policy/forms.
2. Collect diagnostic intake using `assets/diagnostic-report-template.md`.
3. Build a one-sentence problem summary and search open and closed issues for duplicates.
4. Apply environment gates only as hypotheses backed by collected evidence.
5. Produce a sanitized draft mapped to the selected repository form, or explain why no safe issue can be proposed.
6. If the user directly instructs a target/action, perform only that action; for creation, attempt once and require read-back confirmation.

## Output Contract

Return:
- Target repository and policy/form evidence inspected.
- Duplicate search terms and outcome.
- Sanitized diagnostic summary and remaining missing evidence.
- Proposed next action: diagnose locally, use an existing issue, or ask the user to authorize a specific repository action.
- Publication status: `no_write`, `confirmed`, or `unknown`.

## References

- `assets/diagnostic-report-template.md` — compact diagnostic intake template.
