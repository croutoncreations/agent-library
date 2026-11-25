# Hosted Agent Library Draft Review Notes

Updated November 16, 2026. These notes are for internal review and are not part of either policy.

## Confirmed drafting choices

- Adults only, age 18 and older.
- All public contact emails use `support@croutonhq.com`.
- A 60-day active-system deletion commitment for verified account and permanent-content deletion requests, with stated legal and security exceptions, a separate backup lifecycle, and shorter statutory deadlines taking precedence.
- Subscriptions cancel at the end of the paid period; partial-period refunds are exceptional or required by law. Refunds use the payment provider.
- Planned product analytics are described without naming the provider or calling account-linked analytics anonymous.
- No infrastructure, analytics, authentication, or payment vendor names in the public drafts.

## Commitments to verify before publication

**Deletion procedure.** Sixty days gives the existing 30-day recovery window a cleanup margin, but the queue has no completion deadline. Account erasure and surviving metadata require a separate procedure. The policy is a proposed commitment, not a claim that every existing path already meets it. Shorter legal deadlines continue to apply. See [Backup and Retention Review](hosted-retention-review.md) for the source review, retention table, recovery-copy timing, and required follow-up.

**Backups and retained metadata.** Automatic database recovery is separate from file storage and can retain database copies for up to 30 days after active purge under the documented Paid plan. No scheduled complete database-and-files backup was found in the reviewed repositories. Live checks failed because the local Cloudflare login does not include the hosted account; live retention settings and external exports remain unverified. Inventory those copies, define expiry, and reapply deletions after restoration. The draft now discloses the general one-year service audit retention established by the code's default.

**Analytics configuration.** Analytics are planned, not verified as deployed. The policy text describes the intended launch state. Ensure event collection excludes document bodies, files, drafts, and sensitive URLs or properties; keep content session replay disabled. Implement consent and withdrawal where required before enabling nonessential analytics. Verify that provider configuration and agreements support the no-sale and no-advertising-sharing statement. Revise the paragraph if analytics will not be active at publication.

**Operational access and transfers.** Verify actual staff access practices, provider agreements, processing locations, and any required international transfer safeguards. The draft makes no promise that all data remains in a particular country. Customer processor obligations and any needed data processing agreement require separate review; the policy itself is not that agreement.

**Business terms proposed for review.** The draft proposes Washington courts without mandatory arbitration or a class-action waiver; a liability cap of the greater of US $100 or 12 months of affected-workspace fees; advance notice for material changes; and unused-period refunds for service discontinuation or termination unrelated to misconduct or nonpayment. These are proposed commercial choices, not conclusions about existing commitments.

**Publication details.** Confirm the support address is monitored, the mailing address is current, cancellation is accessible even for a deleted workspace, and the effective date and reciprocal policy links are set when publishing. A copyright complaint contact is included without asserting that a statutory designated agent has been registered. See [Copyright Safe Harbor Review](hosted-copyright-review.md) for the recommendation, filing steps, required contact details, and operational process. Registration is recommended but has not been performed.

## Review scope

Drafts were written from service behavior and the operator's stated preferences without opening Agent Library's existing legal pages or `docs/legal.md`. Service review included the hosted identity, invitation and billing adapters and the core referenced by the production release record, including workspace permissions, content access, temporary viewing links, browser storage, and deletion behavior. The separate development core was also consulted; neither review was a live production audit.

The supplied Crouton Creations terms URL could not be retrieved. Available company privacy pages and the requested other-product privacy and terms pages were reviewed. Their text and references are not incorporated into these public drafts.

These drafts need legal review for the intended launch markets, including applicable state privacy obligations and international availability. No existing legal pages, application routes, production settings, or deployment artifacts were changed.

This PR adds two public-policy drafts and three internal review documents only. It changes no runtime behavior. Validation results are recorded in the PR description. The first drafting pass used an unrelated global TypeScript compiler without local dependencies; the PR preparation installs the pinned dependencies and runs the required checks with Node 24.22.1.
