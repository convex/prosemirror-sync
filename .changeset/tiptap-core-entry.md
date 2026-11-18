---
"@convex-dev/prosemirror-sync": minor
---

Add `@convex-dev/prosemirror-sync/tiptap/core`: `syncExtension` without React,
for Tiptap apps on other frameworks. It takes a `ConvexClient` from
`convex/browser`. React is now an optional peer, and `@tiptap/pm`, which the
extension imports, is a declared one.
