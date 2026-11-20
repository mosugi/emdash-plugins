# emdash-plugins

[EmDash](https://github.com/emdash-cms/emdash) plugins, published to npm under the `@mosugi` scope.

| Package | Description |
| --- | --- |
| [`@mosugi/emdash-plugin-external-media`](./packages/external-media) | Import images from allowed URLs (e.g. Canva exports) into the media library, or replace them in place, as MCP tools. |
| [`@mosugi/emdash-plugin-og-image`](./packages/og-image) | Default Open Graph image (title and site name) for entries without one, rendered on Workers. |

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
Publishing runs `pnpm -r publish` directly (not `changeset publish`) so the
OIDC and publish output shows up in the workflow log, then `changeset tag`
creates the tags and GitHub releases.

1. Add a changeset with your change: `pnpm changeset`.
2. Merge to `main`. The Release workflow opens a "Version Packages" PR.
3. Merge that PR. The workflow builds and publishes the bumped packages to npm with provenance.

### Adding a package

1. Create `packages/<name>` with `"name": "@mosugi/emdash-plugin-<name>"`, the same `scripts` / `publishConfig` shape as `packages/external-media`, and a README.
2. npm only lets you configure a trusted publisher on a package that already exists, so publish a placeholder once by hand (e.g. a `0.0.0` package.json with only `name` and `version`).
3. On npmjs.com, open the package's Settings → Trusted Publisher and add GitHub Actions with repository `mosugi/emdash-plugins` and workflow `release.yml`.
4. Merge to `main` (or run the Release workflow by hand). It publishes every package version not yet on npm.
