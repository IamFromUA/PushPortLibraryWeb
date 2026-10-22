# Version 0.0.2 verification — 2026-10-14

Strict DOM and worker TypeScript checks, 20 synthetic tests and an independent ESM/CommonJS/TypeScript/service-worker consumer passed. Version 0.0.2 is distributed as the public GitHub npm archive; it is not published in the npm registry. Update both the page package and copied same-origin worker. These checks do not prove provider delivery or human display.

Evidence: [successful release verification](https://github.com/IamFromUA/PushPortLibraryWeb/actions/runs/38540355252). The run commit matches the immutable public 0.0.2 tag.

## Historical 0.0.1 verification

The following results describe the initial September release, not the current test counts or publication status.

### Preparation checks — 2026-09-13

Passed: strict TypeScript checks for DOM and service worker separately; 14 tests for public client lifecycle, transactional IndexedDB updates, worker payload/click handling, offline outbox, URL/locale/key validation and safe diagnostics. Tests use synthetic data and isolated browser API substitutes.

Built ESM, CommonJS, plain browser and standalone service-worker bundles, plus TypeScript declarations. A packed npm tarball was installed into a separate local consumer: CommonJS import and strict NodeNext TypeScript type checking passed. Manifest file list excludes local test state and dependencies.

Not run here: real provider delivery and device/browser permission UX in Chrome/Firefox/Safari. These are the subsequent integration tests. Version 0.0.1 is published as an installable npm tarball in the public GitHub release. npm registry publication remains pending publisher account setup; server rollout is tracked separately.
