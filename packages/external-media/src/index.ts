/**
 * external-media: bring in images from outside the site (external media). Images are
 * downloaded from allowed URLs on the server and put into the media library or
 * into content.
 *
 * MCP tools:
 * - `external-media__Import_From_Url`: add an image to the media library.
 * - `external-media__Replace_From_Url`: replace an entry's image in place
 *   (same media id, like "Replace image" in the admin), then bring the copies
 *   of the media's metadata stored inside entries in line with the new file.
 *   When the target has no image yet, the image is added and set instead.
 * - `external-media__Source_Get` / `external-media__Source_Set`: read
 *   or record where an image came from, as a URL (e.g. the Canva design's edit
 *   URL `https://www.canva.com/design/DAxxxxxxxxx/edit`). The source
 *   is kept in this plugin's storage, keyed by media id, so it never appears
 *   in the editor or on the site.
 *
 * In-place replacement uses EmDash's public REST endpoints with the caller's
 * own credentials, reached through the Worker's self service binding `SELF`
 * (wrangler.jsonc of the site): `PUT /_emdash/api/media/{id}/replace` and, to find the
 * entries using a media item, `GET /_emdash/api/media/{id}/usage`.
 *
 * Only hosts listed in `allowedHosts` can be downloaded from. Downloads are
 * limited to 8 MiB and to the image types below.
 */
import { z } from "astro/zod";
import { definePlugin } from "emdash";
import type { PluginContext, PluginDescriptor, RouteContext } from "emdash";
import pkg from "../package.json" with { type: "json" };

// The entry and media shapes the plugin context hands out. They differ from the
// `ContentItem` / `MediaItem` that "emdash" exports for site code, so derive
// them from the context itself.
type ContentItem = NonNullable<Awaited<ReturnType<NonNullable<RouteContext["content"]>["get"]>>>;
type MediaItem = NonNullable<Awaited<ReturnType<NonNullable<RouteContext["media"]>["get"]>>>;

const PLUGIN_ID = "external-media";
const PLUGIN_VERSION: string = pkg.version;
/** Module EmDash imports `createPlugin` from at build time. */
const ENTRYPOINT: string = pkg.name;

/** Hosts the plugin may download from unless the site overrides them. */
export const DEFAULT_ALLOWED_HOSTS = ["export-download.canva.com"];

/** Plugin KV prefix for image sources, keyed by media id. */
const SOURCE_KEY = "source:";

const IMAGE_TYPES: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif",
	"image/avif": "avif",
};

/** Types EmDash can replace in place (see the media replace endpoint). */
const REPLACEABLE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

const MAX_BYTES = 8 * 1024 * 1024;
const PAGE = 100;

const sourceSchema = z
	.string()
	.url()
	.max(500)
	.refine((value) => /^https?:\/\//.test(value), "Use an http or https URL")
	.describe(
		"URL where the image came from, e.g. the Canva design's edit URL 'https://www.canva.com/design/DAHawbtGF5Q/edit'. Stored with the media, not shown in the editor or on the site.",
	);

const imageInputShape = {
	url: z.string().url().describe("HTTPS URL of the image (e.g. a Canva export download URL). The host must be allowed."),
	filename: z
		.string()
		.min(1)
		.max(200)
		.optional()
		.describe("Filename for a newly added image, e.g. 'my-post-cover.png'. Ignored when replacing in place."),
	alt: z.string().max(1000).optional().describe("Alt text. Leave out to keep the current alt text, or pass an empty string to clear it."),
	caption: z.string().max(1000).optional().describe("Caption shown with the image. Leave out to keep it, or pass an empty string to clear it. Do not put the design ID here; use source."),
	source: sourceSchema.optional(),
};

const importInput = z.object(imageInputShape);

const replaceInput = z.object({
	...imageInputShape,
	collection: z.string().min(1).default("posts").describe("Collection slug (default 'posts')"),
	id: z.string().min(1).describe("Entry ID (ULID). Slugs are not accepted; look the ID up with content_get first."),
	field: z
		.string()
		.min(1)
		.default("featured_image")
		.describe("Image field (default 'featured_image') or, with blockKey, a Portable Text field such as 'content'."),
	blockKey: z
		.string()
		.min(1)
		.optional()
		.describe("_key of the image block to replace inside a Portable Text field. Omit to target an image field."),
});

const sourceGetInput = z.object({
	mediaId: z.string().min(1).optional().describe("Media id. Or give collection, id and field (and blockKey) to look it up from an entry."),
	collection: z.string().min(1).default("posts"),
	id: z.string().min(1).optional().describe("Entry ID (ULID)"),
	field: z.string().min(1).default("featured_image"),
	blockKey: z.string().min(1).optional(),
});

const sourceSetInput = z.object({
	mediaId: z.string().min(1).describe("Media id"),
	source: sourceSchema.nullable().describe("Source URL to record, e.g. 'https://www.canva.com/design/DAHawbtGF5Q/edit', or null to clear it."),
});

const mediaFields = {
	mediaId: z.string().optional(),
	storageKey: z.string().optional(),
	url: z.string().optional(),
	filename: z.string().optional(),
	mimeType: z.string().optional(),
	size: z.number().optional(),
	width: z.number().nullable().optional(),
	height: z.number().nullable().optional(),
	source: z.string().nullable().optional(),
};

const errorFields = {
	ok: z.boolean(),
	error: z.string().optional(),
	message: z.string().optional(),
};

const entryRef = z.object({ collection: z.string(), id: z.string() });

const importOutput = z.object({ ...errorFields, ...mediaFields });

const replaceOutput = z.object({
	...errorFields,
	...mediaFields,
	mode: z.enum(["replaced", "added"]).optional(),
	entryId: z.string().optional(),
	entryStatus: z.string().optional(),
	usageLookup: z.enum(["index", "scan"]).optional(),
	copiesUpdated: z.array(entryRef).optional(),
	copiesSkippedPublished: z.array(entryRef).optional(),
	warnings: z.array(z.string()).optional(),
});

const sourceOutput = z.object({ ...errorFields, mediaId: z.string().optional(), source: z.string().nullable().optional() });

type Failure = { ok: false; error: string; message: string };
type ImportResult = z.infer<typeof importOutput>;
type ReplaceResult = z.infer<typeof replaceOutput>;
type SourceResult = z.infer<typeof sourceOutput>;
type EntryRef = z.infer<typeof entryRef>;

interface Downloaded {
	ok: true;
	bytes: ArrayBuffer;
	mimeType: string;
	ext: string;
	url: URL;
}

interface ImportedImage {
	ok: true;
	mediaId: string;
	storageKey: string;
	url: string;
	filename: string;
	mimeType: string;
	size: number;
	width: number | null;
	height: number | null;
	alt: string | null;
	caption: string | null;
	blurhash: string | null;
	dominantColor: string | null;
}

export interface ExternalMediaOptions {
	/** Hosts images may be downloaded from. `*.example.com` matches subdomains. Defaults to `DEFAULT_ALLOWED_HOSTS`. */
	allowedHosts?: string[];
}

type MediaImportOptions = ExternalMediaOptions;

export interface Fetcher {
	fetch(request: Request): Promise<Response>;
}

/** Descriptor for `emdash({ plugins: [externalMediaPlugin()] })` in astro.config.mjs. */
export function externalMediaPlugin(options: MediaImportOptions = {}): PluginDescriptor<MediaImportOptions> {
	return {
		id: PLUGIN_ID,
		version: PLUGIN_VERSION,
		format: "native",
		entrypoint: ENTRYPOINT,
		options,
	};
}

function isAllowedHost(hostname: string, allowedHosts: string[]): boolean {
	const host = hostname.toLowerCase();
	return allowedHosts.some((pattern) => {
		const p = pattern.toLowerCase();
		if (p.startsWith("*.")) return host.endsWith(p.slice(1)) || host === p.slice(2);
		return host === p;
	});
}

function fail(error: string, message: string): Failure {
	return { ok: false, error, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Use the given name (or the URL's last path segment) with an extension matching the type. */
function resolveFilename(requested: string | undefined, url: URL, ext: string): string {
	const fromUrl = decodeURIComponent(url.pathname.split("/").pop() ?? "");
	const raw = (requested ?? fromUrl).trim() || "image";
	const safe = raw.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-");
	const dot = safe.lastIndexOf(".");
	const stem = dot > 0 ? safe.slice(0, dot) : safe;
	return `${stem || "image"}.${ext}`;
}

async function getSource(ctx: PluginContext, mediaId: string): Promise<string | null> {
	return (await ctx.kv.get<string>(`${SOURCE_KEY}${mediaId}`)) ?? null;
}

async function setSource(ctx: PluginContext, mediaId: string, source: string | null | undefined): Promise<void> {
	if (source === undefined) return;
	if (source === null) await ctx.kv.delete(`${SOURCE_KEY}${mediaId}`);
	else await ctx.kv.set(`${SOURCE_KEY}${mediaId}`, source);
}

/** Apply alt text and caption when given. An empty string clears the value. */
async function applyMetadata(ctx: PluginContext, mediaId: string, input: { alt?: string; caption?: string }) {
	if ((input.alt === undefined && input.caption === undefined) || !ctx.media?.updateMetadata) return;
	await ctx.media.updateMetadata(mediaId, {
		...(input.alt !== undefined ? { alt: input.alt || null } : {}),
		...(input.caption !== undefined ? { caption: input.caption || null } : {}),
	});
}

/** Download an image from an allowed host and check its type and size. */
async function download(ctx: PluginContext, rawUrl: string, allowedHosts: string[]): Promise<Downloaded | Failure> {
	const url = new URL(rawUrl);
	if (url.protocol !== "https:") return fail("INVALID_URL", "Only https URLs are accepted");
	if (!isAllowedHost(url.hostname, allowedHosts)) {
		return fail("HOST_NOT_ALLOWED", `Host ${url.hostname} is not allowed. Allowed: ${allowedHosts.join(", ")}`);
	}
	if (!ctx.http) return fail("HTTP_UNAVAILABLE", "Outbound requests are not available");

	let response: Response;
	try {
		response = await ctx.http.fetch(url.href);
	} catch (error) {
		ctx.log.warn("external-media fetch failed", { host: url.hostname });
		return fail("FETCH_FAILED", error instanceof Error ? error.message : "Download failed");
	}
	if (!response.ok) return fail("FETCH_FAILED", `Download returned HTTP ${response.status}`);

	const mimeType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
	const ext = IMAGE_TYPES[mimeType];
	if (!ext) return fail("UNSUPPORTED_TYPE", `Unsupported content type: ${mimeType || "unknown"}`);

	const bytes = await response.arrayBuffer();
	if (bytes.byteLength === 0) return fail("EMPTY_FILE", "Downloaded file is empty");
	if (bytes.byteLength > MAX_BYTES) return fail("TOO_LARGE", "File exceeds 8 MiB");
	return { ok: true, bytes, mimeType, ext, url };
}

/** Register downloaded bytes as a new media item. */
async function addMedia(
	ctx: PluginContext,
	file: Downloaded,
	input: z.infer<typeof importInput>,
): Promise<ImportedImage | Failure> {
	if (!ctx.media?.upload) return fail("MEDIA_UNAVAILABLE", "Media upload is not available on this site");
	const filename = resolveFilename(input.filename, file.url, file.ext);
	const uploaded = await ctx.media.upload(filename, file.mimeType, file.bytes);

	await applyMetadata(ctx, uploaded.mediaId, input);
	await setSource(ctx, uploaded.mediaId, input.source);

	const item = await ctx.media.get(uploaded.mediaId);
	ctx.log.info("external-media added image", { mediaId: uploaded.mediaId, size: file.bytes.byteLength });
	return {
		ok: true,
		mediaId: uploaded.mediaId,
		storageKey: uploaded.storageKey,
		url: uploaded.url,
		filename,
		mimeType: file.mimeType,
		size: file.bytes.byteLength,
		width: item?.width ?? null,
		height: item?.height ?? null,
		alt: item?.alt ?? input.alt ?? null,
		caption: item?.caption ?? input.caption ?? null,
		blurhash: item?.blurhash ?? null,
		dominantColor: item?.dominantColor ?? null,
	};
}

function mediaSummary(image: ImportedImage) {
	return {
		mediaId: image.mediaId,
		storageKey: image.storageKey,
		url: image.url,
		filename: image.filename,
		mimeType: image.mimeType,
		size: image.size,
		width: image.width,
		height: image.height,
	};
}

/** Read width and height from PNG, JPEG or WebP bytes. */
export function imageDimensions(buffer: ArrayBuffer): { width: number; height: number } | null {
	const b = new Uint8Array(buffer);
	const dv = new DataView(buffer);
	// PNG: IHDR is the first chunk.
	if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
		return { width: dv.getUint32(16), height: dv.getUint32(20) };
	}
	// JPEG: walk markers to the first start-of-frame.
	if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
		let i = 2;
		while (i + 9 < b.length) {
			if (b[i] !== 0xff) return null;
			const marker = b[i + 1]!;
			if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
				i += 2;
				continue;
			}
			const length = dv.getUint16(i + 2);
			const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
			if (isSof) return { height: dv.getUint16(i + 5), width: dv.getUint16(i + 7) };
			i += 2 + length;
		}
		return null;
	}
	// WebP: RIFF container with a VP8, VP8L or VP8X chunk.
	const tag = (at: number) => String.fromCharCode(...b.slice(at, at + 4));
	if (b.length >= 30 && tag(0) === "RIFF" && tag(8) === "WEBP") {
		const chunk = tag(12);
		if (chunk === "VP8 ") return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
		if (chunk === "VP8L") {
			const bits = dv.getUint32(21, true);
			return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
		}
		if (chunk === "VP8X") {
			const w = b[24]! | (b[25]! << 8) | (b[26]! << 16);
			const h = b[27]! | (b[28]! << 8) | (b[29]! << 16);
			return { width: w + 1, height: h + 1 };
		}
	}
	return null;
}

/** The Worker's own service binding, used to call EmDash's REST API in-process. */
async function selfBinding(): Promise<Fetcher | null> {
	try {
		const workers = (await import("cloudflare:workers")) as { env?: Record<string, unknown> };
		const self = workers.env?.SELF as Fetcher | undefined;
		return self && typeof self.fetch === "function" ? self : null;
	} catch {
		return null;
	}
}

/** Credentials of the caller, forwarded so EmDash applies the caller's own permissions. */
function callerAuthHeaders(request: Request): Headers | null {
	const headers = new Headers();
	const authorization = request.headers.get("authorization");
	const cookie = request.headers.get("cookie");
	if (authorization) headers.set("Authorization", authorization);
	else if (cookie) {
		headers.set("Cookie", cookie);
		headers.set("X-EmDash-Request", "1");
	} else return null;
	return headers;
}

/** Overwrite an existing media item's file through `PUT /_emdash/api/media/{id}/replace`. */
async function replaceInPlace(
	ctx: RouteContext,
	self: Fetcher,
	headers: Headers,
	mediaId: string,
	file: Downloaded,
): Promise<{ ok: true; width: number; height: number; storageKey: string | null } | Failure> {
	if (!REPLACEABLE_TYPES.has(file.mimeType)) {
		return fail("UNSUPPORTED_TYPE", `EmDash can replace only PNG, JPEG or WebP in place, got ${file.mimeType}`);
	}
	const dims = imageDimensions(file.bytes);
	if (!dims || dims.width <= 0 || dims.height <= 0) return fail("INVALID_IMAGE", "Could not read the image dimensions");

	const form = new FormData();
	form.set("file", new File([file.bytes], `replacement.${file.ext}`, { type: file.mimeType }));
	form.set("width", String(dims.width));
	form.set("height", String(dims.height));
	const endpoint = new URL(`/_emdash/api/media/${encodeURIComponent(mediaId)}/replace`, ctx.request.url);
	const response = await self.fetch(new Request(endpoint, { method: "PUT", headers, body: form }));
	const body = (await response.json().catch(() => null)) as
		| { success?: boolean; data?: { item?: { storageKey?: string } }; error?: { code?: string; message?: string } }
		| null;
	if (!response.ok || !body?.success) {
		return fail(body?.error?.code ?? "REPLACE_FAILED", body?.error?.message ?? `Replace returned HTTP ${response.status}`);
	}
	return { ok: true, ...dims, storageKey: body.data?.item?.storageKey ?? null };
}

/** Image field value in the same shape the admin and the MCP tools store. */
function imageFieldValue(image: ImportedImage) {
	return {
		id: image.mediaId,
		provider: "local",
		filename: image.filename,
		mimeType: image.mimeType,
		width: image.width,
		height: image.height,
		alt: image.alt,
		...(image.caption ? { caption: image.caption } : {}),
		meta: {
			storageKey: image.storageKey,
			caption: image.caption,
			blurhash: image.blurhash,
			dominantColor: image.dominantColor,
		},
	};
}

/** Portable Text image block for new media, keeping an existing block's identity and layout. */
function imageBlockValue(previous: Record<string, unknown>, image: ImportedImage) {
	const { asset: _asset, width: _w, height: _h, ...rest } = previous;
	return {
		...rest,
		_type: "image",
		asset: { _ref: image.mediaId, url: image.url },
		...(image.alt ? { alt: image.alt } : {}),
		...(image.caption ? { caption: image.caption } : {}),
		...(image.width ? { width: image.width } : {}),
		...(image.height ? { height: image.height } : {}),
	};
}

/** Local media id referenced by an image field value or Portable Text image block. */
function referencedMediaId(value: unknown): string | null {
	if (!isRecord(value)) return null;
	if (typeof value.provider === "string" && value.provider !== "local") return null;
	if (isRecord(value.asset)) return typeof value.asset._ref === "string" ? value.asset._ref : null;
	return typeof value.id === "string" ? value.id : null;
}

/** The entry's current editable data: its pending draft revision if there is one, else the stored row. */
async function editableData(
	ctx: PluginContext,
	collection: string,
	entry: ContentItem,
): Promise<Record<string, unknown> | null> {
	if (!hasPendingDraft(entry)) return entry.data;
	if (!ctx.content?.getRevision) return null;
	const draft = await ctx.content.getRevision(collection, entry.id, entry.draftRevisionId!);
	return draft ? draft.data : null;
}

function hasPendingDraft(entry: ContentItem): boolean {
	return Boolean(entry.draftRevisionId && entry.draftRevisionId !== entry.liveRevisionId);
}

function isPublishedWithoutDraft(entry: ContentItem): boolean {
	return Boolean(entry.liveRevisionId) && !hasPendingDraft(entry);
}

/** Set `key` to `value` on `target`, reporting whether anything changed. */
function assign(target: Record<string, unknown>, key: string, value: unknown): boolean {
	if (value === undefined) return false;
	if (target[key] === value) return false;
	target[key] = value;
	return true;
}

/**
 * Rewrite every copy of `media`'s metadata found in `value` (image field values
 * and Portable Text image blocks, at any depth). Returns the new value and
 * whether anything changed; the input is not modified.
 */
export function syncMediaCopies(value: unknown, media: MediaItem): { value: unknown; changed: boolean } {
	if (Array.isArray(value)) {
		let changed = false;
		const next = value.map((item) => {
			const result = syncMediaCopies(item, media);
			changed ||= result.changed;
			return result.value;
		});
		return { value: changed ? next : value, changed };
	}
	if (!isRecord(value)) return { value, changed: false };

	let changed = false;
	const next: Record<string, unknown> = { ...value };
	const isBlock = value._type === "image" && isRecord(value.asset) && value.asset._ref === media.id;
	const isField = !isBlock && value.id === media.id && (value.provider === undefined || value.provider === "local");
	if (isBlock) {
		changed = assign(next, "width", media.width ?? undefined) || changed;
		changed = assign(next, "height", media.height ?? undefined) || changed;
		for (const key of ["alt", "caption"] as const) {
			const v = media[key];
			if (v) changed = assign(next, key, v) || changed;
			else if (key in next) {
				delete next[key];
				changed = true;
			}
		}
	} else if (isField) {
		changed = assign(next, "width", media.width ?? null) || changed;
		changed = assign(next, "height", media.height ?? null) || changed;
		changed = assign(next, "mimeType", media.mimeType) || changed;
		changed = assign(next, "alt", media.alt ?? null) || changed;
		changed = assign(next, "caption", media.caption ?? null) || changed;
		changed = assign(next, "blurhash", media.blurhash ?? null) || changed;
		changed = assign(next, "dominantColor", media.dominantColor ?? null) || changed;
		const meta = isRecord(value.meta) ? { ...value.meta } : {};
		let metaChanged = assign(meta, "caption", media.caption ?? null);
		metaChanged = assign(meta, "blurhash", media.blurhash ?? null) || metaChanged;
		metaChanged = assign(meta, "dominantColor", media.dominantColor ?? null) || metaChanged;
		if (metaChanged) {
			next.meta = meta;
			changed = true;
		}
	} else {
		for (const [key, child] of Object.entries(value)) {
			const result = syncMediaCopies(child, media);
			if (result.changed) {
				next[key] = result.value;
				changed = true;
			}
		}
	}
	return { value: changed ? next : value, changed };
}

/** Entries using a media item, from EmDash's media usage index. Null when the index cannot be read or is incomplete. */
async function usageFromIndex(ctx: RouteContext, self: Fetcher, headers: Headers, mediaId: string): Promise<EntryRef[] | null> {
	const refs: EntryRef[] = [];
	let cursor: string | undefined;
	do {
		const url = new URL(`/_emdash/api/media/${encodeURIComponent(mediaId)}/usage`, ctx.request.url);
		url.searchParams.set("limit", String(PAGE));
		if (cursor) url.searchParams.set("cursor", cursor);
		const response = await self.fetch(new Request(url, { headers }));
		if (!response.ok) return null;
		const body = (await response.json().catch(() => null)) as
			| {
					success?: boolean;
					data?: {
						items?: Array<{ collection?: string; contentId?: string; deletedAt?: string | null }>;
						nextCursor?: string;
						coverage?: { status?: string };
					};
			  }
			| null;
		if (!body?.success || !body.data) return null;
		// Only a complete index lists every entry; while it is being built or is stale, scan instead.
		if (body.data.coverage?.status !== "complete") return null;
		for (const item of body.data.items ?? []) {
			if (item.collection && item.contentId && !item.deletedAt) refs.push({ collection: item.collection, id: item.contentId });
		}
		cursor = body.data.nextCursor;
	} while (cursor);
	return refs;
}

/** Entries mentioning a media id, found by scanning every entry and pending draft. */
async function usageFromScan(ctx: PluginContext, mediaId: string): Promise<EntryRef[]> {
	const refs: EntryRef[] = [];
	if (!ctx.schema || !ctx.content) return refs;
	for (const collection of await ctx.schema.listCollections()) {
		let cursor: string | undefined;
		do {
			const page = await ctx.content.list(collection.slug, { limit: PAGE, cursor });
			for (const item of page.items) {
				const data = await editableData(ctx, collection.slug, item);
				if (JSON.stringify(item.data).includes(mediaId) || (data && JSON.stringify(data).includes(mediaId))) {
					refs.push({ collection: collection.slug, id: item.id });
				}
			}
			cursor = page.hasMore ? page.cursor : undefined;
		} while (cursor);
	}
	return refs;
}

/**
 * Bring every entry's copy of the media metadata in line with the media item.
 * Published entries without a pending draft are skipped: EmDash would turn the
 * update into a new draft, and this copy refresh should not create one.
 */
async function syncEntries(ctx: RouteContext, refs: EntryRef[], media: MediaItem) {
	const updated: EntryRef[] = [];
	const skipped: EntryRef[] = [];
	const warnings: string[] = [];
	const content = ctx.content;
	if (!content?.update) return { updated, skipped, warnings: ["content write access is not available"] };
	const seen = new Set<string>();
	for (const ref of refs) {
		const key = `${ref.collection}/${ref.id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const entry = await content.get(ref.collection, ref.id);
		if (!entry) continue;
		if (isPublishedWithoutDraft(entry)) {
			skipped.push(ref);
			continue;
		}
		const data = await editableData(ctx, ref.collection, entry);
		if (!data) {
			warnings.push(`could not read the draft of ${key}`);
			continue;
		}
		const changes: Record<string, unknown> = {};
		for (const [field, value] of Object.entries(data)) {
			const result = syncMediaCopies(value, media);
			if (result.changed) changes[field] = result.value;
		}
		if (Object.keys(changes).length) {
			await content.update(ref.collection, ref.id, changes);
			updated.push(ref);
		}
	}
	return { updated, skipped, warnings };
}


// ---------------------------------------------------------------------------
// Admin UI: a "外部メディア" panel in the entry editor's settings sidebar and a
// "外部メディア" admin page. Both list images with where they came from and a
// link to edit the original (e.g. the Canva design) in a new tab.
// ---------------------------------------------------------------------------

type Block = Record<string, unknown>;

/** Link for a recorded source: the URL itself, or a Canva edit URL for the older `canva:<designId>` form. */
export function sourceEditUrl(source: string | null): { label: string; url: string } | null {
	if (!source) return null;
	const canva = /^canva:(D[A-Za-z0-9_-]{10})$/.exec(source);
	if (canva) return { label: "ソースを開く", url: `https://www.canva.com/design/${canva[1]}/edit` };
	if (/^https?:\/\//.test(source)) return { label: "ソースを開く", url: source };
	return null;
}

interface ImageUse {
	mediaId: string;
	where: string;
}

/** Images used by an entry: image fields and Portable Text image blocks at any depth, in order. */
export function collectImages(data: Record<string, unknown>, fieldLabels: Map<string, string>): ImageUse[] {
	const uses: ImageUse[] = [];
	for (const [field, value] of Object.entries(data)) {
		const label = fieldLabels.get(field) ?? field;
		const direct = isRecord(value) && !isRecord(value.asset) ? referencedMediaId(value) : null;
		if (direct) {
			uses.push({ mediaId: direct, where: label });
			continue;
		}
		let n = 0;
		const walk = (node: unknown) => {
			if (Array.isArray(node)) return node.forEach(walk);
			if (!isRecord(node)) return;
			if (node._type === "image" && isRecord(node.asset)) {
				const id = referencedMediaId(node);
				n += 1;
				if (id) uses.push({ mediaId: id, where: `${label}の画像 ${n}` });
				return;
			}
			Object.values(node).forEach(walk);
		};
		walk(value);
	}
	return uses;
}

async function imageBlocks(ctx: PluginContext, mediaId: string, heading: string): Promise<Block[]> {
	const media = await ctx.media?.get(mediaId);
	const source = await getSource(ctx, mediaId);
	const edit = sourceEditUrl(source);
	const blocks: Block[] = [];
	if (media) blocks.push({ type: "image", url: media.url, alt: media.alt || media.filename, title: media.filename });
	if (!media) blocks.push({ type: "context", text: `${heading}（メディアが見つかりません）` });
	if (edit) {
		blocks.push({ type: "actions", elements: [{ type: "link", label: edit.label, target: { kind: "external", url: edit.url }, appearance: "secondary" }] });
	} else {
		blocks.push({ type: "context", text: source ? `出どころ: ${source}` : "出どころは記録されていません" });
	}
	return blocks;
}

async function editorPanelBlocks(ctx: RouteContext): Promise<Block[]> {
	const entryRef = ctx.ui && "entry" in ctx.ui ? ctx.ui.entry : undefined;
	if (!entryRef || !ctx.content || !ctx.schema) return [{ type: "context", text: "記事を保存すると表示されます。" }];
	const entry = await ctx.content.get(entryRef.collection, entryRef.id);
	if (!entry) return [{ type: "context", text: "記事が見つかりません。" }];
	const data = (await editableData(ctx, entryRef.collection, entry)) ?? entry.data;
	const collection = await ctx.schema.getCollection(entryRef.collection);
	const labels = new Map((collection?.fields ?? []).map((f) => [f.slug, f.label]));
	const uses = collectImages(data, labels);
	if (!uses.length) return [{ type: "context", text: "この記事には画像がありません。" }];
	const blocks: Block[] = [];
	for (const [i, use] of uses.entries()) {
		if (i > 0) blocks.push({ type: "divider" });
		blocks.push(...(await imageBlocks(ctx, use.mediaId, use.where)));
	}
	return blocks;
}

async function adminPageBlocks(ctx: RouteContext): Promise<Block[]> {
	const entries = await ctx.kv.list(SOURCE_KEY);
	const blocks: Block[] = [
		{ type: "header", text: "外部メディア" },
		{ type: "context", text: "出どころを記録した画像の一覧です。ソースを開いて編集できます。" },
	];
	if (!entries.length) {
		blocks.push({ type: "context", text: "出どころを記録した画像はまだありません。" });
		return blocks;
	}
	const self = await selfBinding();
	const headers = callerAuthHeaders(ctx.request);
	for (const { key } of entries.slice(0, 100)) {
		const mediaId = key.slice(SOURCE_KEY.length);
		const media = await ctx.media?.get(mediaId);
		blocks.push({ type: "divider" });
		blocks.push(...(await imageBlocks(ctx, mediaId, media?.filename ?? mediaId)));
		const used = self && headers ? await usageFromIndex(ctx, self, headers, mediaId).catch(() => null) : null;
		if (used?.length) {
			blocks.push({
				type: "actions",
				elements: used.slice(0, 5).map((ref) => ({
					type: "link",
					label: `使用中: ${ref.collection}`,
					target: { kind: "content", collection: ref.collection, id: ref.id },
					appearance: "inline",
				})),
			});
		} else if (used) {
			blocks.push({ type: "context", text: "使用されていません" });
		}
	}
	return blocks;
}

export function createPlugin(options: MediaImportOptions = {}, deps: { selfFetcher?: Fetcher } = {}) {
	const allowedHosts = options.allowedHosts?.length ? options.allowedHosts : DEFAULT_ALLOWED_HOSTS;

	return definePlugin({
		id: PLUGIN_ID,
		version: PLUGIN_VERSION,
		capabilities: [
			"network:request",
			"media:write",
			"media:metadata:write",
			"content:write",
			"content:revisions:read",
			"schema:read",
		],
		allowedHosts,
		admin: {
			pages: [{ path: "/media", label: "外部メディア", icon: "image" }],
			editorPanels: [{ id: "media", title: "外部メディア", route: "editor-panel", collections: ["posts", "pages"] }],
		},
		routes: {
			admin: {
				methods: ["POST"],
				request: { body: "json" },
				permission: "content:read",
				handler: async (ctx) => ({ blocks: await adminPageBlocks(ctx) }),
			},
			"editor-panel": {
				methods: ["POST"],
				request: { body: "json" },
				permission: "content:read",
				handler: async (ctx) => ({ blocks: await editorPanelBlocks(ctx) }),
			},
			"import-from-url": {
				methods: ["POST"],
				request: { body: "json" },
				permission: "media:upload",
				handler: async (ctx): Promise<ImportResult> => {
					const parsed = importInput.safeParse(ctx.input);
					if (!parsed.success) return fail("INVALID_INPUT", parsed.error.issues[0]?.message ?? "Invalid input");
					const file = await download(ctx, parsed.data.url, allowedHosts);
					if (!file.ok) return file;
					const image = await addMedia(ctx, file, parsed.data);
					if (!image.ok) return image;
					return { ok: true, ...mediaSummary(image), source: parsed.data.source ?? null };
				},
			},
			"replace-image": {
				methods: ["POST"],
				request: { body: "json" },
				permission: "content:edit_any",
				handler: async (ctx): Promise<ReplaceResult> => {
					const parsed = replaceInput.safeParse(ctx.input);
					if (!parsed.success) return fail("INVALID_INPUT", parsed.error.issues[0]?.message ?? "Invalid input");
					const input = parsed.data;
					if (!ctx.content?.update || !ctx.schema || !ctx.media) {
						return fail("CONTENT_UNAVAILABLE", "Content or media access is not available");
					}

					// Validate the target before downloading so a bad request changes nothing.
					const collection = await ctx.schema.getCollection(input.collection);
					if (!collection) return fail("NOT_FOUND", `Collection ${input.collection} not found`);
					const fieldType = collection.fields.find((f) => f.slug === input.field)?.type;
					const wantType = input.blockKey ? "portableText" : "image";
					if (fieldType !== wantType) {
						return fail("INVALID_FIELD", `${input.collection}.${input.field} is ${fieldType ?? "missing"}, expected ${wantType}`);
					}
					const entry: ContentItem | null = await ctx.content.get(input.collection, input.id);
					if (!entry) return fail("NOT_FOUND", `Entry ${input.id} not found in ${input.collection}`);

					// In collections with revisions, edits live in the draft revision until publish.
					const entryData = await editableData(ctx, input.collection, entry);
					if (!entryData) return fail("DRAFT_UNREADABLE", `Could not read the draft of ${input.collection}/${entry.id}`);
					let current: unknown = entryData[input.field];
					let blockIndex = -1;
					if (input.blockKey) {
						const blocks = Array.isArray(current) ? current : [];
						blockIndex = blocks.findIndex((b) => isRecord(b) && b._key === input.blockKey);
						const block = blocks[blockIndex];
						if (!isRecord(block) || block._type !== "image") {
							return fail("BLOCK_NOT_FOUND", `No image block with _key ${input.blockKey} in ${input.field}`);
						}
						current = block;
					}
					const mediaId = referencedMediaId(current);
					const existing = mediaId ? await ctx.media.get(mediaId) : null;
					if (existing && !REPLACEABLE_TYPES.has(existing.mimeType)) {
						return fail("UNSUPPORTED_TYPE", `Current image is ${existing.mimeType}; EmDash replaces only PNG, JPEG or WebP`);
					}
					let self: Fetcher | null = null;
					let headers: Headers | null = null;
					if (existing) {
						self = deps.selfFetcher ?? (await selfBinding());
						if (!self) return fail("SELF_BINDING_MISSING", "The SELF service binding is not configured in wrangler.jsonc");
						headers = callerAuthHeaders(ctx.request);
						if (!headers) return fail("NO_CREDENTIALS", "The request carries no credentials to forward");
					}

					const file = await download(ctx, input.url, allowedHosts);
					if (!file.ok) return file;
					const warnings: string[] = [];

					if (existing && self && headers) {
						// Same media id: every place that uses it shows the new image at once.
						if (file.mimeType !== existing.mimeType) {
							return fail(
								"TYPE_MISMATCH",
								`Replacement must be ${existing.mimeType} like the current image, got ${file.mimeType}. Export in the same format.`,
							);
						}
						const replaced = await replaceInPlace(ctx, self, headers, existing.id, file);
						if (!replaced.ok) return replaced;
						await applyMetadata(ctx, existing.id, input);
						await setSource(ctx, existing.id, input.source);

						// EmDash keeps a copy of the media metadata inside each entry; refresh them all.
						const media = (await ctx.media.get(existing.id)) ?? existing;
						const indexed = await usageFromIndex(ctx, self, headers, existing.id);
						const refs = indexed ?? (await usageFromScan(ctx, existing.id));
						refs.push({ collection: input.collection, id: entry.id });
						const sync = await syncEntries(ctx, refs, media);
						warnings.push(...sync.warnings);
						const after = await ctx.content.get(input.collection, entry.id);
						return {
							ok: true,
							mode: "replaced",
							mediaId: existing.id,
							storageKey: replaced.storageKey ?? undefined,
							mimeType: file.mimeType,
							size: file.bytes.byteLength,
							width: replaced.width,
							height: replaced.height,
							source: await getSource(ctx, existing.id),
							entryId: entry.id,
							entryStatus: after?.status ?? entry.status,
							usageLookup: indexed ? "index" : "scan",
							copiesUpdated: sync.updated,
							copiesSkippedPublished: sync.skipped,
							...(warnings.length ? { warnings } : {}),
						};
					}

					// Nothing to replace: add the image and set it on the entry.
					if (mediaId && !existing) warnings.push(`current media ${mediaId} no longer exists; added a new image`);
					const image = await addMedia(ctx, file, input);
					if (!image.ok) return image;
					const data: Record<string, unknown> = {};
					if (input.blockKey) {
						const blocks = [...(entryData[input.field] as unknown[])];
						blocks[blockIndex] = imageBlockValue(blocks[blockIndex] as Record<string, unknown>, image);
						data[input.field] = blocks;
					} else data[input.field] = imageFieldValue(image);
					// Draft-aware: a published entry gets a draft change and stays live until published.
					const updated = await ctx.content.update(input.collection, entry.id, data);
					return {
						ok: true,
						mode: "added",
						...mediaSummary(image),
						source: input.source ?? null,
						entryId: updated.id,
						entryStatus: updated.status,
						...(warnings.length ? { warnings } : {}),
					};
				},
			},
			"source-get": {
				methods: ["POST"],
				request: { body: "json" },
				permission: "content:read",
				handler: async (ctx): Promise<SourceResult> => {
					const parsed = sourceGetInput.safeParse(ctx.input);
					if (!parsed.success) return fail("INVALID_INPUT", parsed.error.issues[0]?.message ?? "Invalid input");
					const input = parsed.data;
					let mediaId = input.mediaId ?? null;
					if (!mediaId) {
						if (!input.id || !ctx.content) return fail("INVALID_INPUT", "Give mediaId, or collection and id");
						const entry = await ctx.content.get(input.collection, input.id);
						if (!entry) return fail("NOT_FOUND", `Entry ${input.id} not found in ${input.collection}`);
						const data = await editableData(ctx, input.collection, entry);
						if (!data) return fail("DRAFT_UNREADABLE", `Could not read the draft of ${input.collection}/${entry.id}`);
						let value: unknown = data[input.field];
						if (input.blockKey) {
							value = (Array.isArray(value) ? value : []).find((b) => isRecord(b) && b._key === input.blockKey);
						}
						mediaId = referencedMediaId(value);
						if (!mediaId) return fail("NO_IMAGE", `${input.collection}/${entry.id} has no image in ${input.field}`);
					}
					return { ok: true, mediaId, source: await getSource(ctx, mediaId) };
				},
			},
			"source-set": {
				methods: ["POST"],
				request: { body: "json" },
				permission: "media:edit_any",
				handler: async (ctx): Promise<SourceResult> => {
					const parsed = sourceSetInput.safeParse(ctx.input);
					if (!parsed.success) return fail("INVALID_INPUT", parsed.error.issues[0]?.message ?? "Invalid input");
					const { mediaId, source } = parsed.data;
					if (!(await ctx.media?.get(mediaId))) return fail("NOT_FOUND", `Media ${mediaId} not found`);
					await setSource(ctx, mediaId, source);
					return { ok: true, mediaId, source };
				},
			},
		},
		mcp: {
			tools: {
				Import_From_Url: {
					description:
						"Download an image from an allowed HTTPS URL (e.g. a Canva export download URL) and add it to the media library without changing any content. Pass source (a URL such as the Canva design's edit URL) to record where it came from. To change an entry's image, use external-media__Replace_From_Url instead.",
					route: "import-from-url",
					input: importInput,
					output: importOutput,
					destructive: false,
				},
				Replace_From_Url: {
					description:
						"Replace an entry's image with an image from an allowed HTTPS URL (e.g. a Canva export), like 'Replace image' in the admin: the media keeps its id, the old file is overwritten and cannot be restored, and every place that uses it, including published pages, shows the new image immediately. Afterwards the copies of the media metadata stored in entries (size, type, alt, caption) are refreshed; published entries without a pending draft are left as they are and listed in copiesSkippedPublished. The new file must have the same type as the current one (PNG, JPEG or WebP). Targets an image field (default featured_image) or, with blockKey, an image block inside a Portable Text field such as content. If the target has no image yet, a new image is added and set instead (published entries then get a draft change). Pass source (a URL such as the Canva design's edit URL, https://www.canva.com/design/<designId>/edit) to record where the image came from; read it later with external-media__Source_Get.",
					route: "replace-image",
					input: replaceInput,
					output: replaceOutput,
					destructive: true,
				},
				Source_Get: {
					description:
						"Get the URL an image came from (e.g. a Canva design's edit URL, from which the design ID can be read), by media id or by the entry and field that use it. Use it to find the Canva design to edit before replacing an image. Older records may use the form 'canva:<designId>'.",
					route: "source-get",
					input: sourceGetInput,
					output: sourceOutput,
					destructive: false,
				},
				Source_Set: {
					description:
						"Record or clear the URL an image came from (e.g. the Canva design's edit URL https://www.canva.com/design/<designId>/edit). Stored with the media in this plugin, never shown in the editor or on the site; the admin shows it as a 'ソースを開く' link.",
					route: "source-set",
					input: sourceSetInput,
					output: sourceOutput,
					destructive: false,
				},
			},
		},
	});
}

export default createPlugin;
