# Convex ProseMirror Component

[![npm version](https://badge.fury.io/js/@convex-dev%2Fprosemirror-sync.svg)](https://badge.fury.io/js/@convex-dev%2Fprosemirror-sync)

This is a [Convex Component](https://convex.dev/components) that syncs a
[ProseMirror](https://prosemirror.net/) document between clients via a
[Tiptap](https://tiptap.dev/) extension (that also works with
[BlockNote](https://blocknotejs.org/)).

<!-- START: Include on https://convex.dev/components -->

Add a collaborative editor that syncs to the cloud. With this component, users
can edit the same document in multiple tabs or devices, and the changes will be
synced to the cloud. The data lives in your Convex database, and can be stored
alongside the rest of your app's data.

Just configure your editor features, add this component to your Convex backend,
and use the provided sync React hook. Read this
[Stack post](https://stack.convex.dev/add-a-collaborative-document-editor-to-your-app)
for more details.

[![Example of editing](./blocknote.gif)](http://www.youtube.com/watch?v=TGd-Nl7PBYQ "Collaborative editing syncing")

Example usage, see [below](#usage) for more details:

```tsx
function CollaborativeEditor() {
  const sync = useBlockNoteSync(api.prosemirrorSync, "some-id");
  return sync.isLoading ? (
    <p>Loading...</p>
  ) : sync.editor ? (
    <BlockNoteView editor={sync.editor} />
  ) : (
    <button onClick={() => sync.create(EMPTY_DOC)}>Create document</button>
  );
}
```

For the editor, you can choose to use Tiptap or BlockNote. Go with BlockNote
unless you want to customize the editor heavily.

- Tiptap is based on ProseMirror and saves you a lot of configuration compared
  to using the ProseMirror editor directly. It has a rich ecosystem of
  extensions, and is very customizable.
- BlockNote is based on Tiptap and has a nicer UI and experience out of the box,
  at the cost of being harder to extend and customize for advanced usecases. If
  you're looking for the easiest way to get all the fancy formatting options,
  this is it.
- Unfortunately, even though they both are based on ProseMirror, the data model
  differs, so it's not trivial to switch editors later on without migrating all
  of the data, so you might experiment with both before launching publicly.

Features:

- Safely merges changes between clients via operational transformations (OT).
- Simple React hook to fetch the initial document and keep it in sync via a
  Tiptap extension.
- Supports both Tiptap and BlockNote.
- Server-side entrypoints for authorizing reads, writes, and snapshots.
- Create a new document, online or offline.
- Debounced snapshots allow new clients to avoid reading the full history.
- Deletion API for old snapshots & steps.
- Transform the document server-side, enabling easy AI interoperation.
- Warning when closing a tab with unsynced changes (enabled by default).

See [below](#future-features) for future feature ideas and
[CONTRIBUTING.md](./CONTRIBUTING.md) for how to contribute. Found a bug? Feature
request? [File it here](https://github.com/convex/prosemirror-sync/issues).

## Pre-requisite: Convex

You'll need an existing Convex project to use the component. Convex is a hosted
backend platform, including a database, serverless functions, and a ton more you
can learn about [here](https://docs.convex.dev/get-started).

Run `npm create convex` or follow any of the
[quickstarts](https://docs.convex.dev/home) to set one up.

## Installation

Install the component package:

```ts
npm install @convex-dev/prosemirror-sync
```

Create a `convex.config.ts` file in your app's `convex/` folder and install the
component by calling `use`:

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import prosemirrorSync from "@convex-dev/prosemirror-sync/convex.config.js";

const app = defineApp();
app.use(prosemirrorSync);

export default app;
```

## Usage

To use the component, you expose the API in a file in your `convex/` folder, and
use the editor-specific sync React hook, passing in a reference to the API you
defined. For this example, we'll create the API in `convex/example.ts`.

```ts
// convex/example.ts
import { components } from "./_generated/api";
import { ProsemirrorSync } from "@convex-dev/prosemirror-sync";

const prosemirrorSync = new ProsemirrorSync(components.prosemirrorSync);
export const {
  getSnapshot,
  submitSnapshot,
  latestVersion,
  getSteps,
  submitSteps,
} = prosemirrorSync.syncApi({
  // ...
});
```

In your React components, you can then use the editor-specific hook to fetch the
document and keep it in sync via a Tiptap extension. **Note**: This requires a
[`ConvexProvider`](https://docs.convex.dev/quickstart/react#:~:text=Connect%20the%20app%20to%20your%20backend)
to be in the component tree.

### BlockNote editor

**IMPORTANT**: BlockNote doesn't currently support `<StrictMode>` in React 19.
If you're using React 19, make sure you remove any `<React.StrictMode>` blocks
and set `reactStrictMode: false` in your `next.config.ts` if applicable.
[docs](https://www.blocknotejs.org/docs/advanced/nextjs#react-19--next-15-strictmode)

```tsx
// src/MyComponent.tsx
import { useBlockNoteSync } from "@convex-dev/prosemirror-sync/blocknote";
import "@blocknote/core/fonts/inter.css";
import { BlockNoteView } from "@blocknote/mantine";
import "@blocknote/mantine/style.css";
import { api } from "../convex/_generated/api";
import { BlockNoteEditor } from "@blocknote/core";

export function MyComponent() {
  const sync = useBlockNoteSync<BlockNoteEditor>(api.example, "some-id");
  return sync.isLoading ? (
    <p>Loading...</p>
  ) : sync.editor ? (
    <BlockNoteView editor={sync.editor} />
  ) : (
    <button onClick={() => sync.create({ type: "doc", content: [] })}>
      Create document
    </button>
  );
}
```

### Tiptap editor

In your React components, you can use the `useTiptapSync` hook to fetch the
initial document and keep it in sync via a Tiptap extension. **Note**: This
requires a
[`ConvexProvider`](https://docs.convex.dev/quickstart/react#:~:text=Connect%20the%20app%20to%20your%20backend)
to be in the component tree.

```tsx
// src/MyComponent.tsx
import { useTiptapSync } from "@convex-dev/prosemirror-sync/tiptap";
import { EditorContent, EditorProvider } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { api } from "../convex/_generated/api";

export function MyComponent() {
  const sync = useTiptapSync(api.example, "some-id");
  return sync.isLoading ? (
    <p>Loading...</p>
  ) : sync.initialContent !== null ? (
    <EditorProvider
      content={sync.initialContent}
      extensions={[StarterKit, sync.extension]}
    >
      <EditorContent editor={null} />
    </EditorProvider>
  ) : (
    <button onClick={() => sync.create({ type: "doc", content: [] })}>
      Create document
    </button>
  );
}
```

See a working example in [example.ts](./example/convex/example.ts) and
[App.tsx](./example/src/App.tsx).

### Tiptap on other frameworks

`@convex-dev/prosemirror-sync/tiptap/core` exports the Tiptap extension without
React. Pass it a
[`ConvexClient`](https://docs.convex.dev/api/classes/browser.ConvexClient) and
the snapshot to start from:

```ts
import { ConvexClient } from "convex/browser";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { syncExtension } from "@convex-dev/prosemirror-sync/tiptap/core";
import { api } from "../convex/_generated/api";

const convex = new ConvexClient(import.meta.env.VITE_CONVEX_URL);
const snapshot = await convex.query(api.example.getSnapshot, { id: "some-id" });
if (snapshot.content === null) throw new Error("Document not found");
const initialContent = JSON.parse(snapshot.content);

const editor = new Editor({
  element: document.querySelector("#editor")!,
  content: initialContent,
  extensions: [
    StarterKit,
    syncExtension(convex, "some-id", api.example, {
      initialContent,
      initialVersion: snapshot.version,
    }),
  ],
});
```

## Notes

### Configuring the snapshot debounce interval

The snapshot debounce interval is set to one second by default. You can specify
a different interval with the `snapshotDebounceMs` option when calling
`useTiptapSync` or `useBlockNoteSync`.

A snapshot won't be sent until both of these are true:

- The document has been idle for the debounce interval.
- The current user was the last to make a change.

There can be races, but since each client will submit the snapshot for their own
change, they won't conflict with each other and are safe to apply.

### Unsynced changes warning

By default, the sync extension shows a browser confirmation dialog when the user
tries to close a tab with local changes that haven't been sent to the server.
This can be disabled:

```ts
const sync = useTiptapSync(api.example, "some-id", {
  warnOnUnsyncedClose: false,
});
```

### Handling sync errors

Pass `onSyncError` to be told when syncing fails:

```ts
const sync = useTiptapSync(api.example, "some-id", {
  onSyncError: (error) => {
    console.error("Sync failed", error);
  },
});
```

This also covers work that happens in the background, with no caller to
propagate a failure to: the debounced snapshot submit, and the flush of
unconfirmed steps when the editor is destroyed (see below).

Most errors are informational — the extension keeps syncing, and retries on the
next local change or update from the server. A failed snapshot submit in
particular costs nothing: snapshots only save replaying steps, and the next one
supersedes it.

The exception is `"Unsynced steps could not be flushed after destroy"`, which
means local steps never made it to the server before the editor went away. If
you haven't passed `onSyncError`, that one surfaces as an unhandled rejection
rather than being dropped silently.

A failed `latestVersion` query stops the sync until the query succeeds again. It
is reported once per failed result, and without `onSyncError` it surfaces as an
unhandled rejection too.

### Unmounting with unsynced changes

Local steps are the source of truth until the server confirms them, so when an
editor is destroyed with steps still in flight — the user switches documents in
your app mid-round-trip, for instance — the extension submits them in the
background rather than dropping them. `warnOnUnsyncedClose` only covers closing
the tab, which the browser lets us block; an in-app unmount can't be blocked.

The flush is best-effort: if the request fails (offline, say), the steps are
lost and `onSyncError` is called. To avoid the situation entirely, keep the
editor mounted until `collab.sendableSteps(editor.state)` returns null.

### Creating a new document

You can create a new document from the client by calling `sync.create(content)`,
or on the server by calling `prosemirrorSync.create(ctx, id, content)`.

The content should be a JSON object matching the
[Schema](https://tiptap.dev/docs/editor/core-concepts/schema). If you're using
BlockNote, it needs to be the ProseMirror JSON representation of the BlockNote
blocks. Look at the value stored in the `snapshots` table in your database for
an example. Both can use this value: `{ type: "doc", content: [] }`

For client-side document creation:

- While it's safest to wait until the server confirms the document doesn't exist
  yet (`!sync.isLoading`), you can choose to call it while offline with a newly
  created ID to start editing a new document before you reconnect.
- When the client next connects and syncs the document, it will submit the
  initial version and all local changes as steps.
- If multiple clients create the same document, it will fail if they submit
  different initial content.
- Note: if you don't open that document while online, it won't sync.

### Transforming the document server-side

You can transform the document server-side. It will give you the latest version
of the document, and you return a
[ProseMirror Transform](https://prosemirror.net/docs/ref/#transform.Transform).

You can make this transoform via `new Transform(doc)` or, if you are hydrating a
full `EditorState`, you can use `Editor.create({doc}).tr` to create a new
`Transaction` (which is a subclass of `Transform`).

For example:

```ts
import { getSchema } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";

export const transformExample = action({
  args: {
    id: v.string(),
  },
  handler: async (ctx, { id }) => {
    const schema = getSchema(extensions);
    await prosemirrorSync.transform(ctx, id, schema, (doc) => {
      const tr = EditorState.create({ doc }).tr;
      tr.insertText("Hello, world!", 0);
      return tr;
    });
  },
});
```

- The `extensions` should be the same as the ones used by your client editor,
  for any extensions that affect the schema (not the sync extension).
- The `transform` function can be called multiple times if the document is being
  modified concurrently. Ideally this callback doesn't do any slow operations
  internally. Instead, do them beforehand.
- The `doc` may differ from the one returned from `getDoc`. You can compare the
  `version` returned from `getDoc` to the second argument to the `transform`
  function to see if the document has changed.
- The `transform` function can return a null value to abort making changes.
- If you're passing along a position to insert the text, be aware that changes
  happening in parallel may cause the position to change. You can pass more
  stable identifiers, or use the ProseMirror mapping capabilities to map the
  position between different versions by fetching the steps between the versions
  fetched with `(component).lib.getSteps`.
- If you're using BlockNote, you'll need to convert the BlockNote blocks between
  BlockNote blocks and ProseMirror nodes. See
  [blockToNode and nodeToBlock](https://github.com/TypeCellOS/BlockNote/tree/main/packages/core/src/api/nodeConversions).

```ts
import { Transform } from "@tiptap/pm/transform";

// An example of doing slower AI operations beforehand:
const schema = getSchema(extensions);
const { doc, version } = await prosemirrorSync.getDoc(ctx, id, schema);
const content = await generateAIContent(doc);
await prosemirrorSync.transform(ctx, id, schema, (doc, v) => {
  if (v !== version) {
    // Decide what to do if the document changes.
  }
  // An example of using Transform directly.
  const tr = new Transform(doc);
  tr.insert(0, schema.text(content));
  return tr;
});
```

## Future features

Features that could be added later:

- Offline editing support: cache the document and local changes in
  `sessionStorage` and sync when back online (only for active browser tab).
  - Also save snapshots (but not local edits) to `localStorage` so new tabs can
    see and edit documents offline (but won't see edits from other tabs until
    they're back online).
- Configuration for debouncing syncing steps (to reduce function calls).
- Option to write the concrete value each time a delta is submitted.
- Pluggable storage for ReactNative, assuming single-session.
- Convert it to a ProseMirror plugin instead of a Tiptap extension, so raw
  ProseMirror usecases can also use it.
- Handling edge cases, such as old clients with local changes on top of an older
  version of the document where the steps necessary for them to rebase their
  changes have since been vacuumed.
- Type parameter for the document ID for more type safety for folks using Convex
  IDs as their document IDs. This is available on the server but not browser.
- Drop clientIds entirely and just use two UUIDs locally to differentiate our
  changes from server-applied changes.
- Add an optional authorId to the data model to track who made which changes.

Missing features that aren't currently planned:

- Supporting documents larger than 1 Megabyte.
- Offline support that syncs changes between browser tabs or peer-to-peer.
- Syncing Yjs documents instead of ProseMirror steps. That would be done by a
  different Yjs-specific component.
- Syncing presence (e.g. showing other users' names and cursor in the UI). This
  is another thing a Yjs-oriented ProseMirror component could tackle.
- Callback to confirm rebases and handle failures in the client (during sync).
- Optimization to sync a snapshot instead of many deltas when an old client
  reconnects and doesn't have local changes.
- Handling multiple AsyncStorage instances that are restored from the same cloud
  backup, leading to multiple clients with the same clientID. For now, we'll
  assume that AsyncStorage is only used by one client at a time.

<!-- END: Include on https://convex.dev/components -->

## Running the example locally

In one terminal, run:

```sh
npm run setup
npm run example
```

To make changes to the component and rebuild automatically:

```sh
npm run setup
npm run dev
```
