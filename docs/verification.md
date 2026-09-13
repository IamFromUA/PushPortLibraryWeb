# Preparation checks — 2026-09-13

Passed: strict TypeScript checks for DOM and service worker separately; 14 tests for public client lifecycle, transactional IndexedDB updates, worker payload/click handling, offline outbox, URL/locale/key validation and safe diagnostics. Tests use synthetic data and isolated browser API substitutes.

Built ESM, CommonJS, plain browser and standalone service-worker bundles, plus TypeScript declarations. A packed npm tarball was installed into a separate local consumer: CommonJS import and strict NodeNext TypeScript type checking passed. Manifest file list excludes local test state and dependencies.

Not run here: real provider delivery and device/browser permission UX in Chrome/Firefox/Safari. These are the subsequent integration tests. Version 0.0.1 is published as an installable npm tarball in the public GitHub release. npm registry publication remains pending publisher account setup; server rollout is tracked separately.
