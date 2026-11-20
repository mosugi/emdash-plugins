# emdash-plugins

[EmDash](https://github.com/emdash-cms/emdash) plugins, published to npm under the `@mosugi` scope.

| Package | Description |
| --- | --- |
| [`@mosugi/emdash-plugin-external-media`](./packages/external-media) | Import images from allowed URLs (e.g. Canva exports) into the media library, or replace them in place, as MCP tools. |

## Development

```sh
pnpm install
pnpm typecheck
pnpm build
```

Packages live in `packages/<name>` and are named `@mosugi/emdash-plugin-<name>`.
In the workspace, `exports` point at `src/*.ts`; the published package uses
`publishConfig.exports`, which points at the built `dist/`.

## Releasing

Releases use [Changesets](https://github.com/changesets/changesets) and npm
Trusted Publishing (OIDC), so no npm token is stored in the repository.

1. Add a changeset with your change: `pnpm changeset`.
2. Merge to `main`. The Release workflow opens a "Version Packages" PR.
3. Merge that PR. The workflow builds and publishes the bumped packages to npm with provenance.

### Adding a package

1. Create `packages/<name>` with `"name": "@mosugi/emdash-plugin-<name>"`, the same `scripts` / `publishConfig` shape as `packages/external-media`, and a README.
2. The first version has to be published with a token, because npm only lets you configure a trusted publisher on an existing package. Add an npm granular access token (publish rights on `@mosugi`) as the repository secret `NPM_TOKEN`, then merge to `main`; the Release workflow publishes every package version not yet on npm. Publishing by hand (`pnpm publish --access public` in the package directory) also works.
3. On npmjs.com, open the package's Settings → Trusted Publisher and add GitHub Actions with repository `mosugi/emdash-plugins` and workflow `release.yml`.
4. Delete the `NPM_TOKEN` secret. Later releases use OIDC only.
