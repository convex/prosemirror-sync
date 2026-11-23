import { readFile } from "node:fs/promises";
import { expect, expectTypeOf, test, vi } from "vitest";
import type { ConvexClient } from "convex/browser";
import type { ConvexReactClient } from "convex/react";

// `@convex-dev/prosemirror-sync/tiptap/core` is for Tiptap apps on other
// frameworks, so it must load in an app that has no React.
vi.mock("react", () => {
  throw new Error("the entry imported react");
});
vi.mock("convex/react", () => {
  throw new Error("the entry imported convex/react");
});

test("the Tiptap extension loads without React", async () => {
  const { syncExtension } = await import("./core.js");
  expect(syncExtension).toBeTypeOf("function");
});

test("the Tiptap extension takes a ConvexClient as is", () => {
  type Client = Parameters<(typeof import("./core.js"))["syncExtension"]>[0];
  expectTypeOf<ConvexClient>().toExtend<Client>();
  // The React client has `watchQuery` where this one has `onUpdate`.
  expectTypeOf<ConvexReactClient>().not.toExtend<Client>();
});

test("package.json exports the entry and keeps React optional", async () => {
  const pkg = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  ) as Record<string, Record<string, unknown>>;
  // `src/tiptap/core.ts` builds to `dist/tiptap/core.js`.
  expect(pkg.exports["./tiptap/core"]).toEqual({
    types: "./dist/tiptap/core.d.ts",
    default: "./dist/tiptap/core.js",
  });
  expect(pkg.peerDependenciesMeta).toMatchObject({
    react: { optional: true },
    "react-dom": { optional: true },
  });
});
