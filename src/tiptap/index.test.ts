/// <reference types="vite/client" />

import { webcrypto as crypto } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { convexTest, type TestConvex } from "convex-test";
import { ConvexClient } from "convex/browser";
import type { ConvexReactClient } from "convex/react";
import { getFunctionName } from "convex/server";
import type { AnyExtension, Editor } from "@tiptap/core";
import { Schema } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { Step } from "@tiptap/pm/transform";
import * as collab from "prosemirror-collab";
import componentSchema from "../component/schema.js";
import { api } from "../component/_generated/api.js";
import type { SyncApi } from "../client/index.js";
import { _flushPendingSteps, syncExtension } from "./core.js";
import { syncExtension as reactSyncExtension } from "./index.js";

const modules = import.meta.glob("../component/**/*.*s");

// The component's function references are shaped the same as the ones the
// client generates via `prosemirrorSync.syncApi()`.
const syncApi = api.lib as unknown as SyncApi;

type SubmitStepsArgs = {
  id: string;
  version: number;
  clientId: string | number;
  steps: string[];
};
type SubmitStepsResult =
  | { status: "synced" }
  | {
      status: "needs-rebase";
      steps: string[];
      clientIds: (string | number)[];
    };

/**
 * A `ConvexClient` stand-in exposing just what `_flushPendingSteps` uses:
 * `mutation(syncApi.submitSteps, args)`. The function reference is ignored
 * since that's the only call it makes.
 */
function fakeClient(
  submitSteps: (args: SubmitStepsArgs) => Promise<SubmitStepsResult>,
): ConvexClient {
  return {
    mutation: (_reference: unknown, args: unknown) =>
      submitSteps(args as SubmitStepsArgs),
  } as unknown as ConvexClient;
}

function realClient(t: TestConvex<typeof componentSchema>): ConvexClient {
  return fakeClient((args) => t.mutation(api.lib.submitSteps, args));
}

// A minimal schema: enough to make real ProseMirror steps that apply cleanly.
const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*", toDOM: () => ["p", 0] },
    text: {},
  },
});

/** An editor state with the collab plugin at `version`, as the extension sets up. */
function stateAt(version: number, clientID: string) {
  return EditorState.create({
    schema,
    plugins: [collab.collab({ version, clientID })],
  });
}

/** Produce an unconfirmed local step, the way typing in the editor would. */
function typeText(state: EditorState, text: string) {
  return state.apply(state.tr.insertText(text, 1));
}

function stepsJSON(state: EditorState) {
  return collab
    .sendableSteps(state)!
    .steps.map((step) => JSON.stringify(step.toJSON()));
}

async function seedSnapshot(
  t: TestConvex<typeof componentSchema>,
  id: string,
  version = 1,
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("snapshots", { id, version, content: "{}" });
  });
}

describe("_flushPendingSteps", () => {
  test("submits unconfirmed steps left over when the editor is destroyed", async () => {
    const t = convexTest(componentSchema, modules);
    const id = crypto.randomUUID();
    await seedSnapshot(t, id);
    const state = typeText(stateAt(1, "me"), "hello");
    expect(collab.sendableSteps(state)).not.toBeNull();

    expect(await _flushPendingSteps(realClient(t), syncApi, id, state)).toBe(
      "flushed",
    );

    // The step the destroyed view was still holding is now on the server.
    const server = await t.query(api.lib.getSteps, { id, version: 1 });
    expect(server.version).toBe(2);
    expect(server.clientIds).toEqual(["me"]);
  });

  test("rebases over steps that landed first, then submits", async () => {
    const t = convexTest(componentSchema, modules);
    const id = crypto.randomUUID();
    // Another client's edit reached the server while we were unmounting.
    const foreignSteps = stepsJSON(typeText(stateAt(1, "other"), "abc"));
    await seedSnapshot(t, id);
    await t.run(async (ctx) => {
      await ctx.db.insert("deltas", {
        id,
        version: 2,
        clientId: "other",
        steps: foreignSteps,
      });
    });
    const state = typeText(stateAt(1, "me"), "XYZ");

    expect(await _flushPendingSteps(realClient(t), syncApi, id, state)).toBe(
      "flushed",
    );

    const server = await t.query(api.lib.getSteps, { id, version: 1 });
    expect(server.version).toBe(3);
    expect(server.clientIds).toEqual(["other", "me"]);
  });

  test("confirms — without duplicating — steps whose in-flight submit landed", async () => {
    const t = convexTest(componentSchema, modules);
    const id = crypto.randomUUID();
    const state = typeText(stateAt(1, "me"), "hello");
    // The submitSteps that was in flight when the editor was destroyed did
    // land; the view just never got to apply the confirmation.
    const ownSteps = stepsJSON(state);
    await seedSnapshot(t, id);
    await t.run(async (ctx) => {
      await ctx.db.insert("deltas", {
        id,
        version: 2,
        clientId: "me",
        steps: ownSteps,
      });
    });

    expect(await _flushPendingSteps(realClient(t), syncApi, id, state)).toBe(
      "flushed",
    );

    // Still one delta: the steps were recognized as ours and confirmed, not
    // written a second time.
    const server = await t.query(api.lib.getSteps, { id, version: 1 });
    expect(server.version).toBe(2);
    expect(server.steps).toEqual(ownSteps);
  });

  test("confirms own landed steps and absorbs foreign ones after them", async () => {
    const t = convexTest(componentSchema, modules);
    const id = crypto.randomUUID();
    const state = typeText(stateAt(1, "me"), "mine");
    const ownSteps = stepsJSON(state);
    // Our in-flight submit landed at v2, then another client edited on top of
    // it, so the needs-rebase response is ours-then-theirs.
    const foreign = typeText(
      EditorState.create({
        doc: state.doc,
        plugins: [collab.collab({ version: 2, clientID: "other" })],
      }),
      "THEIRS",
    );
    await seedSnapshot(t, id);
    await t.run(async (ctx) => {
      await ctx.db.insert("deltas", {
        id,
        version: 2,
        clientId: "me",
        steps: ownSteps,
      });
      await ctx.db.insert("deltas", {
        id,
        version: 3,
        clientId: "other",
        steps: stepsJSON(foreign),
      });
    });

    expect(await _flushPendingSteps(realClient(t), syncApi, id, state)).toBe(
      "flushed",
    );

    const server = await t.query(api.lib.getSteps, { id, version: 1 });
    expect(server.version).toBe(3);
    expect(server.clientIds).toEqual(["me", "other"]);
  });

  test("sends steps in batches, confirming only what each round submitted", async () => {
    const t = convexTest(componentSchema, modules);
    const id = crypto.randomUUID();
    await seedSnapshot(t, id);
    // More steps than MAX_STEPS_SYNC (1000), so the flush needs two rounds.
    let state = stateAt(1, "me");
    for (let i = 0; i < 1001; i++) {
      state = typeText(state, "a");
    }
    expect(collab.sendableSteps(state)!.steps.length).toBe(1001);

    expect(await _flushPendingSteps(realClient(t), syncApi, id, state)).toBe(
      "flushed",
    );

    await t.run(async (ctx) => {
      const deltas = await ctx.db
        .query("deltas")
        .withIndex("id_version", (q) => q.eq("id", id))
        .collect();
      expect(deltas.map((d) => d.steps.length)).toEqual([1000, 1]);
      expect(deltas[deltas.length - 1].version).toBe(1002);
    });
  });

  test("does nothing when there is nothing unconfirmed", async () => {
    const t = convexTest(componentSchema, modules);
    const id = crypto.randomUUID();
    await seedSnapshot(t, id);

    expect(
      await _flushPendingSteps(realClient(t), syncApi, id, stateAt(1, "me")),
    ).toBe("flushed");

    const server = await t.query(api.lib.getSteps, { id, version: 1 });
    expect(server.steps).toEqual([]);
  });

  test("gives up (rather than throwing) when the submit fails", async () => {
    const state = typeText(stateAt(1, "me"), "hello");
    const convex = fakeClient(() => Promise.reject(new Error("network down")));

    expect(await _flushPendingSteps(convex, syncApi, "doc", state)).toBe(
      "gave-up",
    );
  });

  test("gives up instead of rebasing forever", async () => {
    const state = typeText(stateAt(1, "me"), "hello");
    // A server that never accepts our steps: every submit needs another rebase.
    const foreignStep = stepsJSON(typeText(stateAt(1, "other"), "x"))[0];
    let calls = 0;
    const convex = fakeClient(() => {
      calls++;
      return Promise.resolve({
        status: "needs-rebase",
        steps: [foreignStep],
        clientIds: ["other"],
      } as const);
    });

    expect(await _flushPendingSteps(convex, syncApi, "doc", state)).toBe(
      "gave-up",
    );
    expect(calls).toBeGreaterThan(1);
    expect(calls).toBeLessThan(100);
  });

  test("rejects when a step can't be applied, so onDestroy can report it", async () => {
    const t = convexTest(componentSchema, modules);
    const id = crypto.randomUUID();
    await seedSnapshot(t, id);
    // A delta the local schema can't make sense of, so the rebase throws
    // rather than the mutation. onDestroy routes this to onSyncError.
    await t.run(async (ctx) => {
      await ctx.db.insert("deltas", {
        id,
        version: 2,
        clientId: "other",
        steps: ["{}"],
      });
    });
    const state = typeText(stateAt(1, "me"), "hello");

    await expect(
      _flushPendingSteps(realClient(t), syncApi, id, state),
    ).rejects.toThrow();
  });
});

/**
 * Call the extension's onDestroy the way tiptap does, with a stand-in for the
 * editor: onDestroy only reads `editor.state`, and that state is a real one.
 * (A real Editor needs a DOM, which this test environment doesn't have.)
 */
function destroy(extension: AnyExtension, state: EditorState) {
  const onDestroy = (
    extension.config as {
      onDestroy?: (this: { editor: Editor }) => void;
    }
  ).onDestroy;
  onDestroy!.call({ editor: { state } as Editor });
}

function extensionWith(
  convex: ConvexClient,
  onSyncError: (error: Error) => void,
) {
  return syncExtension(
    convex,
    "doc",
    syncApi,
    { initialContent: { type: "doc", content: [] }, initialVersion: 1 },
    { onSyncError },
  );
}

/**
 * `ConvexClient`'s `onUpdate` for the version query. Like the real client, it
 * tells a new listener of the result `read` already has, once and on a later
 * task, and of every later result when `update` is called.
 */
function versionSubscription(read: () => number | null | undefined) {
  const listeners = new Set<() => void>();
  const unsubscribe = vi.fn();
  const onUpdate = (
    _query: unknown,
    _args: unknown,
    callback: (version: number | null) => void,
    onError: (error: Error) => void,
  ) => {
    let told = false;
    const tell = () => {
      told = true;
      let version;
      try {
        version = read();
      } catch (error) {
        return onError(error as Error);
      }
      if (version !== undefined) callback(version);
    };
    listeners.add(tell);
    setTimeout(() => {
      if (!told && listeners.has(tell)) tell();
    }, 0);
    return {
      getCurrentValue: read,
      unsubscribe: () => {
        unsubscribe();
        listeners.delete(tell);
      },
    };
  };
  const update = () => listeners.forEach((tell) => tell());
  return { onUpdate, unsubscribe, update };
}

const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("destroy during sync", () => {
  test.each(["synced", "needs-rebase"] as const)(
    "leaves the flush in charge when the in-flight submit returns %s",
    async (status) => {
      const t = convexTest(componentSchema, modules);
      await seedSnapshot(t, "doc");
      if (status === "needs-rebase") {
        await t.mutation(api.lib.submitSteps, {
          id: "doc",
          version: 1,
          clientId: "other",
          steps: stepsJSON(typeText(stateAt(1, "other"), "remote")),
        });
      }

      let releaseSubmit!: () => void;
      const inFlight = new Promise<void>((resolve) => {
        releaseSubmit = resolve;
      });
      // Preserve Convex's mutation ordering while holding the live submit
      // open. The destroy-time flush queues behind it against the real backend.
      let queue: Promise<unknown> = inFlight;
      const submit = vi.fn((args: SubmitStepsArgs) => {
        const result = queue.then(() => t.mutation(api.lib.submitSteps, args));
        queue = result;
        return result;
      });
      const { onUpdate, unsubscribe } = versionSubscription(() => 1);
      const submitSnapshot = vi.fn();
      const convex = {
        mutation: (reference: SyncApi["submitSteps"], args: SubmitStepsArgs) =>
          getFunctionName(reference) === getFunctionName(syncApi.submitSteps)
            ? submit(args)
            : submitSnapshot(args),
        onUpdate,
      } as unknown as ConvexClient;
      const onSyncError = vi.fn();
      const extension = extensionWith(convex, onSyncError);
      const hooks = extension.config as unknown as {
        onCreate: (this: { editor: Editor }) => void;
        onUpdate: (this: { editor: Editor }) => void;
        onDestroy: (this: { editor: Editor }) => void;
      };
      // Model Tiptap's teardown with real ProseMirror state: the destroy
      // hook runs before the schema is cleared and the view is destroyed.
      const editor = {
        state: typeText(stateAt(1, "me"), "hello"),
        schema: schema as Schema | null,
        isDestroyed: false,
        view: { dispatch: vi.fn() },
      };
      const context = { editor: editor as unknown as Editor };
      hooks.onCreate.call(context);
      expect(submit).toHaveBeenCalledTimes(1);

      // More typing while the first submit is pending must also survive.
      editor.state = typeText(editor.state, "later");
      hooks.onUpdate.call(context);
      hooks.onDestroy.call(context);
      editor.isDestroyed = true;
      editor.schema = null;
      expect(unsubscribe).toHaveBeenCalledOnce();
      expect(submit).toHaveBeenCalledTimes(2);

      releaseSubmit();
      expect(await submit.mock.results[0].value).toMatchObject({ status });
      // The flush either confirms our first step, or rebases over the
      // foreign step, then submits the remaining local edits.
      await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(3));
      expect(await submit.mock.results[1].value).toMatchObject({
        status: "needs-rebase",
      });
      expect(await submit.mock.results[2].value).toEqual({ status: "synced" });
      // Let the flush's final confirmation and error handlers finish.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(onSyncError).not.toHaveBeenCalled();
      expect(editor.view.dispatch).not.toHaveBeenCalled();
      expect(submitSnapshot).not.toHaveBeenCalled();
      expect(submit).toHaveBeenCalledTimes(3);

      const server = await t.query(api.lib.getSteps, { id: "doc", version: 1 });
      expect(server.clientIds).toEqual(
        status === "synced" ? ["me", "me"] : ["other", "me", "me"],
      );
      // Replay the persisted steps to prove the final document contains
      // every edit exactly once, including edits made after the first submit.
      let replayed = stateAt(1, "reader");
      for (const step of server.steps) {
        replayed = replayed.apply(
          replayed.tr.step(Step.fromJSON(schema, JSON.parse(step))),
        );
      }
      expect(replayed.doc.textContent).toBe(
        status === "synced" ? "laterhello" : "remotelaterhello",
      );
    },
  );
});

describe("onDestroy error reporting", () => {
  test("reports a flush that gave up", async () => {
    const errors: Error[] = [];
    const convex = fakeClient(() => Promise.reject(new Error("network down")));

    destroy(
      extensionWith(convex, (error) => errors.push(error)),
      typeText(stateAt(1, "me"), "hello"),
    );

    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0].message).toContain(
      "Unsynced steps could not be flushed after destroy",
    );
  });

  test("reports a flush that threw rather than becoming an unhandled rejection", async () => {
    const errors: Error[] = [];
    // A step the flush can't apply: this rejects the flush promise instead of
    // resolving to "gave-up", so it only reaches onSyncError if onDestroy
    // attached a rejection handler.
    const convex = fakeClient(() =>
      Promise.resolve({
        status: "needs-rebase",
        steps: ["{}"],
        clientIds: ["other"],
      } as const),
    );

    destroy(
      extensionWith(convex, (error) => errors.push(error)),
      typeText(stateAt(1, "me"), "hello"),
    );

    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0].message).not.toContain("could not be flushed");
  });

  test("stays quiet when there is nothing to flush", async () => {
    const errors: Error[] = [];
    const convex = fakeClient(() => Promise.reject(new Error("never called")));

    destroy(
      extensionWith(convex, (error) => errors.push(error)),
      stateAt(1, "me"),
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(errors).toEqual([]);
  });
});

describe("version query errors", () => {
  test("reports a failed version query once, from the subscription", async () => {
    const errors: Error[] = [];
    const denied = new Error("not allowed");
    const gone = new Error("document deleted");
    let failure = denied;
    const { onUpdate, update } = versionSubscription(() => {
      throw failure;
    });
    const convex = { onUpdate } as unknown as ConvexClient;
    const hooks = extensionWith(convex, (error) => errors.push(error))
      .config as unknown as {
      onCreate: (this: { editor: Editor }) => void;
      onUpdate: (this: { editor: Editor }) => void;
    };
    const context = { editor: { state: stateAt(1, "me") } as Editor };

    // A local edit reads the failed query without reporting it.
    hooks.onCreate.call(context);
    hooks.onUpdate.call(context);
    expect(errors).toEqual([]);

    // The subscription reports it, and later edits don't repeat it.
    await nextTask();
    hooks.onUpdate.call(context);
    // Give a rejected sync the time to surface as an unhandled rejection.
    await nextTask();
    expect(errors).toEqual([denied]);

    // The next failed result is reported too.
    failure = gone;
    update();
    hooks.onUpdate.call(context);
    expect(errors).toEqual([denied, gone]);
  });

  test("leaves a failed version query unhandled when there is no onSyncError", async () => {
    const failure = new Error("not allowed");
    const { onUpdate } = versionSubscription(() => {
      throw failure;
    });
    const convex = { onUpdate } as unknown as ConvexClient;
    const hooks = syncExtension(convex, "doc", syncApi, {
      initialContent: { type: "doc", content: [] },
      initialVersion: 1,
    }).config as unknown as {
      onCreate: (this: { editor: Editor }) => void;
      onUpdate: (this: { editor: Editor }) => void;
    };
    const context = { editor: { state: stateAt(1, "me") } as Editor };

    // The sync has stopped, so the app hears of it once, not on every edit.
    const unhandled = await unhandledRejections(async () => {
      hooks.onCreate.call(context);
      await nextTask();
      hooks.onUpdate.call(context);
    });
    expect(unhandled).toEqual([failure]);
  });

  test("keeps an onSyncError that throws out of the client's update loop", async () => {
    const failure = new Error("not allowed");
    const bug = new Error("the handler threw");
    let failed = false;
    const { onUpdate, update } = versionSubscription(() => {
      if (failed) throw failure;
      return undefined;
    });
    const convex = { onUpdate } as unknown as ConvexClient;
    const hooks = extensionWith(convex, () => {
      throw bug;
    }).config as unknown as { onCreate: (this: { editor: Editor }) => void };

    const unhandled = await unhandledRejections(() => {
      hooks.onCreate.call({ editor: { state: stateAt(1, "me") } as Editor });
      // The query fails, and the client tells its listeners.
      failed = true;
      expect(update).not.toThrow();
    });
    expect(unhandled).toEqual([bug]);
  });
});

/**
 * Runs `act` and returns the rejections it left unhandled, which would
 * otherwise fail the test run.
 */
async function unhandledRejections(act: () => void | Promise<void>) {
  const listeners = process.listeners("unhandledRejection");
  process.removeAllListeners("unhandledRejection");
  const reasons: unknown[] = [];
  process.on("unhandledRejection", (reason) => reasons.push(reason));
  try {
    await act();
    await nextTask();
  } finally {
    process.removeAllListeners("unhandledRejection");
    for (const listener of listeners) {
      process.on("unhandledRejection", listener);
    }
  }
  return reasons;
}

/** A stand-in for a live Tiptap editor: its view applies what is dispatched. */
function liveEditor(state: EditorState) {
  const editor = {
    state,
    schema,
    isDestroyed: false,
    view: {
      dispatch: (tr: Parameters<EditorState["apply"]>[0]) => {
        editor.state = editor.state.apply(tr);
      },
    },
  };
  return editor;
}

describe("updates from the subscription", () => {
  test("a new version starts a sync", async () => {
    let readVersion = (): number | undefined => undefined;
    const { onUpdate, update } = versionSubscription(() => readVersion());
    const submit = vi.fn(async (_args: SubmitStepsArgs) => ({
      status: "synced" as const,
    }));
    const convex = {
      mutation: (_reference: unknown, args: SubmitStepsArgs) => submit(args),
      onUpdate,
    } as unknown as ConvexClient;
    const hooks = syncExtension(
      convex,
      "doc",
      syncApi,
      { initialContent: { type: "doc", content: [] }, initialVersion: 1 },
      { snapshotDebounceMs: 1e6 },
    ).config as unknown as {
      onCreate: (this: { editor: Editor }) => void;
      onDestroy: (this: { editor: Editor }) => void;
    };
    const editor = liveEditor(typeText(stateAt(1, "me"), "hello"));
    const context = { editor: editor as unknown as Editor };

    // The query is still loading, so there is no version to sync to.
    hooks.onCreate.call(context);
    await nextTask();
    expect(submit).not.toHaveBeenCalled();

    readVersion = () => 1;
    update();
    await vi.waitFor(() =>
      expect(collab.sendableSteps(editor.state)).toBeNull(),
    );
    expect(submit).toHaveBeenCalledOnce();
    hooks.onDestroy.call(context);
  });

  test("a new version from a ConvexReactClient pulls the server's steps", async () => {
    let readVersion = (): number | undefined => undefined;
    let notify!: () => void;
    const query = vi.fn(async () => ({
      steps: stepsJSON(typeText(stateAt(1, "other"), "remote")),
      clientIds: ["other"],
    }));
    const convex = {
      query,
      watchQuery: () => ({
        localQueryResult: () => readVersion(),
        onUpdate: (listener: () => void) => {
          notify = listener;
          return vi.fn();
        },
      }),
    } as unknown as ConvexReactClient;
    const hooks = reactSyncExtension(convex, "doc", syncApi, {
      initialContent: { type: "doc", content: [] },
      initialVersion: 1,
    }).config as unknown as {
      onCreate: (this: { editor: Editor }) => void;
      onDestroy: (this: { editor: Editor }) => void;
    };
    const editor = liveEditor(stateAt(1, "me"));
    const context = { editor: editor as unknown as Editor };

    hooks.onCreate.call(context);
    expect(query).not.toHaveBeenCalled();

    readVersion = () => 2;
    notify();
    await vi.waitFor(() => expect(editor.state.doc.textContent).toBe("remote"));
    expect(query).toHaveBeenCalledWith(syncApi.getSteps, {
      id: "doc",
      version: 1,
    });
    hooks.onDestroy.call(context);
  });

  type Hooks = {
    onCreate: (this: { editor: Editor }) => void;
    onUpdate: (this: { editor: Editor }) => void;
    onDestroy: (this: { editor: Editor }) => void;
  };
  const initialState = {
    initialContent: { type: "doc", content: [] },
    initialVersion: 1,
  };

  test("a newer version queues a retry behind the sync in flight", async () => {
    let version = 1;
    const { onUpdate, update } = versionSubscription(() => version);
    let finishSubmit!: () => void;
    const submit = vi.fn(
      () =>
        new Promise((resolve) => {
          finishSubmit = () => resolve({ status: "synced" });
        }),
    );
    const query = vi.fn(async () => ({ steps: [], clientIds: [] }));
    const convex = { mutation: submit, query, onUpdate };
    const hooks = syncExtension(
      convex as unknown as ConvexClient,
      "doc",
      syncApi,
      initialState,
      { snapshotDebounceMs: 1e6 },
    ).config as unknown as Hooks;
    const editor = liveEditor(typeText(stateAt(1, "me"), "hello"));
    const context = { editor: editor as unknown as Editor };

    hooks.onCreate.call(context);
    expect(submit).toHaveBeenCalledOnce();
    // Another client's steps land while the submit is in flight.
    version = 3;
    update();
    expect(query).not.toHaveBeenCalled();

    finishSubmit();
    await vi.waitFor(() =>
      expect(query).toHaveBeenCalledWith(syncApi.getSteps, {
        id: "doc",
        version: 2,
      }),
    );
    hooks.onDestroy.call(context);
  });

  test("the same version again retries a sync that failed", async () => {
    const errors: Error[] = [];
    const { onUpdate, update } = versionSubscription(() => 1);
    const submit = vi.fn(() => Promise.reject(new Error("offline")));
    const convex = { mutation: submit, onUpdate } as unknown as ConvexClient;
    const hooks = extensionWith(convex, (error) => errors.push(error))
      .config as unknown as Hooks;
    const editor = { state: typeText(stateAt(1, "me"), "hello") } as Editor;

    // The version the client already had is no reason to sync again.
    hooks.onCreate.call({ editor });
    await nextTask();
    expect(submit).toHaveBeenCalledOnce();

    // After a reconnect the client tells of every result again.
    update();
    expect(submit).toHaveBeenCalledTimes(2);
    await nextTask();
    expect(errors).toHaveLength(2);
  });

  test("the same version after a failed query syncs what changed meanwhile", async () => {
    let failed = false;
    const { onUpdate, update } = versionSubscription(() => {
      if (failed) throw new Error("not allowed");
      return 1;
    });
    const submit = vi.fn(async () => ({ status: "synced" as const }));
    const convex = { mutation: submit, onUpdate } as unknown as ConvexClient;
    const hooks = syncExtension(convex, "doc", syncApi, initialState, {
      onSyncError: () => {},
      snapshotDebounceMs: 1e6,
    }).config as unknown as Hooks;
    const editor = liveEditor(stateAt(1, "me"));
    const context = { editor: editor as unknown as Editor };

    // The query fails before the client has told of the version it had.
    hooks.onCreate.call(context);
    failed = true;
    update();
    editor.state = typeText(editor.state, "hello");
    hooks.onUpdate.call(context);
    expect(submit).not.toHaveBeenCalled();

    failed = false;
    update();
    await vi.waitFor(() =>
      expect(collab.sendableSteps(editor.state)).toBeNull(),
    );
    hooks.onDestroy.call(context);
  });

  test("an editor created while the query fails syncs when it recovers", async () => {
    let failed = false;
    const { onUpdate, update } = versionSubscription(() => {
      if (failed) throw new Error("not allowed");
      return 1;
    });
    const submit = vi.fn(async () => ({ status: "synced" as const }));
    const convex = { mutation: submit, onUpdate } as unknown as ConvexClient;
    // Two editors on one extension, as under React's StrictMode.
    const hooks = syncExtension(convex, "doc", syncApi, initialState, {
      onSyncError: () => {},
      snapshotDebounceMs: 1e6,
    }).config as unknown as Hooks;
    const first = {
      editor: liveEditor(stateAt(1, "one")) as unknown as Editor,
    };
    hooks.onCreate.call(first);
    await nextTask();
    failed = true;
    update();
    const editor = liveEditor(typeText(stateAt(1, "two"), "hello"));
    const second = { editor: editor as unknown as Editor };
    hooks.onCreate.call(second);
    await nextTask();
    expect(submit).not.toHaveBeenCalled();

    // The version is the one the first editor read, and news to the second.
    failed = false;
    update();
    await vi.waitFor(() =>
      expect(collab.sendableSteps(editor.state)).toBeNull(),
    );
    hooks.onDestroy.call(first);
    hooks.onDestroy.call(second);
  });
});

/**
 * A real `ConvexClient` with no server: its socket opens and records what the
 * client sends. With `missing`, it answers the version query with `null`, the
 * version of a document that does not exist.
 */
function clientOnRecordingSocket(missing = false) {
  const sent: string[] = [];
  const answer = JSON.stringify({
    type: "Transition",
    startVersion: { querySet: 0, identity: 0, ts: "AAAAAAAAAAA=" },
    endVersion: { querySet: 1, identity: 0, ts: "AAAAAAAAAAA=" },
    modifications: [
      {
        type: "QueryUpdated",
        queryId: 0,
        value: null,
        logLines: [],
        journal: null,
      },
    ],
  });
  class Socket {
    onopen?: () => void;
    onmessage?: (message: { data: string }) => void;
    constructor() {
      setTimeout(() => this.onopen?.(), 0);
    }
    send = (message: string) => {
      sent.push(message);
      if (missing && message.includes('"Add"')) {
        setTimeout(() => this.onmessage?.({ data: answer }), 0);
      }
    };
    close() {}
  }
  const convex = new ConvexClient("https://example.convex.cloud", {
    webSocketConstructor: Socket as unknown as typeof WebSocket,
  });
  return { convex, sent };
}

describe("a real ConvexClient", () => {
  test("subscribes and unsubscribes", async () => {
    const { convex, sent } = clientOnRecordingSocket();
    const hooks = extensionWith(convex, () => {}).config as unknown as {
      onCreate: (this: { editor: Editor }) => void;
      onDestroy: (this: { editor: Editor }) => void;
    };
    const context = { editor: { state: stateAt(1, "me") } as Editor };

    hooks.onCreate.call(context);
    await vi.waitFor(() => expect(sent.join()).toContain("latestVersion"));
    expect(sent.join()).not.toContain('"Remove"');
    hooks.onDestroy.call(context);
    expect(sent.join()).toContain('"Remove"');
    void convex.close();
  });

  test("starts one sync on a version it already has", async () => {
    const { convex } = clientOnRecordingSocket(true);
    // Another subscriber has the version before the editor is created.
    const told = vi.fn();
    convex.onUpdate(syncApi.latestVersion, { id: "doc" }, told);
    await vi.waitFor(() => expect(told).toHaveBeenCalled());
    const errors: Error[] = [];
    // At version 2 the document has to exist, so every sync fails.
    const hooks = syncExtension(
      convex,
      "doc",
      syncApi,
      { initialContent: { type: "doc", content: [] }, initialVersion: 2 },
      { onSyncError: (error) => errors.push(error) },
    ).config as unknown as { onCreate: (this: { editor: Editor }) => void };

    hooks.onCreate.call({ editor: { state: stateAt(2, "me") } as Editor });
    await nextTask();
    expect(errors).toHaveLength(1);
    void convex.close();
  });
});

describe("syncExtension from ./tiptap", () => {
  test("syncs through a ConvexReactClient", async () => {
    const errors: Error[] = [];
    const failure = new Error("not allowed");
    let readVersion = (): number => 1;
    let notify!: () => void;
    const unsubscribe = vi.fn();
    const submit = vi.fn(async (_args: SubmitStepsArgs) => ({
      status: "synced" as const,
    }));
    // The React client has `watchQuery`, where `ConvexClient` has `onUpdate`.
    const convex = {
      mutation: (_reference: unknown, args: SubmitStepsArgs) => submit(args),
      watchQuery: () => ({
        localQueryResult: () => readVersion(),
        onUpdate: (listener: () => void) => {
          notify = listener;
          return unsubscribe;
        },
      }),
    } as unknown as ConvexReactClient;
    const hooks = reactSyncExtension(
      convex,
      "doc",
      syncApi,
      { initialContent: { type: "doc", content: [] }, initialVersion: 1 },
      { onSyncError: (error) => errors.push(error), snapshotDebounceMs: 1e6 },
    ).config as unknown as {
      onCreate: (this: { editor: Editor }) => void;
      onDestroy: (this: { editor: Editor }) => void;
    };
    const editor = {
      state: typeText(stateAt(1, "me"), "hello"),
      schema,
      isDestroyed: false,
      view: {
        dispatch: (tr: Parameters<EditorState["apply"]>[0]) => {
          editor.state = editor.state.apply(tr);
        },
      },
    };
    const context = { editor: editor as unknown as Editor };

    // The version comes from the watch, so the local step is submitted.
    hooks.onCreate.call(context);
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(collab.sendableSteps(editor.state)).toBeNull(),
    );
    expect(errors).toEqual([]);

    // A failed query reaches `onSyncError` when the watch updates.
    readVersion = () => {
      throw failure;
    };
    notify();
    expect(errors).toEqual([failure]);

    hooks.onDestroy.call(context);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  const failure = new Error("not allowed");

  /**
   * An editor on a client whose version query had already failed: another
   * subscriber has the failed result, so the watch updates only on `notify`.
   */
  function editorOnFailedQuery(onSyncError: (error: Error) => void) {
    let notify!: () => void;
    const unsubscribe = vi.fn();
    const convex = {
      watchQuery: () => ({
        localQueryResult: () => {
          throw failure;
        },
        onUpdate: (listener: () => void) => {
          notify = listener;
          return unsubscribe;
        },
      }),
    } as unknown as ConvexReactClient;
    const hooks = reactSyncExtension(
      convex,
      "doc",
      syncApi,
      { initialContent: { type: "doc", content: [] }, initialVersion: 1 },
      { onSyncError },
    ).config as unknown as {
      onCreate: (this: { editor: Editor }) => void;
      onUpdate: (this: { editor: Editor }) => void;
      onDestroy: (this: { editor: Editor }) => void;
    };
    const context = { editor: { state: stateAt(1, "me") } as Editor };
    return { hooks, context, unsubscribe, notify: () => notify() };
  }

  test("reports a version query that had already failed, after onCreate", async () => {
    const errors: Error[] = [];
    const { hooks, context } = editorOnFailedQuery((error) =>
      errors.push(error),
    );

    hooks.onCreate.call(context);
    hooks.onUpdate.call(context);
    expect(errors).toEqual([]);
    await nextTask();
    expect(errors).toEqual([failure]);
  });

  test("does not repeat a failure that the watch reported first", async () => {
    const errors: Error[] = [];
    const { hooks, context, notify } = editorOnFailedQuery((error) =>
      errors.push(error),
    );

    hooks.onCreate.call(context);
    notify();
    expect(errors).toEqual([failure]);
    await nextTask();
    expect(errors).toEqual([failure]);
  });

  test("does not report to an editor that was destroyed first", async () => {
    const errors: Error[] = [];
    const { hooks, context } = editorOnFailedQuery((error) =>
      errors.push(error),
    );

    hooks.onCreate.call(context);
    hooks.onDestroy.call(context);
    await nextTask();
    expect(errors).toEqual([]);
  });

  test("an onSyncError that destroys the editor leaves nothing behind", async () => {
    const beforeUnload = new Set<unknown>();
    vi.stubGlobal("window", {
      addEventListener: (_type: string, listener: unknown) =>
        beforeUnload.add(listener),
      removeEventListener: (_type: string, listener: unknown) =>
        beforeUnload.delete(listener),
    });
    // The app gives up on the editor when the sync fails.
    let giveUp = () => {};
    const { hooks, context, unsubscribe } = editorOnFailedQuery(() => giveUp());
    giveUp = () => hooks.onDestroy.call(context);

    hooks.onCreate.call(context);
    await nextTask();
    vi.unstubAllGlobals();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(beforeUnload.size).toBe(0);
  });
});

describe("a version the client already has", () => {
  type Submit = () => Promise<never>;
  type OnSyncError = (error: Error) => void;
  const clients: [string, (s: Submit, e: OnSyncError) => AnyExtension][] = [
    [
      "ConvexClient",
      (mutation, onSyncError) => {
        const { onUpdate } = versionSubscription(() => 1);
        const convex = { mutation, onUpdate } as unknown as ConvexClient;
        return extensionWith(convex, onSyncError);
      },
    ],
    [
      "ConvexReactClient",
      (mutation, onSyncError) => {
        // Another subscriber has the version, so the watch never updates.
        const watch = { localQueryResult: () => 1, onUpdate: () => vi.fn() };
        const convex = { mutation, watchQuery: () => watch };
        return reactSyncExtension(
          convex as unknown as ConvexReactClient,
          "doc",
          syncApi,
          { initialContent: { type: "doc", content: [] }, initialVersion: 1 },
          { onSyncError },
        );
      },
    ],
  ];

  // The submit fails, so a second sync would submit, and fail, again.
  const offline = new Error("offline");

  test.each(clients)("starts one sync on a %s", async (_client, extension) => {
    const errors: Error[] = [];
    const submit = vi.fn(() => Promise.reject(offline));
    const hooks = extension(submit, (error) => errors.push(error))
      .config as unknown as { onCreate: (this: { editor: Editor }) => void };
    const editor = { state: typeText(stateAt(1, "me"), "hello") } as Editor;

    // The sync starts with the editor, and being told of the version on a
    // later task does not start another.
    hooks.onCreate.call({ editor });
    expect(submit).toHaveBeenCalledOnce();
    await nextTask();
    expect(submit).toHaveBeenCalledOnce();
    expect(errors).toEqual([offline]);
  });

  test.each(clients)(
    "syncs a change made in the task of create once on a %s",
    async (_client, extension) => {
      const errors: Error[] = [];
      const submit = vi.fn(() => Promise.reject(offline));
      const hooks = extension(submit, (error) => errors.push(error))
        .config as unknown as {
        onCreate: (this: { editor: Editor }) => void;
        onUpdate: (this: { editor: Editor }) => void;
      };
      const editor = { state: stateAt(1, "me") };
      const context = { editor: editor as Editor };

      hooks.onCreate.call(context);
      editor.state = typeText(editor.state, "hello");
      hooks.onUpdate.call(context);
      await nextTask();
      expect(submit).toHaveBeenCalledOnce();
      expect(errors).toEqual([offline]);
    },
  );
});
