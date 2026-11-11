# Changelog

## 0.2.8

### Patch Changes

- 009a381: Return the typed component API from the test registration helper.

## 0.2.7

- Guard pending step submission for editor destruction during server submission

## 0.2.6

- Fix three tiptap editor lifecycle bugs (thanks @kloudysky!):
  - React StrictMode's double-mount tore down the surviving editor's
    `latestVersion` subscription, so steps from other clients stopped arriving
    until the local user typed.
  - `doSync` didn't re-check its collab version after awaiting `getSteps`, so an
    interleaved apply could apply the same steps twice and push the local
    version past the server's. The next submit then wrote a delta with a version
    gap, which leaves the document unreadable for every client.
  - Destroying an editor dropped local steps that hadn't been confirmed yet —
    switching documents in a single-page app mid-round-trip, say. They're now
    flushed in the background, and the debounced snapshot timer is cleared once
    the last editor unmounts.
- `onSyncError` now also hears about background failures that previously had
  nowhere to go: the destroy-time step flush, and the debounced snapshot submit.
  Losing unsynced steps still surfaces (as an unhandled rejection) if you
  haven't passed a handler; a failed snapshot submit no longer does, since
  snapshots are only an optimization over replaying steps.

## 0.2.5

- Update ctx types for convex@1.41+

## 0.2.4

- Fix prosemirror-collab packaging

## 0.2.3

- warn on closing tab with unsynced changes (credit: bxff)

## 0.2.2

- Fix a crash during server rendering (thanks @vcapretz!)

## 0.2.1

- Updates support for tiptap/core v3 by pinning a dependency to not expect a dom
  in a convex function environment. If you see issues with
  decode-named-character-reference, make sure you've updated it to ^1.3.0.

## 0.2.0

- Adds /test and /\_generated/component.js entrypoints
- Drops commonjs support
- Improves source mapping for generated files
- Changes to a statically generated component API

## 0.1.28

- Imports with file extensions to help module resolution for NodeNext

## 0.1.27

- Reduce the number of deltas in one round to avoid returning too long of arrays
  of steps when catching up old clients

## 0.1.26

- Support 0.34 up to 1.0

## 0.1.25

- Support BlockNote ^0.33

## 0.1.24

- Change the BlockNoteEditor to be a type parameter instead, as mismatched
  versions were still unhappy due to subclass checks.

## 0.1.23

- Enable passing in the BlockNoteEditor in the useBlockNoteSync hook to avoid
  type errors when passing the resulting editor to BlockNoteView.
