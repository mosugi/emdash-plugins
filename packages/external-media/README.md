# @mosugi/emdash-plugin-external-media

EmDash native plugin that brings images from outside the site into the media
library. Images are downloaded on the server from allowed hosts (Canva export
URLs by default) and either added as new media or used to replace an entry's
image in place.

## Install

```sh
pnpm add @mosugi/emdash-plugin-external-media
```

```js
// astro.config.mjs
import emdash from "emdash/astro";
import { externalMediaPlugin } from "@mosugi/emdash-plugin-external-media";

export default defineConfig({
  integrations: [
    emdash({
      plugins: [
        externalMediaPlugin(),
        // or: externalMediaPlugin({ allowedHosts: ["export-download.canva.com", "*.example.com"] })
      ],
    }),
  ],
});
```

In-place replacement calls EmDash's REST API through a self service binding
named `SELF`, so add it to `wrangler.jsonc`:

```jsonc
"services": [{ "binding": "SELF", "service": "<your-worker-name>" }]
```

## MCP tools

| Tool | What it does |
| --- | --- |
| `external-media__Import_From_Url` | Download an image and add it to the media library. |
| `external-media__Replace_From_Url` | Replace an entry's image (image field or Portable Text image block) in place, keeping the media id, then refresh the metadata copies stored in entries. Adds and sets a new image when the target is empty. |
| `external-media__Source_Get` / `external-media__Source_Set` | Read or record the source URL of an image (e.g. the Canva design edit URL). Stored in plugin storage, not shown on the site. |

Downloads are limited to 8 MiB and PNG, JPEG, WebP, GIF and AVIF. In-place
replacement supports PNG, JPEG and WebP, and requires the same type as the
current file.

## Requirements

- `emdash` ^1.3.0, `astro` >= 6
- Cloudflare Workers runtime for in-place replacement (`SELF` binding)

## License

MIT
