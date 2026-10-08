# Changelog

All notable changes to this package are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.8.0] - 2026-09-30

### Added

- **Limits on things that exist.** A plan limit can now be a gauge: `bridge.usage.set(metric, value)` tells Bridge how many of something currently exist, such as tickets or projects, and the number never resets with the billing period. Deleting one frees room again. Counters that add up each period, such as API calls, work exactly as before.
- **Seat limits counted from membership.** A quota snapshot now says when Bridge counts a limit from the workspace's members, so a seat limit your app names always shows the real member count, pending invites included, however people are added or removed.
- **A feature flag that is off says why.** Flag evaluation now returns the reason next to the value: not on the workspace's plan, not allowed for this person's role or privileges, or switched off. Your app can offer an upgrade for the first, point to an admin for the second and simply hide the feature for the third. When a rule has several conditions, the one that failed is reported.
- **Plans list the features they include.** A plan's list of included features feeds flag rules, so a rule can say "the plan includes this feature" without naming plans, and changing what a plan sells needs no change to the rule.
- **The same flag rules on the backend.** `claimsToAttributes` and `flattenBillingSnapshot` are exported, so a backend can evaluate rules about role, privileges, plan and plan features exactly as the browser does.
- **`UsageReporter` exported.** It can now be imported by name from the package root.

### Fixed

- **Role changes during a reconnect.** A role or permission change made while the app was reconnecting could be lost, leaving the person on their old role until they reloaded. Every connection now catches up, so the change always arrives live.
- **Billing status right after checkout.** Returning from a Stripe checkout often showed "Subscription unavailable" until a reload. Billing and quota reads now renew an out-of-date sign-in and retry, so the new plan shows straight away.
- **Privilege rules match whole names.** A rule on a privilege such as `REPORTS_VIEW` no longer also matches a longer one such as `REPORTS_VIEW_ALL`.

## [0.7.3] - 2026-09-26

### Fixed

- **Live updates and browser usage reporting in React, Next.js and Angular apps.** Live updates now connect, so plans, entitlements and usage counters refresh without a page reload, and usage reported from the browser is recorded. Previously the browser rejected these calls, so live updates never connected and browser-side usage reports were lost.
