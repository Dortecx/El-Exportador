# Diagnostic Report Intake

> Replace placeholders with sanitized facts. Do not include credentials, auth headers/cookies/tokens, local user paths, hostnames, or personal playlist data.

## Target

- Repository: `<owner/repo or URL>`
- Existing related issue(s): `<none or links>`

## Environment

- App version or commit: `<version/commit>`
- OS: `<Windows / WSL / Linux / other>`
- Context: `<native Windows / WSL distro / Linux desktop>`
- Install mode and location: `<npm/dev checkout/package/etc.; sanitized path>`
- Node version: `<node -v>`
- Python version: `<python --version>`
- Virtualenv: `<active .venv / other / none / unknown>`

## Command

```sh
<sanitized launch command>
```

## Behavior

- Expected: `<what should happen>`
- Actual: `<what happens instead>`
- Affects dry-run mode: `<yes/no/unknown>`
- Affects write mode: `<yes/no/unknown/not tested>`

## Minimal Sanitized M3U

```m3u
#EXTM3U
#EXTINF:<duration>,<artist> - <track>
<sanitized media path or URL placeholder>
```

## Reproduction Steps

1. `<step>`
2. `<step>`
3. `<step>`

## Relevant Bounded Logs

```text
<only the smallest relevant sanitized log excerpt>
```

## Notes

- Recent install/update/change: `<yes/no/details>`
- Browser/auth flow used: `<native browser / WSLg / copied URL / not applicable>`
- Validation log checked: `<yes/no/path redacted/summary>`
