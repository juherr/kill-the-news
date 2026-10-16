import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { http, HttpResponse } from "msw";
import { server, createMockEnv } from "../test/setup";
import { hubRouter } from "./hub";

function makeApp() {
  const app = new Hono();
  app.route("/hub", hubRouter);
  return app;
}

function hubBody(fields: Record<string, string>): Request {
  const body = new URLSearchParams(fields).toString();
  return new Request("http://localhost/hub", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
}

describe("POST /hub — input validation", () => {
  it("returns 400 when hub.mode is missing", async () => {
    const app = makeApp();
    const env = createMockEnv();
    const res = await app.request(
      "/hub",
      hubBody({
        "hub.topic": `https://${env.DOMAIN}/rss/feed1`,
        "hub.callback": "https://cb.example/sub",
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when hub.topic is missing", async () => {
    const app = makeApp();
    const env = createMockEnv();
    const res = await app.request(
      "/hub",
      hubBody({
        "hub.mode": "subscribe",
        "hub.callback": "https://cb.example/sub",
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when hub.callback is missing", async () => {
    const app = makeApp();
    const env = createMockEnv();
    const res = await app.request(
      "/hub",
      hubBody({
        "hub.mode": "subscribe",
        "hub.topic": `https://${env.DOMAIN}/rss/feed1`,
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for unknown hub.mode", async () => {
    const app = makeApp();
    const env = createMockEnv();
    const res = await app.request(
      "/hub",
      hubBody({
        "hub.mode": "ping",
        "hub.topic": `https://${env.DOMAIN}/rss/feed1`,
        "hub.callback": "https://cb.example/sub",
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when hub.callback is not HTTPS", async () => {
    const app = makeApp();
    const env = createMockEnv();
    const res = await app.request(
      "/hub",
      hubBody({
        "hub.mode": "subscribe",
        "hub.topic": `https://${env.DOMAIN}/rss/feed1`,
        "hub.callback": "http://cb.example/sub",
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("HTTPS");
  });

  it("returns 400 when hub.callback is not a valid URL", async () => {
    const app = makeApp();
    const env = createMockEnv();
    const res = await app.request(
      "/hub",
      hubBody({
        "hub.mode": "subscribe",
        "hub.topic": `https://${env.DOMAIN}/rss/feed1`,
        "hub.callback": "not-a-url",
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when hub.topic does not match this hub's domain", async () => {
    const app = makeApp();
    const env = createMockEnv();
    const res = await app.request(
      "/hub",
      hubBody({
        "hub.mode": "subscribe",
        "hub.topic": "https://other.example/rss/feed1",
        "hub.callback": "https://cb.example/sub",
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when hub.topic uses an unsupported path (not rss or atom)", async () => {
    const app = makeApp();
    const env = createMockEnv();
    const res = await app.request(
      "/hub",
      hubBody({
        "hub.mode": "subscribe",
        "hub.topic": `https://${env.DOMAIN}/feed/feed1`,
        "hub.callback": "https://cb.example/sub",
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it.each(["hub.secret", "hub.lease_seconds"])(
    "returns 400 when %s is a file rather than text",
    async (field) => {
      const app = makeApp();
      const env = createMockEnv();
      await env.EMAIL_STORAGE.put(
        "feed:feed1:config",
        JSON.stringify({ title: "Feed 1" }),
      );
      const form = new FormData();
      form.set("hub.mode", "subscribe");
      form.set("hub.topic", `https://${env.DOMAIN}/rss/feed1`);
      form.set("hub.callback", "https://cb.example/sub");
      form.set(field, new Blob(["not text"]), "value.txt");

      const res = await app.request(
        "/hub",
        { method: "POST", body: form },
        env,
      );

      expect(res.status).toBe(400);
      expect(await res.text()).toContain("unexpected field types");
    },
  );

  it("returns 400 when hub.secret exceeds 200 bytes", async () => {
    const app = makeApp();
    const env = createMockEnv();
    await env.EMAIL_STORAGE.put(
      "feed:feed1:config",
      JSON.stringify({ title: "Feed 1" }),
    );
    const res = await app.request(
      "/hub",
      hubBody({
        "hub.mode": "subscribe",
        "hub.topic": `https://${env.DOMAIN}/rss/feed1`,
        "hub.callback": "https://cb.example/sub",
        "hub.secret": "x".repeat(201),
      }),
      env,
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /hub — subscribe", () => {
  it("returns 202 for valid subscribe request", async () => {
    const app = makeApp();
    const env = createMockEnv();
    await env.EMAIL_STORAGE.put(
      "feed:feed1:config",
      JSON.stringify({ title: "Feed 1" }),
    );
    server.use(
      http.get("https://cb.example/sub", ({ request }) => {
        const challenge =
          new URL(request.url).searchParams.get("hub.challenge") ?? "";
        return HttpResponse.text(challenge);
      }),
    );
    const res = await app.request(
      "/hub",
      hubBody({
        "hub.mode": "subscribe",
        "hub.topic": `https://${env.DOMAIN}/rss/feed1`,
        "hub.callback": "https://cb.example/sub",
      }),
      env,
    );
    expect(res.status).toBe(202);
  });

  it("accepts hub.lease_seconds within range", async () => {
    const app = makeApp();
    const env = createMockEnv();
    await env.EMAIL_STORAGE.put(
      "feed:feed1:config",
      JSON.stringify({ title: "Feed 1" }),
    );
    server.use(
      http.get("https://cb.example/sub", ({ request }) => {
        const challenge =
          new URL(request.url).searchParams.get("hub.challenge") ?? "";
        return HttpResponse.text(challenge);
      }),
    );
    const res = await app.request(
      "/hub",
      hubBody({
        "hub.mode": "subscribe",
        "hub.topic": `https://${env.DOMAIN}/rss/feed1`,
        "hub.callback": "https://cb.example/sub",
        "hub.lease_seconds": "3600",
      }),
      env,
    );
    expect(res.status).toBe(202);
  });

  it("returns 404 when feed does not exist", async () => {
    const app = makeApp();
    const env = createMockEnv();
    const res = await app.request(
      "/hub",
      hubBody({
        "hub.mode": "subscribe",
        "hub.topic": `https://${env.DOMAIN}/rss/nonexistent`,
        "hub.callback": "https://cb.example/sub",
      }),
      env,
    );
    expect(res.status).toBe(404);
  });

  it("returns 202 for valid Atom subscribe request", async () => {
    const app = makeApp();
    const env = createMockEnv();
    await env.EMAIL_STORAGE.put(
      "feed:feed1:config",
      JSON.stringify({ title: "Feed 1" }),
    );
    server.use(
      http.get("https://cb.example/sub", ({ request }) => {
        const challenge =
          new URL(request.url).searchParams.get("hub.challenge") ?? "";
        return HttpResponse.text(challenge);
      }),
    );
    const res = await app.request(
      "/hub",
      hubBody({
        "hub.mode": "subscribe",
        "hub.topic": `https://${env.DOMAIN}/atom/feed1`,
        "hub.callback": "https://cb.example/sub",
      }),
      env,
    );
    expect(res.status).toBe(202);
  });

  it("returns 404 for Atom topic when feed does not exist", async () => {
    const app = makeApp();
    const env = createMockEnv();
    const res = await app.request(
      "/hub",
      hubBody({
        "hub.mode": "subscribe",
        "hub.topic": `https://${env.DOMAIN}/atom/nonexistent`,
        "hub.callback": "https://cb.example/sub",
      }),
      env,
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /hub — unsubscribe", () => {
  it("returns 202 for valid RSS unsubscribe request", async () => {
    const app = makeApp();
    const env = createMockEnv();
    await env.EMAIL_STORAGE.put(
      "feed:feed1:config",
      JSON.stringify({ title: "Feed 1" }),
    );
    server.use(
      http.get("https://cb.example/sub", ({ request }) => {
        const challenge =
          new URL(request.url).searchParams.get("hub.challenge") ?? "";
        return HttpResponse.text(challenge);
      }),
    );
    const res = await app.request(
      "/hub",
      hubBody({
        "hub.mode": "unsubscribe",
        "hub.topic": `https://${env.DOMAIN}/rss/feed1`,
        "hub.callback": "https://cb.example/sub",
      }),
      env,
    );
    expect(res.status).toBe(202);
  });

  it("returns 202 for valid Atom unsubscribe request", async () => {
    const app = makeApp();
    const env = createMockEnv();
    await env.EMAIL_STORAGE.put(
      "feed:feed1:config",
      JSON.stringify({ title: "Feed 1" }),
    );
    server.use(
      http.get("https://cb.example/sub", ({ request }) => {
        const challenge =
          new URL(request.url).searchParams.get("hub.challenge") ?? "";
        return HttpResponse.text(challenge);
      }),
    );
    const res = await app.request(
      "/hub",
      hubBody({
        "hub.mode": "unsubscribe",
        "hub.topic": `https://${env.DOMAIN}/atom/feed1`,
        "hub.callback": "https://cb.example/sub",
      }),
      env,
    );
    expect(res.status).toBe(202);
  });
});
