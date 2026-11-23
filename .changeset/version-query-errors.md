---
"@convex-dev/prosemirror-sync": patch
---

Report a failed `latestVersion` query through `onSyncError`, once per failed
result. Without `onSyncError` it surfaces as one unhandled rejection, where it
was one on every sync before.
