# Publishing

Repository: https://github.com/IamFromUA/PushPortLibraryWeb. Package: `@pushport/web-sdk`, initial version `0.0.1`, Apache-2.0. Versions and release tags are immutable.

## Verification and release archive

Run `npm ci`, `npm pack`, then `node scripts/verify-package.mjs`. Packing checks types and synthetic protocol/worker tests. The independent consumer checks ESM, CommonJS, TypeScript declarations and the worker export. CI uploads the identical `.tgz` for distribution; no accounts or real notifications are used by these checks. Attach it to the matching GitHub release. Device/browser delivery is verified separately using the checklist in verification.md.

## First npm publication

The account must own the `pushport` scope; a matching domain or GitHub organization alone does not grant npm scope ownership. Log in using `npm login`, then publish the reviewed archive with `npm publish pushport-web-sdk-0.0.1.tgz --access public`. Complete npm's 2FA prompt yourself. Never commit `.npmrc` or access tokens.

## Subsequent releases with GitHub OIDC

In npm package settings, add a trusted publisher: GitHub owner `IamFromUA`, repository `PushPortLibraryWeb`, workflow `publish.yml`, environment `npm`. The workflow uses short-lived OIDC credentials and provenance instead of a stored npm token. Create the GitHub `npm` environment before running it. Run **Publish npm** manually with the existing release tag; the workflow checks that the package version matches. Ordinary pushes only run verification and do not publish a package.

The service worker must still be copied to each consumer's own origin. A published npm package does not automatically configure VAPID or enable the server provider.

References: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/), [npm publish](https://docs.npmjs.com/cli/commands/npm-publish).
