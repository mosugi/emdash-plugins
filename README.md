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
2. Publish the first version once by hand (`pnpm publish --access public` from the package directory), because npm only lets you configure a trusted publisher on an existing package.
3. On npmjs.com, open the package's Settings → Trusted Publisher and add GitHub Actions with repository `mosugi/emdash-plugins` and workflow `release.yml`.
