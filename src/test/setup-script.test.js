import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "../..");
const directories = [];
const mainId = "11111111111111111111111111111111";
const previewId = "22222222222222222222222222222222";

// npm and Wrangler are external boundaries: never install or contact Cloudflare.
function runSetup(extraEnv = {}) {
  const directory = mkdtempSync(join(tmpdir(), "kill-the-news-setup-"));
  directories.push(directory);
  const bin = join(directory, "bin");
  mkdirSync(bin);
  copyFileSync(
    join(projectRoot, "wrangler-example.toml"),
    join(directory, "wrangler-example.toml"),
  );
  writeFileSync(
    join(directory, "namespaces.json"),
    extraEnv.SETUP_INITIAL_NAMESPACES ??
      JSON.stringify([
        { title: "another-worker", id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      ]),
  );
  writeFileSync(join(bin, "npm"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(
    join(bin, "npx"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const command = args.slice(0, 4).join(" ");
if (args.join(" ") === "wrangler whoami") process.exit(0);
if (command === "wrangler kv namespace create") {
  const title = args[4] + (args.includes("--preview") ? "_preview" : "");
  if (process.env.SETUP_CREATE_ERROR && title !== process.env.SETUP_CREATE_ALLOWED_TITLE) {
    console.error(process.env.SETUP_CREATE_ERROR);
    process.exit(1);
  }
  const namespaces = fs.existsSync("namespaces.json")
    ? JSON.parse(fs.readFileSync("namespaces.json", "utf8"))
    : [{ title: "another-worker", id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }];
  if (namespaces.some((namespace) => namespace.title === title)) {
    console.error("A KV namespace with this title already exists.");
    process.exit(1);
  }
  namespaces.unshift({ title, id: args.includes("--preview") ? "${previewId}" : "${mainId}" });
  fs.writeFileSync("namespaces.json", JSON.stringify(namespaces));
  process.exit(0);
}
if (args.slice(0, 4).join(" ") === "wrangler kv namespace list") {
  if (args.includes("--json")) {
    console.error("Unknown argument: json");
    process.exit(1);
  }
  if (process.env.SETUP_LIST_ERROR) {
    console.error(process.env.SETUP_LIST_ERROR);
    process.exit(1);
  }
  if (process.env.SETUP_SKILLS_NOTICE && process.env.CI !== "true") {
    console.log("Cloudflare agent skills are available for: Claude Code, Cursor, OpenCode, Codex.");
  }
  console.log(process.env.SETUP_LIST_OUTPUT ?? fs.readFileSync("namespaces.json", "utf8"));
  process.exit(0);
}
if (command === "wrangler secret put ADMIN_PASSWORD") {
  fs.readFileSync(0, "utf8");
  process.exit(0);
}
console.error("Unexpected Wrangler command:", args.join(" "));
process.exit(1);
`,
    { mode: 0o755 },
  );
  const result = spawnSync("bash", [join(projectRoot, "setup.sh")], {
    cwd: directory,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...extraEnv },
    input: "test-password\nnews.example.com\nn\n",
    encoding: "utf8",
    timeout: 10000,
  });
  return { ...result, directory };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("setup script", () => {
  it("generates config using the worker's namespaces, not their list order", () => {
    const result = runSetup();

    expect(result.error).toBeUndefined();
    expect(result.stdout + result.stderr).toContain("Setup complete!");
    expect(result.status).toBe(0);
    const config = readFileSync(
      join(result.directory, "wrangler.toml"),
      "utf8",
    );
    expect(config).toContain(`id = "${mainId}", preview_id = "${previewId}"`);
    expect(config).toContain('DOMAIN = "news.example.com"');
    expect(config).not.toContain("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("lists namespaces without Wrangler's non-interactive skills notice", () => {
    const result = runSetup({ CI: "", SETUP_SKILLS_NOTICE: "true" });

    expect(result.stdout + result.stderr).toContain("Setup complete!");
    expect(result.status).toBe(0);
  });

  it("reuses existing namespaces without requiring permission to create them", () => {
    const result = runSetup({
      SETUP_CREATE_ERROR: "Cloudflare API: permission denied",
      SETUP_INITIAL_NAMESPACES: JSON.stringify([
        { title: "unrelated", id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
        { title: "kill-the-news-EMAIL_STORAGE_preview", id: previewId },
        { title: "kill-the-news-EMAIL_STORAGE", id: mainId },
      ]),
    });

    expect(result.status).toBe(0);
    expect(
      readFileSync(join(result.directory, "wrangler.toml"), "utf8"),
    ).toContain(`id = "${mainId}", preview_id = "${previewId}"`);
  });

  it.each([
    [
      "kill-the-news-EMAIL_STORAGE",
      mainId,
      "kill-the-news-EMAIL_STORAGE_preview",
    ],
    [
      "kill-the-news-EMAIL_STORAGE_preview",
      previewId,
      "kill-the-news-EMAIL_STORAGE",
    ],
  ])(
    "reuses %s and creates only its missing counterpart",
    (title, id, missingTitle) => {
      const result = runSetup({
        SETUP_INITIAL_NAMESPACES: JSON.stringify([{ title, id }]),
        SETUP_CREATE_ERROR:
          "Cloudflare API: creation not allowed for this title",
        SETUP_CREATE_ALLOWED_TITLE: missingTitle,
      });

      expect(result.status).toBe(0);
      expect(
        readFileSync(join(result.directory, "wrangler.toml"), "utf8"),
      ).toContain(`id = "${mainId}", preview_id = "${previewId}"`);
    },
  );

  it("preserves Wrangler's listing error instead of blaming authentication", () => {
    const result = runSetup({
      SETUP_CREATE_ERROR: "Namespace creation must not be attempted",
      SETUP_LIST_ERROR: "Cloudflare API: service unavailable",
    });

    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain(
      "Cloudflare API: service unavailable",
    );
    expect(result.stdout).not.toContain(
      "Please check your Cloudflare authentication",
    );
    expect(result.stdout).not.toContain("Setting up admin password");
  });

  it("refuses to use unrelated namespaces when the expected names are missing", () => {
    const result = runSetup({
      SETUP_LIST_OUTPUT: JSON.stringify([
        { title: "another-worker", id: mainId },
        { title: "another-worker_preview", id: previewId },
      ]),
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Failed to extract KV namespace IDs");
    expect(result.stdout).not.toContain("Setting up admin password");
  });

  it.each(["not JSON", '{"unexpected":"object"}'])(
    "reports invalid namespace output: %s",
    (output) => {
      const result = runSetup({ SETUP_LIST_OUTPUT: output });

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(
        /invalid namespace JSON|Expected a JSON array/,
      );
      expect(result.stdout).not.toContain("Setting up admin password");
    },
  );

  it("reports the actual Wrangler error when namespace creation fails", () => {
    const result = runSetup({
      SETUP_CREATE_ERROR: "Cloudflare API: permission denied",
    });

    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain(
      "Cloudflare API: permission denied",
    );
    expect(result.stdout).not.toContain("Setting up admin password");
  });
});
