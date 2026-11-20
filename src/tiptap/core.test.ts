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
