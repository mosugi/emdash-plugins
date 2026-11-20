/**
 * og-image: a default Open Graph image for every entry that has none.
 *
 * - `page:metadata` hook: on a content page with no image of its own (no SEO
 *   panel image and no `image` passed by the template), contributes
 *   `og:image` / `twitter:image` pointing at the route below. Plugin
 *   contributions win over the site-wide default OG image, and an entry's
 *   own image always wins over this plugin because the hook steps aside.
 * - `image` route (public GET, raw PNG): renders a 1200x630 card with the
 *   entry's title and the site name. Only published entries are rendered,
 *   and the text comes from the database, never from the query string.
 *
 * Fonts come from Google Fonts, subset to the characters on the card, so
 * Japanese titles stay small to fetch. Rendered images are kept in the
 * Workers Cache API, keyed by the URL, which carries a hash of the title.
 */
import { definePlugin } from "emdash";
import type { PageMetadataContribution, PluginContext, PluginDescriptor, PublicPageContext, RouteContext } from "emdash";
import { pluginResponse } from "emdash/plugin";
import pkg from "../package.json" with { type: "json" };

const PLUGIN_ID = "og-image";
const PLUGIN_VERSION: string = pkg.version;
/** Module EmDash imports `createPlugin` from at build time. */
const ENTRYPOINT: string = pkg.name;

const ROUTE = "image";
const WIDTH = 1200;
const HEIGHT = 630;
const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];
const CACHE_CONTROL = "public, max-age=86400, stale-while-revalidate=604800";

export interface OgImageTheme {
	/** Canvas around the card. */
	background?: string;
	/** Card fill. */
	surface?: string;
	/** Card outline. */
	border?: string;
	/** Title and site name. */
	text?: string;
	/** Host name and secondary text. */
	muted?: string;
	/** Monogram fill. */
	brand?: string;
	/** Monogram letter. */
	onBrand?: string;
}

export interface OgImageOptions {
	/** Collections that get a generated image. Default `["posts"]`. */
	collections?: string[];
	/** Field holding the title. Default `"title"`; the SEO title is used first when set. */
	titleField?: string;
	/** Name shown on the card. Default: the site title from settings. */
	siteName?: string;
	/** Google Fonts family for the card text. Default `"Noto Sans JP"`. */
	fontFamily?: string;
	/** Google Fonts family for the host name. Default `"JetBrains Mono"`. */
	monoFontFamily?: string;
	theme?: OgImageTheme;
}

const DEFAULT_THEME: Required<OgImageTheme> = {
	background: "#f4f4f2",
	surface: "#ffffff",
	border: "#e2e2de",
	text: "#18181b",
	muted: "#71717a",
	brand: "#18181b",
	onBrand: "#ffffff",
};

/** Descriptor for `emdash({ plugins: [ogImagePlugin()] })` in astro.config.mjs. */
export function ogImagePlugin(options: OgImageOptions = {}): PluginDescriptor<OgImageOptions> {
	return {
		id: PLUGIN_ID,
		version: PLUGIN_VERSION,
		format: "native",
		entrypoint: ENTRYPOINT,
		options,
	};
}

// ── Card ────────────────────────────────────────────────────────────

/** Satori element: the plain-object form of a React element. */
export interface CardNode {
	type: string;
	props: { style?: Record<string, unknown>; children?: CardNode | string | Array<CardNode | string> };
}

function h(type: string, style: Record<string, unknown>, children?: CardNode["props"]["children"]): CardNode {
	return { type, props: { style, children } };
}

/** Title size steps down as the title grows, so long titles still fit three lines. */
export function titleSize(title: string): number {
	const length = [...title].length;
	if (length <= 18) return 76;
	if (length <= 32) return 64;
	if (length <= 48) return 56;
	return 48;
}

export interface CardContent {
	title: string;
	siteName: string;
	host: string;
}

export function buildCard({ title, siteName, host }: CardContent, theme: Required<OgImageTheme>): CardNode {
	const monogram = [...siteName.trim()][0]?.toUpperCase() ?? "";
	return h(
		"div",
		{
			display: "flex",
			width: "100%",
			height: "100%",
			padding: 40,
			backgroundColor: theme.background,
			fontFamily: "body",
		},
		h(
			"div",
			{
				display: "flex",
				flexDirection: "column",
				justifyContent: "space-between",
				flexGrow: 1,
				padding: "64px 72px 56px",
				backgroundColor: theme.surface,
				border: `1px solid ${theme.border}`,
				borderRadius: 28,
				boxShadow: "0 1px 2px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.04)",
			},
			[
				h(
					"div",
					{
						display: "block",
						color: theme.text,
						fontSize: titleSize(title),
						fontWeight: 700,
						lineHeight: 1.35,
						letterSpacing: "-0.01em",
						lineClamp: 3,
					},
					title,
				),
				h("div", { display: "flex", alignItems: "center", justifyContent: "space-between" }, [
					// No site name: leave the left side empty rather than draw a blank monogram.
					h("div", { display: "flex", alignItems: "center" }, monogram ? [
						h(
							"div",
							{
								display: "flex",
								alignItems: "center",
								justifyContent: "center",
								width: 56,
								height: 56,
								marginRight: 20,
								borderRadius: 14,
								backgroundColor: theme.brand,
								color: theme.onBrand,
								fontSize: 30,
								fontWeight: 700,
							},
							monogram,
						),
						h("div", { display: "flex", color: theme.text, fontSize: 32, fontWeight: 700 }, siteName),
					] : []),
					h(
						"div",
						{ display: "flex", color: theme.muted, fontSize: 24, fontFamily: "mono", letterSpacing: "0.04em" },
						host,
					),
				]),
			],
		),
	);
}

// ── Fonts ───────────────────────────────────────────────────────────

type HttpFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Characters a font has to cover: deduplicated, so the subset URL stays short. */
export function glyphs(...texts: string[]): string {
	return [...new Set([...texts.join("")])].filter((c) => c.trim() !== "").join("");
}

/**
 * Fetch one Google Fonts weight subset to `text`. Without a modern browser
 * User-Agent the CSS API serves TrueType, which Satori reads (it cannot read WOFF2).
 */
async function loadGoogleFont(fetcher: HttpFetch, family: string, weight: number, text: string): Promise<ArrayBuffer> {
	const params = new URLSearchParams({ family: `${family}:wght@${weight}`, text });
	const css = await fetcher(`https://fonts.googleapis.com/css2?${params}`);
	if (!css.ok) throw new Error(`Google Fonts CSS ${css.status} for ${family} ${weight}`);
	const match = (await css.text()).match(/src:\s*url\(([^)]+)\)\s*format\('(?:truetype|opentype)'\)/);
	if (!match?.[1]) throw new Error(`No TrueType source for ${family} ${weight}`);
	const font = await fetcher(match[1]);
	if (!font.ok) throw new Error(`Google Fonts file ${font.status} for ${family} ${weight}`);
	return font.arrayBuffer();
}

// ── Helpers ─────────────────────────────────────────────────────────

/** FNV-1a, 32-bit: a short cache-busting token, not a security measure. */
export function hash(value: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < value.length; i++) {
		h ^= value.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(36);
}

function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return "";
	}
}

/**
 * Site-relative path of the generated image for an entry, for templates that
 * show it in place of a missing featured image. `id` is the database id (ULID),
 * `title` only feeds the cache-busting `v` token; the route reads the title itself.
 */
export function ogImagePath(collection: string, id: string, title: string): string {
	const params = new URLSearchParams({ collection, id, v: hash(`${title}\n${PLUGIN_VERSION}`) });
	return `/_emdash/api/plugins/${PLUGIN_ID}/${ROUTE}?${params}`;
}

/** The contributions for a page, or null when the page has its own image or is out of scope. */
export function metadataFor(page: PublicPageContext, collections: string[]): PageMetadataContribution[] | null {
	if (page.kind !== "content" || !page.content) return null;
	if (!collections.includes(page.content.collection)) return null;
	if (page.seo?.ogImage || page.image) return null;

	const origin = (page.siteUrl && URL.canParse(page.siteUrl) ? new URL(page.siteUrl) : new URL(page.url)).origin;
	const title = page.seo?.ogTitle ?? page.pageTitle ?? page.title ?? "";
	const url = `${origin}${ogImagePath(page.content.collection, page.content.id, title)}`;
	return [
		{ kind: "property", property: "og:image", content: url },
		{ kind: "property", property: "og:image:width", content: String(WIDTH) },
		{ kind: "property", property: "og:image:height", content: String(HEIGHT) },
		{ kind: "property", property: "og:image:type", content: "image/png" },
		...(title ? [{ kind: "property", property: "og:image:alt", content: title } as const] : []),
		{ kind: "meta", name: "twitter:card", content: "summary_large_image" },
		{ kind: "meta", name: "twitter:image", content: url },
	];
}

function textResponse(status: number, message: string) {
	return pluginResponse({
		status,
		headers: { "Content-Type": "text/plain; charset=utf-8" },
		body: { kind: "text", value: message },
	});
}

function pngResponse(bytes: Uint8Array) {
	return pluginResponse({
		headers: { "Content-Type": "image/png" },
		body: { kind: "bytes", value: bytes },
	});
}

interface EdgeCache {
	match(request: Request | string): Promise<Response | undefined>;
	put(request: Request | string, response: Response): Promise<void>;
}

/** `caches.default` on Cloudflare Workers; absent elsewhere (Node dev, tests). */
function edgeCache(): EdgeCache | null {
	const store = (globalThis as { caches?: { default?: EdgeCache } }).caches;
	return store?.default ?? null;
}

async function renderPng(card: CardNode, fonts: Array<{ name: string; data: ArrayBuffer; weight: 400 | 500 | 700 }>): Promise<Uint8Array<ArrayBuffer>> {
	// Loaded on first request only: the module instantiates Satori and resvg (WebAssembly).
	const og = await import("@cf-wasm/og");
	const result = og.render(card as never, {
		width: WIDTH,
		height: HEIGHT,
		fonts: fonts.map((font) => ({ name: font.name, data: font.data, weight: font.weight, style: "normal" as const })),
	});
	const png = await result.asPng();
	return new Uint8Array(png.image);
}

// ── Plugin ──────────────────────────────────────────────────────────

export function createPlugin(options: OgImageOptions = {}) {
	const collections = options.collections?.length ? options.collections : ["posts"];
	const titleField = options.titleField ?? "title";
	const fontFamily = options.fontFamily ?? "Noto Sans JP";
	const monoFontFamily = options.monoFontFamily ?? "JetBrains Mono";
	const theme = { ...DEFAULT_THEME, ...options.theme };

	const siteNameOf = (ctx: PluginContext) => options.siteName ?? ctx.site.name ?? "";

	return definePlugin({
		id: PLUGIN_ID,
		version: PLUGIN_VERSION,
		capabilities: ["content:read", "network:request"],
		allowedHosts: FONT_HOSTS,
		hooks: {
			"page:metadata": async (event) => metadataFor(event.page, collections),
		},
		routes: {
			[ROUTE]: {
				public: true,
				methods: ["GET", "HEAD"],
				request: { body: "none" },
				response: "raw",
				cacheControl: CACHE_CONTROL,
				handler: async (ctx: RouteContext) => {
					const query = (ctx.input ?? {}) as Record<string, unknown>;
					const collection = typeof query.collection === "string" ? query.collection : "";
					const id = typeof query.id === "string" ? query.id : "";
					if (!collections.includes(collection) || !id || id.length > 100) return textResponse(404, "Not found");

					const cache = edgeCache();
					const cacheKey = new URL(ctx.request.url).toString();
					const cached = await cache?.match(cacheKey).catch(() => undefined);
					if (cached?.ok) return pngResponse(new Uint8Array(await cached.arrayBuffer()));

					const entry = await ctx.content?.get(collection, id);
					// Drafts and scheduled entries stay private: their titles are not public yet.
					if (!entry || entry.status !== "published") return textResponse(404, "Not found");

					const fieldTitle = entry.data[titleField];
					const title = (entry.seo?.title || (typeof fieldTitle === "string" ? fieldTitle : "") || entry.slug || "").trim();
					const siteName = siteNameOf(ctx);
					const host = hostOf(ctx.site.url) || hostOf(ctx.request.url);

					if (!ctx.http) return textResponse(500, "Network access is not available");
					const fetcher: HttpFetch = (url, init) => ctx.http!.fetch(url, init);
					const bodyText = glyphs(title, siteName, [...siteName.trim()][0]?.toUpperCase() ?? "");
					let fonts: Array<{ name: string; data: ArrayBuffer; weight: 400 | 500 | 700 }>;
					try {
						const [bold, mono] = await Promise.all([
							loadGoogleFont(fetcher, fontFamily, 700, bodyText),
							host ? loadGoogleFont(fetcher, monoFontFamily, 500, glyphs(host)) : Promise.resolve(null),
						]);
						fonts = [{ name: "body", data: bold, weight: 700 }];
						if (mono) fonts.push({ name: "mono", data: mono, weight: 500 });
					} catch (error) {
						ctx.log.warn("Font load failed", { error: error instanceof Error ? error.message : String(error) });
						return textResponse(503, "Font unavailable");
					}

					const png = await renderPng(buildCard({ title, siteName, host }, theme), fonts);
					await cache
						?.put(cacheKey, new Response(png, { headers: { "Content-Type": "image/png", "Cache-Control": CACHE_CONTROL } }))
						.catch(() => undefined);
					return pngResponse(png);
				},
			},
		},
	});
}

export default createPlugin;
