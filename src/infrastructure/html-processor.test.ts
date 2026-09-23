import { describe, it, expect } from "vitest";
import {
  processEmailContent,
  extractInlineCids,
  htmlToText,
  extractLinks,
  extractFeedLinks,
} from "./html-processor";
import type { AttachmentData } from "../types";

describe("processEmailContent — body extraction", () => {
  it("extracts content inside <body> tags", () => {
    const html = "<html><head></head><body><p>Hello</p></body></html>";
    expect(processEmailContent(html)).toBe("<p>Hello</p>");
  });

  it("keeps content a sender placed after </html>", () => {
    // Sendy/GrapesJS shape: an empty document, then the whole newsletter.
    const html =
      '<html><head><title></title></head><body><meta charset="UTF-8"></body></html>' +
      "<p>Hello</p><ol><li>Item</li></ol>";
    const result = processEmailContent(html);
    expect(result).toContain("<p>Hello</p>");
    expect(result).toContain("<ol><li>Item</li></ol>");
  });

  it("handles body tag with attributes", () => {
    const html = '<html><body style="margin:0"><p>Hi</p></body></html>';
    expect(processEmailContent(html)).toBe("<p>Hi</p>");
  });

  it("returns fragment unchanged when no body tags present", () => {
    const fragment = "<p>Already a fragment</p>";
    expect(processEmailContent(fragment)).toBe("<p>Already a fragment</p>");
  });

  it("is case-insensitive for body tag matching", () => {
    const html = "<HTML><BODY><p>content</p></BODY></HTML>";
    expect(processEmailContent(html)).toBe("<p>content</p>");
  });
});

describe("processEmailContent — plain text", () => {
  it("wraps plain text in <pre>", () => {
    const text = "Hello world\nSecond line";
    const result = processEmailContent(text);
    expect(result).toMatch(/^<pre /);
    expect(result).toContain("Hello world\nSecond line");
  });

  it("escapes < and > in plain text", () => {
    const text = "Price < 10 & size > 5";
    const result = processEmailContent(text);
    expect(result).toContain("&lt;");
    expect(result).toContain("&gt;");
    expect(result).toContain("&amp;");
    expect(result).not.toContain("<10");
  });

  it("returns empty string for empty input", () => {
    expect(processEmailContent("")).toBe("");
  });
});

describe("processEmailContent — dangerous element removal", () => {
  it("removes <script> tags", () => {
    const html = "<body><p>Hello</p><script>alert('xss')</script></body>";
    const result = processEmailContent(html);
    expect(result).not.toContain("<script");
    expect(result).not.toContain("alert");
    expect(result).toContain("<p>Hello</p>");
  });

  it("removes <iframe> tags", () => {
    const html =
      "<body><iframe src='https://evil.com'></iframe><p>ok</p></body>";
    const result = processEmailContent(html);
    expect(result).not.toContain("<iframe");
    expect(result).toContain("<p>ok</p>");
  });

  it("removes <object> and <embed> tags", () => {
    const html = "<body><object></object><embed src='x'/><p>ok</p></body>";
    const result = processEmailContent(html);
    expect(result).not.toContain("<object");
    expect(result).not.toContain("<embed");
  });
});

describe("processEmailContent — attribute sanitization", () => {
  it("removes event handler attributes", () => {
    const html =
      "<body><a href='https://x.com' onclick='evil()'>link</a></body>";
    const result = processEmailContent(html);
    expect(result).not.toContain("onclick");
    expect(result).toContain('href="https://x.com"');
  });

  it("removes onerror on images", () => {
    const html = "<body><img src='x' onerror='evil()' /></body>";
    const result = processEmailContent(html);
    expect(result).not.toContain("onerror");
  });

  it("removes javascript: hrefs", () => {
    const html = "<body><a href='javascript:evil()'>click</a></body>";
    const result = processEmailContent(html);
    expect(result).not.toContain("javascript:");
  });

  it("preserves legitimate href and src attributes", () => {
    const html =
      "<body><a href='https://example.com'>link</a><img src='https://example.com/img.png'/></body>";
    const result = processEmailContent(html);
    expect(result).toContain("https://example.com");
  });

  it("escapes bare ampersands in attribute URLs (W3C feed-valid HTML)", () => {
    const html =
      '<body><a href="https://example.com/?a=1&b=2&utm_source=x">link</a></body>';
    const result = processEmailContent(html);
    expect(result).toContain(
      "https://example.com/?a=1&amp;b=2&amp;utm_source=x",
    );
    expect(result).not.toMatch(/&(?!amp;)/);
  });

  it("does not double-escape existing entities", () => {
    const html =
      '<body><p>Tom &amp; Jerry &#39; &lt;tag&gt;</p><a href="https://x.com/?q=a&amp;b">l</a></body>';
    const result = processEmailContent(html);
    expect(result).toContain("Tom &amp; Jerry");
    expect(result).not.toContain("&amp;amp;");
    expect(result).toContain("?q=a&amp;b");
  });
});

describe("processEmailContent — mso style cleanup", () => {
  it("strips mso-* properties from inline styles", () => {
    const html =
      '<body><p style="mso-margin-top: 0; color: red;">text</p></body>';
    const result = processEmailContent(html);
    expect(result).not.toContain("mso-margin-top");
    expect(result).toContain("color: red");
  });

  it("removes style attribute entirely when only mso properties remain", () => {
    const html =
      '<body><p style="mso-line-height-rule: exactly;">text</p></body>';
    const result = processEmailContent(html);
    expect(result).not.toContain("style=");
  });

  it("preserves style attribute when non-mso properties remain", () => {
    const html =
      '<body><p style="mso-font-size: 12pt; font-weight: bold;">text</p></body>';
    const result = processEmailContent(html);
    expect(result).toContain("font-weight");
    expect(result).not.toContain("mso-font-size");
  });
});

describe("processEmailContent — inline cid: rewriting", () => {
  const attachment = (
    overrides: Partial<AttachmentData> = {},
  ): AttachmentData => ({
    id: "att-123",
    filename: "chicken big.png",
    contentType: "image/png",
    size: 100,
    contentId: "ii_mpi85rqy0",
    ...overrides,
  });

  it("rewrites cid: src to a relative /files URL when no baseUrl", () => {
    const html = '<body><img src="cid:ii_mpi85rqy0" alt="x"/></body>';
    const result = processEmailContent(html, [attachment()]);
    expect(result).toContain('src="/files/att-123/chicken%20big.png"');
    expect(result).not.toContain("cid:");
  });

  it("rewrites cid: src to an absolute URL when baseUrl is given", () => {
    const html = '<body><img src="cid:ii_mpi85rqy0"/></body>';
    const result = processEmailContent(
      html,
      [attachment()],
      "https://feed.example",
    );
    expect(result).toContain(
      'src="https://feed.example/files/att-123/chicken%20big.png"',
    );
  });

  it("matches a stored Content-ID that has angle brackets", () => {
    const html = '<body><img src="cid:ii_mpi85rqy0"/></body>';
    const result = processEmailContent(html, [
      attachment({ contentId: "<ii_mpi85rqy0>" }),
    ]);
    expect(result).toContain('src="/files/att-123/chicken%20big.png"');
  });

  it("is case-insensitive on the cid: scheme", () => {
    const html = '<body><img src="CID:ii_mpi85rqy0"/></body>';
    const result = processEmailContent(html, [attachment()]);
    expect(result).toContain('src="/files/att-123/chicken%20big.png"');
  });

  it("leaves unknown cid references unchanged", () => {
    const html = '<body><img src="cid:unknown"/></body>';
    const result = processEmailContent(html, [attachment()]);
    expect(result).toContain('src="cid:unknown"');
  });

  it("leaves cid references unchanged when no attachments are provided", () => {
    const html = '<body><img src="cid:ii_mpi85rqy0"/></body>';
    const result = processEmailContent(html);
    expect(result).toContain('src="cid:ii_mpi85rqy0"');
  });

  it("ignores attachments without a contentId", () => {
    const html = '<body><img src="cid:ii_mpi85rqy0"/></body>';
    const result = processEmailContent(html, [
      attachment({ contentId: undefined }),
    ]);
    expect(result).toContain('src="cid:ii_mpi85rqy0"');
  });

  it("does not touch normal http image sources", () => {
    const html = '<body><img src="https://example.com/a.png"/></body>';
    const result = processEmailContent(html, [attachment()]);
    expect(result).toContain('src="https://example.com/a.png"');
  });
});

describe("processEmailContent — lazy image promotion", () => {
  it("promotes data-src to src when src is missing", () => {
    const html = '<body><img data-src="https://x.com/a.png"/></body>';
    const result = processEmailContent(html);
    expect(result).toContain('src="https://x.com/a.png"');
  });

  it("promotes data-src over a data: placeholder src", () => {
    const html =
      '<body><img src="data:image/gif;base64,AAAA" data-src="https://x.com/a.png"/></body>';
    const result = processEmailContent(html);
    expect(result).toContain('src="https://x.com/a.png"');
    expect(result).not.toContain("data:image/gif");
  });

  it("does not clobber a real src with data-src", () => {
    const html =
      '<body><img src="https://real.com/a.png" data-src="https://lazy.com/b.png"/></body>';
    const result = processEmailContent(html);
    expect(result).toContain('src="https://real.com/a.png"');
  });

  it("promotes data-srcset when srcset is absent", () => {
    const html = '<body><img data-srcset="https://x.com/a.png 2x"/></body>';
    const result = processEmailContent(html);
    expect(result).toContain('srcset="https://x.com/a.png 2x"');
  });

  it("strips loading=lazy", () => {
    const html = '<body><img src="https://x.com/a.png" loading="lazy"/></body>';
    const result = processEmailContent(html);
    expect(result).not.toContain("loading");
  });
});

describe("processEmailContent — relative URL absolutization", () => {
  const base = "https://news.example.com/";

  it("absolutizes a root-relative href against the sender base", () => {
    const html = '<body><a href="/path">link</a></body>';
    const result = processEmailContent(html, undefined, "", base);
    expect(result).toContain('href="https://news.example.com/path"');
  });

  it("absolutizes a relative img src against the sender base", () => {
    const html = '<body><img src="img/a.png"/></body>';
    const result = processEmailContent(html, undefined, "", base);
    expect(result).toContain('src="https://news.example.com/img/a.png"');
  });

  it("resolves protocol-relative URLs using https", () => {
    const html = '<body><img src="//cdn.example.com/a.png"/></body>';
    const result = processEmailContent(html, undefined, "", base);
    expect(result).toContain('src="https://cdn.example.com/a.png"');
  });

  it("leaves absolute URLs unchanged", () => {
    const html = '<body><a href="https://other.com/x">l</a></body>';
    const result = processEmailContent(html, undefined, "", base);
    expect(result).toContain('href="https://other.com/x"');
  });

  it("does not touch relative URLs when no sender base is given", () => {
    const html = '<body><a href="/path">link</a></body>';
    const result = processEmailContent(html);
    expect(result).toContain('href="/path"');
  });

  it("does not absolutize mailto: or anchors", () => {
    const html =
      '<body><a href="mailto:x@y.com">m</a><a href="#top">t</a></body>';
    const result = processEmailContent(html, undefined, "", base);
    expect(result).toContain('href="mailto:x@y.com"');
    expect(result).toContain('href="#top"');
  });
});

describe("htmlToText", () => {
  it("strips HTML tags", () => {
    expect(htmlToText("<b>Bold</b> text")).toBe("Bold text");
  });

  it("decodes HTML entities", () => {
    expect(htmlToText("Tom &amp; Jerry &lt;3")).toBe("Tom & Jerry <3");
  });

  it("collapses whitespace and trims", () => {
    expect(htmlToText("  a\n\n  b  ")).toBe("a b");
  });

  it("returns empty string for empty input", () => {
    expect(htmlToText("")).toBe("");
  });

  it("leaves plain text untouched", () => {
    expect(htmlToText("Just a subject")).toBe("Just a subject");
  });
});

describe("extractInlineCids", () => {
  it("collects normalized cids referenced by cid: image sources", () => {
    const html = '<body><img src="cid:ii_abc"/><img src="CID:ii_def"/></body>';
    expect(extractInlineCids(html)).toEqual(new Set(["ii_abc", "ii_def"]));
  });

  it("ignores non-cid sources", () => {
    const html = '<body><img src="https://example.com/a.png"/></body>';
    expect(extractInlineCids(html).size).toBe(0);
  });

  it("returns an empty set for plain text", () => {
    expect(extractInlineCids("just text, no html").size).toBe(0);
  });

  it("returns an empty set for empty input", () => {
    expect(extractInlineCids("").size).toBe(0);
  });
});

describe("extractLinks", () => {
  it("collects anchor href + text from HTML", () => {
    const links = extractLinks(
      '<p>hi <a href="https://x.example/confirm?t=1">Confirm</a> and <a href="https://x.example/home">Home</a></p>',
    );
    expect(links).toEqual([
      { href: "https://x.example/confirm?t=1", text: "Confirm" },
      { href: "https://x.example/home", text: "Home" },
    ]);
  });

  it("falls back to regex URL extraction for plain text", () => {
    const links = extractLinks(
      "Confirm here: https://x.example/verify/abc thanks",
    );
    expect(links).toEqual([
      {
        href: "https://x.example/verify/abc",
        text: "https://x.example/verify/abc",
      },
    ]);
  });

  it("returns an empty array for empty content", () => {
    expect(extractLinks("")).toEqual([]);
  });
});

describe("extractFeedLinks", () => {
  it("extracts rel=alternate links that carry a type", () => {
    const html = `<html><head>
      <link rel="alternate" type="application/rss+xml" href="https://blog.example.com/feed.xml">
      <link rel="alternate" type="application/atom+xml" href="https://blog.example.com/atom.xml">
    </head><body>hi</body></html>`;
    expect(extractFeedLinks(html)).toEqual([
      {
        href: "https://blog.example.com/feed.xml",
        type: "application/rss+xml",
      },
      {
        href: "https://blog.example.com/atom.xml",
        type: "application/atom+xml",
      },
    ]);
  });

  it("ignores non-alternate rels and links without a type", () => {
    const html = `<head>
      <link rel="stylesheet" type="text/css" href="https://x.com/a.css">
      <link rel="alternate" href="https://x.com/notype">
    </head>`;
    expect(extractFeedLinks(html)).toEqual([]);
  });

  it("absolutizes a relative href against the base", () => {
    const html = `<head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head>`;
    expect(extractFeedLinks(html, "https://blog.example.com")).toEqual([
      {
        href: "https://blog.example.com/feed.xml",
        type: "application/rss+xml",
      },
    ]);
  });

  it("drops a relative href when no base is given", () => {
    const html = `<head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head>`;
    expect(extractFeedLinks(html)).toEqual([]);
  });

  it("returns [] for plain-text bodies", () => {
    expect(extractFeedLinks("just text https://x.com/feed")).toEqual([]);
  });
});
