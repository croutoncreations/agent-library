# Security

Please report vulnerabilities privately using GitHub's **Report a vulnerability** button on this repository (Security → Advisories). Do not open a public issue containing credentials, user content, exploit payloads against a live installation or private infrastructure details.

Include the affected commit or version, a minimal synthetic reproduction, the impact and relevant file paths. Never include token values or real artifacts.

## Supported versions

Agent Library is pre-1.0. Security fixes land on `main` and in the next release; there are no backported branches yet.

## Operating an installation securely

- Keep the owner hostname behind Cloudflare Access with a policy limited to your own identity, and keep the R2 bucket private.
- Use exact OAuth callbacks only (`OAUTH_EXTRA_REDIRECT_URIS` never accepts wildcards), short-lived and project-scoped agent access, and revoke connections you no longer use.
- Don't disable issuer/audience, CSRF or revision checks to work around a sign-in or save problem.
- Keep Node and the pinned toolchain up to date. CI runs `npm audit` on PRs. `npm audit` doesn't cover code embedded in the committed Worker bundle or Cloudflare's managed runtime.
