import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { defineConfig } from "vite-plus";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * Stamped into the build so the running app can say which one it is. Answering
 * "am I on the new version?" otherwise means diffing asset hashes by hand, and the
 * service worker is cache-first, so an old build lingering is entirely normal.
 */
function buildVersion(): string {
  const { version } = JSON.parse(readFileSync(here("./package.json"), "utf8")) as {
    version: string;
  };
  let commit = "local";
  try {
    commit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    // A build from a tarball has no git; the version alone still identifies it.
  }
  return `${version}+${commit}`;
}

/** Every file under public/, as paths relative to it. */
function listPublic(directory: string, prefix = ""): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = join(directory, entry);
    return statSync(full).isDirectory()
      ? listPublic(full, `${prefix}${entry}/`)
      : [`${prefix}${entry}`];
  });
}

/**
 * The service worker is written by hand rather than generated, because it is
 * deliberately cache-first: a card has to open at the till whatever the signal is
 * like. What it cannot track by hand is content-hashed filenames, or remember to
 * invalidate the previous cache — forgetting that shipped a stale app five times
 * before this build existed. Both are derived here from what was actually emitted.
 */
function serviceWorker(): Plugin {
  let base = "/";
  return {
    name: "super-app-service-worker",
    apply: "build",
    configResolved(config) {
      base = config.base;
    },
    generateBundle(_options, bundle) {
      const shell = [
        "./",
        ...Object.keys(bundle).map((name) => base + name),
        ...listPublic(here("./public")).map((name) => base + name),
        `${base}index.html`,
      ]
        .filter((value, index, all) => all.indexOf(value) === index)
        .sort();
      const version = createHash("sha256").update(shell.join("\n")).digest("hex").slice(0, 8);
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: readFileSync(here("./src/sw.js"), "utf8")
          .replace("__SHELL__", JSON.stringify(shell, null, 2))
          .replace("__VERSION__", version),
      });
    },
  };
}

type Config = Parameters<typeof defineConfig>[0];

/*
 * Vite 8's config type is deep enough that comparing this literal against it exceeds
 * the checker's stack (TS2321). The config itself is valid — the build and dev server
 * both run — so the diagnostic is suppressed rather than worked around. If a future
 * TypeScript copes with the depth, this line starts failing and can be deleted.
 */
// @ts-expect-error -- TS2321: excessive stack depth comparing against UserConfig
const config: Config = {
  // Everything else is left at its default. This is a GitHub Pages project site,
  // so the app is served from a sub-path rather than the domain root.
  base: "/super-app/",
  define: { __APP_VERSION__: JSON.stringify(buildVersion()) },
  lint: {
    options: { typeAware: true, typeCheck: true },
    // Every string spread here is over an ASCII barcode pattern — module strings,
    // width tables, Code 39 characters — where splitting into code points is exactly
    // what is wanted. The rule guards against breaking emoji, impossible in this data.
    rules: { "typescript/no-misused-spread": "off" },
  },
  plugins: [serviceWorker()],
};

export default defineConfig(config);
