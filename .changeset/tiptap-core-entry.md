---
"@convex-dev/prosemirror-sync": minor
---

Add `@convex-dev/prosemirror-sync/tiptap/core`, which exports `syncExtension`
without React, so Tiptap apps on other frameworks can sync with it.
`@convex-dev/prosemirror-sync/tiptap` exports the same plus the React hooks.
`react` and `react-dom` are now optional peers, so those apps don't install
React.
