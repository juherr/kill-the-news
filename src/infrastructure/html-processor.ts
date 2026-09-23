import { parseHTML } from "linkedom";
import escapeHtml from "escape-html";
import type { AttachmentData } from "../types";

type ParsedDocument = ReturnType<typeof parseHTML>["document"];

// Strip surrounding angle brackets and whitespace from a Content-ID so that a
// stored value like "<ii_mpi85rqy0>" matches an HTML reference "cid:ii_mpi85rqy0".
export function normalizeCid(
  cid: string | null | undefined,
): string | undefined {
  if (!cid) return undefined;
  const trimmed = cid.trim().replace(/^<|>$/g, "").trim();
  return trimmed || undefined;
}

// Collect the normalized Content-IDs referenced by `cid:` image sources in the
// email body — exactly the set rewriteCidSrc would turn into inline <img> URLs.
// Used at ingest to flag those attachments as inline (rendered in place, hidden
// from the downloadable attachment lists).
export function extractInlineCids(content: string): Set<string> {
  const cids = new Set<string>();
  if (!content || isPlainText(content)) return cids;
  const { document } = parseHTML(content);
  document.querySelectorAll("[src]").forEach((el: Element) => {
    const match = (el.getAttribute("src") ?? "").match(/^\s*cid:(.+)$/i);
    const cid = match ? normalizeCid(match[1]) : undefined;
    if (cid) cids.add(cid);
  });
  return cids;
}

// Render an HTML fragment (or already-plain string) down to plain text: strips
// tags and decodes entities. Used for feed <title>s, which must be plain text —
// raw markup/entities show literally in readers.
export function htmlToText(value: string): string {
  if (!value) return "";
  const { document } = parseHTML(`<body>${value}</body>`);
  return (document.documentElement?.textContent ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

// Collect the links from an email body for confirmation detection: anchor href +
// visible text from HTML, or a regex URL sweep for plain-text bodies. Infra owns
// the DOM parse; the domain detector receives plain tuples.
export function extractLinks(
  content: string,
): { href: string; text: string }[] {
  if (!content) return [];

  if (isPlainText(content)) {
    const urls = content.match(/https?:\/\/[^\s<>"')]+/gi) ?? [];
    return urls.map((url) => ({ href: url, text: url }));
  }

  const { document } = parseHTML(content);
  const links: { href: string; text: string }[] = [];
  document.querySelectorAll("a[href]").forEach((el: Element) => {
    const href = (el.getAttribute("href") ?? "").trim();
    if (!href) return;
    links.push({
      href,
      text: ((el as unknown as { textContent?: string }).textContent ?? "")
        .replace(/\s+/g, " ")
        .trim(),
    });
  });
  return links;
}

// Collect a newsletter's self-advertised feed declarations from
// <link rel="alternate" type="…"> tags. Returns raw href+type tuples; the
// domain decides which MIME types count as a feed. Relative hrefs are
// absolutized against the sender base (best-effort); only http(s) URLs survive.
// Plain-text bodies have no <link> → [].
export function extractFeedLinks(
  content: string,
  base = "",
): { href: string; type: string }[] {
  if (!content || isPlainText(content)) return [];

  const { document } = parseHTML(content);
  const links: { href: string; type: string }[] = [];
  document
    .querySelectorAll('link[rel~="alternate"][type]')
    .forEach((el: Element) => {
      const type = (el.getAttribute("type") ?? "").trim();
      const rawHref = (el.getAttribute("href") ?? "").trim();
      if (!type || !rawHref) return;
      // toAbsolute() skips already-absolute hrefs (returns null), so keep those as-is.
      const href = /^https?:\/\//i.test(rawHref)
        ? rawHref
        : (toAbsolute(rawHref, base) ?? "");
      if (!/^https?:\/\//i.test(href)) return;
      links.push({ href, type });
    });
  return links;
}

// Newsletters frequently defer images via data-src/loading="lazy"; readers don't
// run the lazy-loader, so the image renders blank. Promote the real source.
function promoteLazyImages(document: ParsedDocument): void {
  document.querySelectorAll("img").forEach((img: Element) => {
    const lazySrc =
      img.getAttribute("data-src") ||
      img.getAttribute("data-original") ||
      img.getAttribute("data-lazy-src");
    if (lazySrc) {
      const current = (img.getAttribute("src") ?? "").trim();
      if (!current || /^data:/i.test(current)) {
        img.setAttribute("src", lazySrc);
      }
    }
    const lazySrcset = img.getAttribute("data-srcset");
    if (lazySrcset && !img.getAttribute("srcset")) {
      img.setAttribute("srcset", lazySrcset);
    }
    img.removeAttribute("loading");
  });
}

// Resolve a single URL against the sender base. Returns null for values that are
// already absolute or should never be rewritten (mailto:, data:, cid:, anchors).
function toAbsolute(value: string, base: string): string | null {
  const v = value.trim();
  if (!v || /^(https?:|mailto:|tel:|data:|cid:|#)/i.test(v)) return null;
  try {
    return new URL(v, base).href;
  } catch {
    return null;
  }
}

// Most readers ignore xml:base, so relative href/src in content break. Absolutize
// them against the sender's site (best-effort, derived from its email domain).
// Protocol-relative //host/x are resolved too (they pick up the base's https:).
function absolutizeUrls(document: ParsedDocument, base: string): void {
  if (!base) return;
  document.querySelectorAll("a[href], area[href]").forEach((el: Element) => {
    const abs = toAbsolute(el.getAttribute("href") ?? "", base);
    if (abs) el.setAttribute("href", abs);
  });
  document.querySelectorAll("img[src]").forEach((el: Element) => {
    const abs = toAbsolute(el.getAttribute("src") ?? "", base);
    if (abs) el.setAttribute("src", abs);
  });
}

function cleanMsoStyles(style: string): string {
  return style
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p && !/^mso-/i.test(p))
    .join("; ");
}

function isPlainText(content: string): boolean {
  return !/<[a-z][\s\S]*>/i.test(content);
}

// linkedom escapes `&` in text nodes but not in attribute values, so a URL like
// `?a=1&b=2` serializes with bare ampersands. That's valid XML inside the feed's
// CDATA, but the W3C feed validator parses the embedded HTML and warns
// ("Named entity expected. Got none."). Escape every `&` that doesn't already
// start a valid entity (named, decimal, or hex) — leaves `&amp;`/`&#39;` intact.
function escapeBareAmpersands(html: string): string {
  return html.replace(
    /&(?!(?:[a-zA-Z][a-zA-Z0-9]*|#\d+|#x[0-9a-fA-F]+);)/g,
    "&amp;",
  );
}

function rewriteCidSrc(
  el: Element,
  cidMap: Map<string, AttachmentData>,
  baseUrl: string,
): void {
  const src = el.getAttribute("src") ?? "";
  const match = src.match(/^\s*cid:(.+)$/i);
  if (!match) return;
  const attachment = cidMap.get(normalizeCid(match[1]) ?? "");
  if (!attachment) return;
  el.setAttribute(
    "src",
    `${baseUrl}/files/${attachment.id}/${encodeURIComponent(attachment.filename)}`,
  );
}

function sanitizeElement(el: Element): void {
  // Snapshot attribute names before mutating (linkedom attributes is array-like)
  const attrs = Array.from(
    el.attributes as unknown as ArrayLike<{ name: string }>,
  ).map((a) => a.name);
  for (const attr of attrs) {
    // Remove event handlers (onclick, onerror, onload, …)
    if (/^on/i.test(attr)) {
      el.removeAttribute(attr);
      continue;
    }
    // Remove javascript: URLs
    if (["href", "src", "action"].includes(attr.toLowerCase())) {
      const val = el.getAttribute(attr) ?? "";
      if (/^\s*javascript:/i.test(val)) {
        el.removeAttribute(attr);
        continue;
      }
    }
  }
  // Strip mso-* inline style properties (Office HTML noise)
  const style = el.getAttribute("style");
  if (style !== null) {
    const cleaned = cleanMsoStyles(style);
    if (cleaned) {
      el.setAttribute("style", cleaned);
    } else {
      el.removeAttribute("style");
    }
  }
}

/**
 * Processes email content for safe display in feeds and entry pages:
 * - Detects plain text and wraps it in a <pre> block
 * - Extracts the <body> fragment from full HTML documents
 * - Removes dangerous elements: <script>, <iframe>, <object>, <embed>
 * - Removes event handler attributes and javascript: URLs
 * - Strips mso-* inline style properties (Office HTML)
 * - Rewrites inline cid: image refs to the stored attachment URL. baseUrl=""
 *   yields relative URLs (entry page, same origin); a baseUrl yields absolute
 *   URLs (feeds, for external RSS readers).
 * - Promotes lazy-loaded images (data-src → src, strips loading="lazy").
 * - Absolutizes relative href/src against senderBaseUrl (the sender's site,
 *   best-effort) so links/images don't break in readers that ignore xml:base.
 */
export function processEmailContent(
  content: string,
  attachments?: AttachmentData[],
  baseUrl = "",
  senderBaseUrl = "",
): string {
  if (!content) return "";

  if (isPlainText(content)) {
    return `<pre style="white-space: pre-wrap; word-break: break-word;">${escapeHtml(content)}</pre>`;
  }

  const cidMap = new Map<string, AttachmentData>();
  for (const att of attachments ?? []) {
    const cid = normalizeCid(att.contentId);
    if (cid) cidMap.set(cid, att);
  }

  // Drop the closing </body> and </html> tags. Some senders (Sendy/GrapesJS) close
  // an empty document and put the whole newsletter after </html>; HTML5 parsers
  // move that trailing content back into <body>, linkedom does not. Without the
  // closing tags linkedom nests it into <body> as well.
  const { document } = parseHTML(content.replace(/<\/(?:body|html)\s*>/gi, ""));

  document
    .querySelectorAll("script, object, embed, iframe, frame, frameset")
    .forEach((el: Element) => el.remove());

  document.querySelectorAll("*").forEach((el: Element) => sanitizeElement(el));

  promoteLazyImages(document);
  // Absolutize first: cid: refs are skipped here (not http(s)), then rewritten
  // below to our /files/ URL — which must NOT be absolutized to the sender.
  absolutizeUrls(document, senderBaseUrl);

  if (cidMap.size > 0) {
    document
      .querySelectorAll("[src]")
      .forEach((el: Element) => rewriteCidSrc(el, cidMap, baseUrl));
  }

  // Full documents expose a <body>; bodyless fragments are serialized directly
  // so that sanitization and cid rewriting still apply to their nodes.
  const body = document.querySelector("body");
  return escapeBareAmpersands(body ? body.innerHTML : document.toString());
}
