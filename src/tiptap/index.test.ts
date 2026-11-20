/// <reference types="vite/client" />

import { webcrypto as crypto } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { convexTest, type TestConvex } from "convex-test";
import type { ConvexClient } from "convex/browser";
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
      const unsubscribe = vi.fn();
      const submitSnapshot = vi.fn();
      const convex = {
        mutation: (reference: SyncApi["submitSteps"], args: SubmitStepsArgs) =>
          getFunctionName(reference) === getFunctionName(syncApi.submitSteps)
            ? submit(args)
            : submitSnapshot(args),
        onUpdate: () => ({ getCurrentValue: () => 1, unsubscribe }),
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
    let reportError!: (error: Error) => void;
    const convex = {
      onUpdate: (...args: unknown[]) => {
        reportError = args[3] as typeof reportError;
        return {
          getCurrentValue: () => {
            throw failure;
          },
          unsubscribe: vi.fn(),
        };
      },
    } as unknown as ConvexClient;
    const hooks = extensionWith(convex, (error) => errors.push(error))
      .config as unknown as {
      onCreate: (this: { editor: Editor }) => void;
      onUpdate: (this: { editor: Editor }) => void;
    };
    const context = { editor: { state: stateAt(1, "me") } as Editor };

    // The first sync and a local edit read the failed query without
    // reporting it or rejecting.
    hooks.onCreate.call(context);
    hooks.onUpdate.call(context);
    // Give a rejected sync the time to surface as an unhandled rejection.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toEqual([]);

    // The subscription reports it, and later edits don't repeat it.
    reportError(denied);
    hooks.onUpdate.call(context);
    expect(errors).toEqual([denied]);

    // The next failed result is reported too.
    failure = gone;
    reportError(gone);
    hooks.onUpdate.call(context);
    expect(errors).toEqual([denied, gone]);
  });

  test("leaves a failed version query unhandled when there is no onSyncError", async () => {
    const failure = new Error("not allowed");
    let reportError!: (error: Error) => void;
    const convex = {
      onUpdate: (...args: unknown[]) => {
        reportError = args[3] as typeof reportError;
        return {
          getCurrentValue: () => {
            throw failure;
          },
          unsubscribe: vi.fn(),
        };
      },
    } as unknown as ConvexClient;
    const hooks = syncExtension(convex, "doc", syncApi, {
      initialContent: { type: "doc", content: [] },
      initialVersion: 1,
    }).config as unknown as {
      onCreate: (this: { editor: Editor }) => void;
      onUpdate: (this: { editor: Editor }) => void;
    };
    const context = { editor: { state: stateAt(1, "me") } as Editor };

    // The sync has stopped, so the app hears of it once, not on every edit.
    const unhandled = await unhandledRejections(() => {
      hooks.onCreate.call(context);
      reportError(failure);
      hooks.onUpdate.call(context);
    });
    expect(unhandled).toEqual([failure]);
  });

  test("keeps an onSyncError that throws out of the client's update loop", async () => {
    const failure = new Error("not allowed");
    const bug = new Error("the handler threw");
    let reportError!: (error: Error) => void;
    const convex = {
      onUpdate: (...args: unknown[]) => {
        reportError = args[3] as typeof reportError;
        return { getCurrentValue: () => undefined, unsubscribe: vi.fn() };
      },
    } as unknown as ConvexClient;
    const hooks = extensionWith(convex, () => {
      throw bug;
    }).config as unknown as { onCreate: (this: { editor: Editor }) => void };

    const unhandled = await unhandledRejections(() => {
      hooks.onCreate.call({ editor: { state: stateAt(1, "me") } as Editor });
      expect(() => reportError(failure)).not.toThrow();
    });
    expect(unhandled).toEqual([bug]);
  });
});

/**
 * Runs `act` and returns the rejections it left unhandled, which would
 * otherwise fail the test run.
 */
async function unhandledRejections(act: () => void) {
  const listeners = process.listeners("unhandledRejection");
  process.removeAllListeners("unhandledRejection");
  const reasons: unknown[] = [];
  process.on("unhandledRejection", (reason) => reasons.push(reason));
  try {
    act();
    await new Promise((resolve) => setTimeout(resolve, 0));
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
    let notify!: () => void;
    const submit = vi.fn(async (_args: SubmitStepsArgs) => ({
      status: "synced" as const,
    }));
    const convex = {
      mutation: (_reference: unknown, args: SubmitStepsArgs) => submit(args),
      onUpdate: (...args: unknown[]) => {
        notify = args[2] as typeof notify;
        return { getCurrentValue: () => readVersion(), unsubscribe: vi.fn() };
      },
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
    expect(submit).not.toHaveBeenCalled();

    readVersion = () => 1;
    notify();
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

  test("reports a version query that had already failed", async () => {
    const errors: Error[] = [];
    const failure = new Error("not allowed");
    // Another subscriber has the failed result, so the watch never updates.
    const convex = {
      watchQuery: () => ({
        localQueryResult: () => {
          throw failure;
        },
        onUpdate: () => vi.fn(),
      }),
    } as unknown as ConvexReactClient;
    const hooks = reactSyncExtension(
      convex,
      "doc",
      syncApi,
      { initialContent: { type: "doc", content: [] }, initialVersion: 1 },
      { onSyncError: (error) => errors.push(error) },
    ).config as unknown as {
      onCreate: (this: { editor: Editor }) => void;
      onUpdate: (this: { editor: Editor }) => void;
    };
    const context = { editor: { state: stateAt(1, "me") } as Editor };

    hooks.onCreate.call(context);
    hooks.onUpdate.call(context);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toEqual([failure]);
  });
});
