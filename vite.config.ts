import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import { build } from "esbuild";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// The pages search engines should find, with what results and link previews show for them.
const publicPages = [
  {
    path: "/",
    file: "index.html",
    title: "Margin: a private notes app that works offline",
    description:
      "A quiet place for your notes. Private by default, works offline, syncs only if you want. Linked pages, daily notes, Obsidian import. Free and open source.",
  },
  {
    path: "/agents",
    file: "agents.html",
    title: "Use your notes with AI agents (MCP) · Margin",
    description:
      "Connect Claude or any app that supports MCP (Model Context Protocol) to Margin, and ask it to find, read and write your notes.",
  },
  {
    path: "/privacy",
    file: "privacy.html",
    title: "Privacy policy · Margin",
    description:
      "What Margin collects, why, and what you can do about it. Without an account, your notes never leave your device.",
  },
];

type PublicPage = (typeof publicPages)[number];

const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * Builds the public pages into the HTML the site serves (rendered by src/prerender.tsx), so search
 * engines, link previews and first visits get them without waiting for the app. Each has its own
 * title, description and link preview. robots.txt and the sitemap point at VITE_SITE_URL.
 */
function publicPagesPlugin(): Plugin {
  let env: Record<string, string> = {};
  let root = "";
  return {
    name: "margin:public-pages",
    apply: (_, { command, isPreview }) => command === "build" || !!isPreview,
    enforce: "post",
    configResolved(config) {
      env = config.env;
      root = config.root;
    },
    // `vite preview` serves them at their addresses, as vercel.json does.
    configurePreviewServer(server) {
      server.middlewares.use((req, _res, next) => {
        const page = publicPages.find((p) => p.path !== "/" && req.url?.split("?")[0] === p.path);
        if (page) req.url = req.url!.replace(page.path, `/${page.file}`);
        next();
      });
    },
    async generateBundle(_, bundle) {
      const shell = bundle["index.html"];
      if (shell?.type !== "asset") return;
      const site = env.VITE_SITE_URL?.replace(/\/+$/, "");
      if (!site) return this.warn("VITE_SITE_URL isn't set, so the public pages aren't pre-rendered");
      const render = await loadRenderer(root, env);
      const template = String(shell.source);
      for (const page of publicPages) {
        const html = publicPageHtml(template, page, site, render(page.path));
        if (page.file === "index.html") shell.source = html;
        else this.emitFile({ type: "asset", fileName: page.file, source: html });
      }
      this.emitFile({ type: "asset", fileName: "robots.txt", source: `User-agent: *\nDisallow: /api/\n\nSitemap: ${site}/sitemap.xml\n` });
      const urls = publicPages.map((p) => `  <url><loc>${site}${p.path}</loc></url>`).join("\n");
      this.emitFile({
        type: "asset",
        fileName: "sitemap.xml",
        source: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
      });
    },
  };
}

// src/prerender.tsx bundled for Node, with the app's import.meta.env.
async function loadRenderer(root: string, env: Record<string, string>): Promise<(path: string) => string> {
  const outfile = resolve(root, "node_modules/.cache/prerender/render.mjs");
  await build({
    entryPoints: [resolve(root, "src/prerender.tsx")],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    jsx: "automatic",
    packages: "external",
    define: { "import.meta.env": JSON.stringify(env) },
    logLevel: "warning",
  });
  return (await import(`${pathToFileURL(outfile).href}?${Date.now()}`)).render;
}

function publicPageHtml(template: string, page: PublicPage, site: string, body: string): string {
  const url = site + page.path;
  const head = [
    `<link rel="canonical" href="${url}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="Margin" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta property="og:title" content="${attr(page.title)}" />`,
    `<meta property="og:description" content="${attr(page.description)}" />`,
    `<meta property="og:image" content="${site}/og.png" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:image:alt" content="Margin: a quiet place for your notes" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
  ];
  if (page.path === "/") {
    // The site's name in search results, and what Margin is.
    const data = {
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "WebSite", name: "Margin", url: `${site}/` },
        {
          "@type": "WebApplication",
          name: "Margin",
          url: `${site}/`,
          description: page.description,
          applicationCategory: "ProductivityApplication",
          operatingSystem: "Any",
          offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        },
      ],
    };
    head.push(`<script type="application/ld+json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`);
  }
  const swaps: [string | RegExp, string][] = [
    ['<html lang="en">', `<html lang="en" data-prerendered="${page.path}">`],
    [/<title>[^<]*<\/title>/, `<title>${attr(page.title)}</title>`],
    [/<meta name="description" content="[^"]*" \/>/, `<meta name="description" content="${attr(page.description)}" />`],
    ["</head>", `\n    ${head.join("\n    ")}\n  </head>`],
    ['<div id="root"></div>', `<div id="prerendered">${body}</div><div id="root"></div>`],
  ];
  return swaps.reduce((html, [from, to]) => {
    if (!html.match(from)) throw new Error(`index.html changed: ${from} not found`);
    return html.replace(from, () => to);
  }, template);
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "Margin",
        short_name: "Margin",
        description: "Private notes. Sync only if you want.",
        theme_color: "#FBFBFA",
        background_color: "#FBFBFA",
        display: "standalone",
        start_url: "/",
        scope: "/",
        icons: [
          { src: "pwa-192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512.png", sizes: "512x512", type: "image/png" },
          { src: "pwa-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        globIgnores: ["og.png"], // link previews only
        navigateFallback: "/index.html",
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
      },
    }),
    publicPagesPlugin(),
  ],
  server: { port: 5173 },
});
