# @mosugi/emdash-plugin-og-image

EmDash native plugin that gives every entry without an image a default Open
Graph image: a 1200×630 card with the entry title and the site name, rendered
on the server with [Satori](https://github.com/vercel/satori) and resvg
(`@cf-wasm/og`, WebAssembly on Cloudflare Workers).

## Install

```sh
pnpm add @mosugi/emdash-plugin-og-image
```

```js
// astro.config.mjs
import emdash from "emdash/astro";
import { ogImagePlugin } from "@mosugi/emdash-plugin-og-image";

export default defineConfig({
  integrations: [
    emdash({
      plugins: [
        ogImagePlugin(),
        // or: ogImagePlugin({ collections: ["posts", "pages"], theme: { brand: "#0f766e" } })
      ],
    }),
  ],
});
```

No template change is needed as long as the layout renders `<EmDashHead>` with
a `content` reference in the page context (the EmDash blog template does).

## How it works

- **`page:metadata` hook.** On a content page in one of `collections` whose
  page context has no image (no SEO panel image and no `image` passed by the
  template, e.g. a featured image), it adds `og:image`, `og:image:width`,
  `og:image:height`, `og:image:alt`, `twitter:image` and
  `twitter:card=summary_large_image`. Pages with their own image are left
  alone. Plugin metadata takes precedence over the site-wide default OG image
  in site settings, so the generated card replaces that default on these pages.
- **Public route** `GET /_emdash/api/plugins/og-image/image?collection=…&id=…&v=…`
  returns the PNG. Only published entries are rendered; the title and site
  name come from the database and settings, never from the query string.
  `v` is a hash of the title, so the URL changes when the title does.
- **Fonts** are fetched from Google Fonts per image, subset to the characters
  on the card, so Japanese titles stay small to download.
- **Caching.** Responses carry `Cache-Control: public, max-age=86400,
  stale-while-revalidate=604800`, and rendered PNGs are kept in the Workers
  Cache API (`caches.default`) keyed by the URL.

## Options

| Option | Default | |
| --- | --- | --- |
| `collections` | `["posts"]` | Collections that get a generated image. |
| `titleField` | `"title"` | Field holding the title. The SEO title is used first when set. |
| `siteName` | site title from settings | Name shown on the card. Left out when empty. |
| `fontFamily` | `"Noto Sans JP"` | Google Fonts family for the title and site name (bold). |
| `monoFontFamily` | `"JetBrains Mono"` | Google Fonts family for the host name. |
| `theme` | neutral light | `background`, `surface`, `border`, `text`, `muted`, `brand`, `onBrand` colours. |

## Requirements

- `emdash` ^1.3.0, `astro` >= 6
- Cloudflare Workers runtime (the WebAssembly modules are imported as Workers
  modules). The renderer adds roughly 750 KB gzipped to the Worker, so the
  site will usually need a Workers paid plan.
- Outbound access to `fonts.googleapis.com` and `fonts.gstatic.com`.

## License

MIT
