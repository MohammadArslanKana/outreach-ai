import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RouteLoading } from "./brand-loader";

const html = renderToStaticMarkup(createElement(RouteLoading));
const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
const spinner = html.match(/<span [^>]*class="([^"]+)"/)?.[1] ?? "";

describe("RouteLoading", () => {
  it("renders a circular spinner with one contrasting rotating segment", () => {
    expect(spinner).toMatch(/\brounded-full\b/);
    expect(spinner).toMatch(/\bborder-\[3px\]/);
    expect(spinner).toMatch(/\bborder-t-primary\b/);
    expect(spinner).toMatch(/\banimate-spin\b/);
  });

  it("no longer renders the Polimatiq logo, tile or reveal mask", () => {
    expect(html).not.toMatch(/<svg|<image|<img|<mask|icon\.svg/);
    expect(html).not.toMatch(/bg-foreground|brand-/);
    expect(css).not.toMatch(/brand-draw|brand-settle/);
  });

  it("uses theme tokens only, so it adapts to light and dark", () => {
    expect(spinner).toMatch(/\bborder-muted-foreground\/25\b/);
    expect(html).not.toMatch(/#[0-9a-f]{3,6}\b|rgb\(|hsl\(/i);
    expect(html).not.toContain("dark:");
  });

  it("stops rotating under prefers-reduced-motion", () => {
    expect(spinner).toMatch(/\bmotion-reduce:animate-none\b/);
  });

  it("shows no visible text and announces a single loading status", () => {
    expect(html).toMatch(/^<div\b[^>]*role="status"[^>]*>/);
    expect(html.match(/role="status"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Loading"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toMatch(/<span aria-hidden="true"/);
    expect(html).toMatch(/<span aria-hidden="true"[^>]*><\/span><\/div>$/);
  });

  it("centres the spinner in a box the exact height of the content area", () => {
    expect(html).toContain("grid");
    expect(html).toContain("place-items-center");
    expect(html).toContain("min-h-[calc(100svh-4rem-2rem)]");
    expect(html).toContain("sm:min-h-[calc(100svh-4rem-3rem)]");
    expect(html).toContain("lg:min-h-[calc(100svh-4rem-4rem)]");
  });
});
