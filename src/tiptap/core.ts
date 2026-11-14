import type {
  FunctionArgs,
  FunctionReference,
  FunctionReturnType,
} from "convex/server";
import {
  type AnyExtension,
  type Content,
  type Editor,
  Extension,
} from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";
import * as collab from "prosemirror-collab";
import { Step } from "@tiptap/pm/transform";
import type { SyncApi } from "../client/index.js";

// How many steps we will attempt to sync in one request.
const MAX_STEPS_SYNC = 1000;
const SNAPSHOT_DEBOUNCE_MS = 1000;

export type UseSyncOptions = {
  /**
   * Called when syncing fails, including for background work that has no
   * caller to propagate to (the debounced snapshot submit, and the flush of
   * unconfirmed steps when the editor is destroyed).
   *
   * Most errors are informational: the extension keeps syncing and retries on
   * the next local change or update from the server, and a failed snapshot
   * submit costs nothing since snapshots only save replaying steps.
   *
   * The exception is "Unsynced steps could not be flushed after destroy",
   * which means local steps never reached the server before the editor went
   * away. Without a handler that one surfaces as an unhandled rejection
   * rather than being dropped silently.
   */
  onSyncError?: (error: Error) => void;
  snapshotDebounceMs?: number;
  debug?: boolean;
  /**
   * Whether to show a browser warning when closing the tab with unsynced
   * changes. This prevents accidental data loss when the user has local
   * edits that haven't been sent to the server yet.
   * @default true
   */
  warnOnUnsyncedClose?: boolean;
};

type Watch<T> = {
  onUpdate(callback: () => void): () => void;
  localQueryResult(): T | undefined;
};
/**
 * The methods of the Convex client that the extension calls, typed here so
 * the declarations of this entry don't need React's types.
 */
type SyncClient = {
  query<Query extends FunctionReference<"query">>(
    query: Query,
    args: FunctionArgs<Query>,
  ): Promise<FunctionReturnType<Query>>;
  mutation<Mutation extends FunctionReference<"mutation">>(
    mutation: Mutation,
    args: FunctionArgs<Mutation>,
  ): Promise<FunctionReturnType<Mutation>>;
  watchQuery<Query extends FunctionReference<"query">>(
    query: Query,
    args: FunctionArgs<Query>,
  ): Watch<FunctionReturnType<Query>>;
};

export function syncExtension(
  convex: SyncClient,
  id: string,
  syncApi: SyncApi,
  initialState: InitialState,
  opts?: UseSyncOptions,
): AnyExtension {
  const log: typeof console.log = opts?.debug ? console.debug : () => {};
  // Background work has no caller to propagate a failure to, so it reports
  // through one of these two. The split is whether local edits were lost.

  // Lost work: tell the app even if it didn't ask to be told, since silently
  // dropping a user's edits is never the right default. Rethrowing from here
  // surfaces as an unhandled rejection, matching `trySync`.
  const reportDataLoss = (error: Error) => {
    if (opts?.onSyncError) {
      opts.onSyncError(error);
    } else {
      throw error;
    }
  };
  // Nothing durable lost: report it if the app is listening, then carry on.
  const reportRecoverable = (error: Error) => {
    log("Ignoring recoverable sync error", error);
    opts?.onSyncError?.(error);
  };
  let snapshotTimer: NodeJS.Timeout | undefined;
  const trySubmitSnapshot = (version: number, content: string) => {
    if (snapshotTimer) {
      clearTimeout(snapshotTimer);
    }
    snapshotTimer = setTimeout(() => {
      snapshotTimer = undefined;
      // Snapshots are an optimization over replaying steps, and the next one
      // supersedes this one, so a failure here costs us nothing.
      void convex
        .mutation(syncApi.submitSnapshot, { id, version, content })
        .catch(reportRecoverable);
    }, opts?.snapshotDebounceMs ?? SNAPSHOT_DEBOUNCE_MS);
  };

  let active: boolean = false;
  let pending:
    | { resolve: () => void; reject: () => void; promise: Promise<void> }
    | undefined;
  // Every editor that queued behind the active sync, so the retry in
  // `finally` serves all of them.
  const pendingEditors = new Set<Editor>();

  // Editor-keyed, not shared closure variables: StrictMode's double-mount
  // briefly gives two live editors the same extension instance, and each must
  // tear down only its own subscription.
  const subscriptions = new Map<
    Editor,
    { watch: Watch<number | null>; unsubscribe: () => void }
  >();
  const beforeUnloadHandlers = new Map<
    Editor,
    (e: BeforeUnloadEvent) => void
  >();

  async function trySync(editor: Editor) {
    const serverVersion = subscriptions.get(editor)?.watch.localQueryResult();
    if (serverVersion === undefined) {
      return;
    }
    if (serverVersion && serverVersion > collab.getVersion(editor.state)) {
      clearTimeout(snapshotTimer);
      snapshotTimer = undefined;
    }
    if (active) {
      pendingEditors.add(editor);
      if (!pending) {
        let resolve = () => {};
        let reject = () => {};
        const promise = new Promise<void>((res, rej) => {
          resolve = res;
          reject = rej;
        });
        pending = { resolve, reject, promise };
      }
      return pending.promise;
    }
    active = true;

    try {
      if (
        await doSync(
          editor,
          convex,
          syncApi,
          id,
          serverVersion,
          initialState,
          opts?.debug,
        )
      ) {
        const version = collab.getVersion(editor.state);
        const content = JSON.stringify(editor.state.doc.toJSON());
        if (collab.sendableSteps(editor.state)) {
          throw new Error("Synced but still have sendable steps");
        }
        trySubmitSnapshot(version, content);
      }
    } catch (error) {
      if (opts?.onSyncError) {
        opts.onSyncError(error as Error);
      } else {
        throw error;
      }
    } finally {
      active = false;
      if (pending) {
        const { resolve, reject } = pending;
        pending = undefined;
        // Retry every still-subscribed editor that queued — the closure's
        // `editor` may be the destroyed StrictMode twin.
        const targets = [...pendingEditors].filter((e) => subscriptions.has(e));
        pendingEditors.clear();
        if (targets.length > 0) {
          Promise.all(targets.map((e) => trySync(e))).then(
            () => resolve(),
            reject,
          );
        } else {
          resolve();
        }
      }
    }
  }

  return Extension.create({
    name: "convex-sync",
    onDestroy() {
      log("destroying");
      const editor = this.editor;
      subscriptions.get(editor)?.unsubscribe();
      subscriptions.delete(editor);
      pendingEditors.delete(editor);
      const beforeUnloadHandler = beforeUnloadHandlers.get(editor);
      if (beforeUnloadHandler) {
        window.removeEventListener?.("beforeunload", beforeUnloadHandler);
        beforeUnloadHandlers.delete(editor);
      }
      // A snapshot may belong to an editor that's still live, so only cancel
      // it once the last one is gone.
      if (subscriptions.size === 0 && snapshotTimer) {
        clearTimeout(snapshotTimer);
        snapshotTimer = undefined;
      }
      // Unconfirmed steps outlive the view: they're the only record of these
      // edits, and `warnOnUnsyncedClose` covers tab close but can't cover an
      // in-app unmount. 'destroy' fires before the view is torn down and the
      // state is immutable, so it's safe to capture and use afterwards.
      const state = editor.state;
      if (collab.sendableSteps(state)) {
        void _flushPendingSteps(convex, syncApi, id, state, opts?.debug).then(
          (outcome) => {
            if (outcome === "gave-up") {
              reportDataLoss(
                new Error("Unsynced steps could not be flushed after destroy"),
              );
            }
          },
          // The flush resolves "gave-up" for a failed submit but rejects for a
          // step that won't apply, and both mean the steps are lost.
          reportDataLoss,
        );
      }
    },
    onCreate() {
      if (initialState.restoredSteps?.length) {
        // TODO: verify that restoring local steps works
        log("Restoring local steps", initialState.restoredSteps);
        const tr = this.editor.state.tr;
        for (const step of initialState.restoredSteps) {
          tr.step(Step.fromJSON(this.editor.schema, step));
        }
        this.editor.view.dispatch(tr);
      }
      const editor = this.editor;
      const watch = convex.watchQuery(syncApi.latestVersion, { id });
      const unsubscribe = watch.onUpdate(() => {
        void trySync(editor);
      });
      subscriptions.set(editor, { watch, unsubscribe });
      void trySync(editor);
      // Install beforeunload handler if not explicitly disabled.
      if (
        opts?.warnOnUnsyncedClose !== false &&
        typeof window !== "undefined" &&
        typeof window.addEventListener === "function"
      ) {
        const beforeUnloadHandler = (e: BeforeUnloadEvent) => {
          if (collab.sendableSteps(editor.state)) {
            e.preventDefault();
            // Required for older browsers.
            e.returnValue = "";
          }
        };
        beforeUnloadHandlers.set(editor, beforeUnloadHandler);
        window.addEventListener("beforeunload", beforeUnloadHandler);
      }
    },
    onUpdate() {
      void trySync(this.editor);
    },
    addProseMirrorPlugins() {
      log("Adding collab plugin", {
        version: initialState.initialVersion,
      });
      return [
        collab.collab({
          version: initialState.initialVersion,
        }),
      ];
    },
  });
}

async function doSync(
  editor: Editor,
  convex: SyncClient,
  syncApi: SyncApi,
  id: string,
  serverVersion: number | null,
  initialState: InitialState,
  debug?: boolean,
) {
  const log: typeof console.log = debug ? console.debug : () => {};
  if (serverVersion === null) {
    if (initialState.initialVersion <= 1) {
      // This is a new document, so we can create it on the server.
      // Note: this should only happen if the initial version is loaded from
      // a local cache. Creating a new document on the client will set the
      // initial version to 1 optimistically.
      log("Syncing new document", { id });
      await convex.mutation(syncApi.submitSnapshot, {
        id,
        version: initialState.initialVersion,
        content: JSON.stringify(initialState.initialContent),
      });
    } else {
      // TODO: Handle deletion gracefully
      throw new Error("Syncing a document that doesn't exist server-side");
    }
  }
  const version = collab.getVersion(editor.state);
  if (serverVersion !== null && serverVersion > version) {
    log("Updating to server version", {
      id,
      version,
      serverVersion,
    });
    const steps = await convex.query(syncApi.getSteps, {
      id,
      version,
    });
    if (editor.isDestroyed) return false;
    // Apply only the steps we don't already have: the local version can
    // advance during the await. Re-applying a prefix would push our version
    // past the server's, and the next submitSteps would then write a delta
    // with a version gap, which no client can read past.
    const skip = collab.getVersion(editor.state) - version;
    if (skip >= 0 && skip < steps.steps.length) {
      receiveSteps(
        editor,
        steps.steps
          .slice(skip)
          .map((step) => Step.fromJSON(editor.schema, JSON.parse(step))),
        steps.clientIds.slice(skip),
      );
    }
  }
  let anyChanges = false;
  while (true) {
    // Stop once the view is gone: dispatching to it is a silent no-op, so
    // editor.state would never advance and this loop would resubmit forever.
    // onDestroy owns the remaining steps from here. Reporting no changes is
    // required — the state still has sendable steps, which trySync treats as
    // an invariant violation on a successful sync.
    if (editor.isDestroyed) return false;
    const sendable = collab.sendableSteps(editor.state);
    if (!sendable) {
      break;
    }
    const steps = sendable.steps
      .slice(0, MAX_STEPS_SYNC)
      .map((step) => JSON.stringify(step.toJSON()));
    log("Sending steps", { steps, version: sendable.version });
    const result = await convex.mutation(syncApi.submitSteps, {
      id,
      steps,
      version: sendable.version,
      clientId: sendable.clientID,
    });
    // Destroy may have cleared the schema while the submit was in flight.
    // onDestroy's flush now owns the unconfirmed steps.
    if (editor.isDestroyed) return false;
    if (result.status === "synced") {
      anyChanges = true;
      // We replay the steps locally to avoid refetching them.
      receiveSteps(
        editor,
        steps.map((step) => Step.fromJSON(editor.schema, JSON.parse(step))),
        steps.map(() => sendable.clientID),
      );
      log("Synced", {
        steps,
        version,
        newVersion: collab.getVersion(editor.state),
      });
      continue;
    }
    if (result.status === "needs-rebase") {
      receiveSteps(
        editor,
        result.steps.map((step) =>
          Step.fromJSON(editor.schema, JSON.parse(step)),
        ),
        result.clientIds,
      );
      log("Rebased", {
        steps,
        newVersion: collab.getVersion(editor.state),
      });
    }
  }
  return anyChanges;
}

function receiveSteps(
  editor: Editor,
  steps: Step[],
  clientIds: (string | number)[],
) {
  editor.view.dispatch(
    collab.receiveTransaction(editor.state, steps, clientIds, {
      mapSelectionBackward: true,
    }),
  );
}

// How many rebase rounds the post-destroy flush attempts before giving up and
// reporting the steps as lost. Successful submissions don't count — they always
// make progress — so this only trips when other clients keep winning the race.
// The flush has no editor and no user behind it, and the page may be unloading,
// so it can't retry indefinitely the way a live editor does.
const MAX_FLUSH_REBASES = 20;

/**
 * Submit a destroyed editor's unconfirmed local steps: the doSync send loop,
 * run headlessly against the captured EditorState, which is immutable and
 * outlives the view. prosemirror-collab's receiveTransaction behaves as it
 * would live — own-clientID steps confirm (the in-flight submit at destroy may
 * have landed them), foreign steps rebase ours.
 *
 * Best-effort: resolves "gave-up" if the submit fails, and rejects if a step
 * won't apply to the captured state. Either way the steps are lost, and
 * `onDestroy` reports both through `onSyncError`.
 *
 * @internal Exported for tests, hence the underscore. Not a supported API.
 */
export async function _flushPendingSteps(
  convex: SyncClient,
  syncApi: SyncApi,
  id: string,
  state: EditorState,
  debug?: boolean,
): Promise<"flushed" | "gave-up"> {
  const log: typeof console.log = debug ? console.debug : () => {};
  let rebases = 0;
  while (rebases < MAX_FLUSH_REBASES) {
    const sendable = collab.sendableSteps(state);
    if (!sendable) return "flushed";
    // Confirm only what is actually sent this round — the remainder past
    // MAX_STEPS_SYNC drains on the next iteration.
    const toSend = sendable.steps.slice(0, MAX_STEPS_SYNC);
    let result;
    try {
      result = await convex.mutation(syncApi.submitSteps, {
        id,
        version: sendable.version,
        clientId: sendable.clientID,
        steps: toSend.map((step) => JSON.stringify(step.toJSON())),
      });
    } catch (error) {
      log("Flush after destroy failed", { id, error });
      return "gave-up";
    }
    if (result.status === "synced") {
      state = state.apply(
        collab.receiveTransaction(
          state,
          toSend,
          toSend.map(() => sendable.clientID),
          { mapSelectionBackward: true },
        ),
      );
    } else {
      rebases++;
      state = state.apply(
        collab.receiveTransaction(
          state,
          result.steps.map((step) =>
            Step.fromJSON(state.schema, JSON.parse(step)),
          ),
          result.clientIds,
          { mapSelectionBackward: true },
        ),
      );
    }
  }
  return "gave-up";
}

export type InitialState = {
  initialContent: Content;
  initialVersion: number;
  restoredSteps?: object[];
};
