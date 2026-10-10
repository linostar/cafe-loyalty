import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The design system for the server's customer pages, which have no bundler: the same stylesheets, fonts and logo the
 * dashboard and counter import through Vite, read from this package's files (next to dist/ once built).
 */

const ownFile = (path: string): string => fileURLToPath(new URL(`../${path}`, import.meta.url));
const require = createRequire(import.meta.url);

/** This package's stylesheets, by name (src/<name>.css). */
export type Stylesheet = "tokens" | "base" | "customer";

/** The stylesheets joined in the order given, as one text to inline, without their comments. */
export function stylesheets(names: readonly Stylesheet[]): string {
  return names.map((name) => readFileSync(ownFile(`src/${name}.css`), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")).join("\n");
}

export interface SelfHostedFonts {
  /** The @font-face rules of fonts.css, their files under `urlPrefix`. */
  css: string;
  /** Every font file those rules name, by file name, to its path on disk. */
  files: ReadonlyMap<string, string>;
}

/**
 * The fonts of fonts.css (its @import list is the one source), with their file URLs moved under `urlPrefix` (such as
 * "/assets/fonts/") for a server to serve them. Throws if fonts.css names no font file, rather than serve pages that
 * silently fall back to the system font.
 */
export function selfHostedFonts(urlPrefix: string): SelfHostedFonts {
  const imports = [...readFileSync(ownFile("src/fonts.css"), "utf8").matchAll(/@import "([^"]+)";/g)].map((match) => match[1] ?? "");
  const files = new Map<string, string>();
  const css = imports
    .map((specifier) => {
      const path = require.resolve(specifier);
      return readFileSync(path, "utf8").replace(/url\(\.\/files\/([\w.-]+)\)/g, (_url, file: string) => {
        files.set(file, join(dirname(path), "files", file));
        return `url(${urlPrefix}${file})`;
      });
    })
    .join("\n");
  if (files.size === 0) {
    throw new Error(`No font files found in the @import list of ${ownFile("src/fonts.css")}.`);
  }
  return { css, files };
}

/**
 * A token's value from tokens.css (such as "color-espresso"), for what stylesheets cannot reach: a web app manifest,
 * a theme-color meta tag. Throws for a token that does not exist.
 */
export function tokenValue(name: string): string {
  const value = new RegExp(`--${name}:\\s*([^;]+);`).exec(readFileSync(ownFile("src/tokens.css"), "utf8"))?.[1];
  if (value === undefined) {
    throw new Error(`No token --${name} in tokens.css.`);
  }
  return value.trim();
}

/** The path of the logo mark (SVG), for favicons and headers. */
export const LOGO_SVG_PATH = ownFile("assets/logo.svg");
