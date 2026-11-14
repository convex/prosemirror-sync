import { expect, test, vi } from "vitest";

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
