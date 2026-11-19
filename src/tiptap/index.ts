import {
  type ConvexReactClient,
  useConvex,
  useMutation,
  useQuery,
} from "convex/react";
import type { AnyExtension, Content, JSONContent } from "@tiptap/core";
import { useCallback, useMemo, useRef } from "react";
import type { SyncApi } from "../client/index.js";
import {
  type InitialState,
  type UseSyncOptions,
  syncExtension as syncExtensionCore,
} from "./core.js";

export type { UseSyncOptions } from "./core.js";

export function useTiptapSync(
  syncApi: SyncApi,
  id: string,
  opts?: UseSyncOptions,
) {
  const log: typeof console.log = opts?.debug ? console.debug : () => {};
  const convex = useConvex();
  const initial = useInitialState(syncApi, id);
  const extension: AnyExtension | null = useMemo(() => {
    const { loading, ...initialState } = initial;
    if (loading || !initialState.initialContent) return null;
    return syncExtension(convex, id, syncApi, initialState, opts);
    // // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convex, id, initial.loading, initial.initialContent]);
  const submitSnapshot = useMutation(
    syncApi.submitSnapshot,
  ).withOptimisticUpdate((localQueryStore, args) => {
    // This update will allow the useInitialState to respond immediately to
    // creating documents, as if it came from the server.
    const existing = localQueryStore.getQuery(syncApi.getSnapshot, { id });
    if (!existing?.content) {
      localQueryStore.setQuery(
        syncApi.getSnapshot,
        { id },
        {
          version: args.version,
          content: args.content,
        },
      );
    }
    const version = localQueryStore.getQuery(syncApi.latestVersion, { id });
    if (version === null) {
      localQueryStore.setQuery(syncApi.latestVersion, { id }, args.version);
    }
  });
  const create = useCallback(
    async (content: JSONContent) => {
      log("Creating new document", { id });
      await submitSnapshot({
        id,
        version: 1,
        content: JSON.stringify(content),
      });
    },
    [convex, id],
  );
  if (initial.loading) {
    return {
      extension: null,
      isLoading: true,
      initialContent: null,
      /**
       * Create the document without waiting to hear from the server.
       * Warning: Only call this if you just created the document id.
       * It's safer to wait until loading is false.
       * It's also best practice to pass in the same initial content everywhere,
       * so if two clients create the same document id, they'll both end up
       * with the same initial content. Otherwise the second client will
       * throw an exception on the snapshot creation.
       */
      create,
    } as const;
  }
  if (!initial.initialContent) {
    return {
      extension: null,
      isLoading: false,
      initialContent: null,
      create,
    } as const;
  }
  return {
    extension: extension!,
    isLoading: false,
    initialContent: initial.initialContent,
  } as const;
}

/**
 * The sync extension for a `ConvexReactClient`. It adapts the client to the
 * `ConvexClient` methods that `syncExtension` in `./core.js` calls.
 */
export function syncExtension(
  convex: ConvexReactClient,
  id: string,
  syncApi: SyncApi,
  initialState: InitialState,
  opts?: UseSyncOptions,
): AnyExtension {
  return syncExtensionCore(
    {
      query: (query, args) => convex.query(query, args),
      mutation: (mutation, args) => convex.mutation(mutation, args),
      onUpdate: (query, args, callback, onError) => {
        const watch = convex.watchQuery(query, args);
        const notify = () => {
          let result;
          try {
            result = watch.localQueryResult();
          } catch (error) {
            return onError?.(error as Error);
          }
          if (result !== undefined) callback(result);
        };
        const unsubscribe = watch.onUpdate(notify);
        // `ConvexClient` tells a new listener the result it already has. The
        // watch only tells of changes, so do that here.
        notify();
        return Object.assign(unsubscribe, {
          unsubscribe,
          getCurrentValue: () => watch.localQueryResult(),
        });
      },
    },
    id,
    syncApi,
    initialState,
    opts,
  );
}

export function useInitialState(
  syncApi: SyncApi,
  id: string,
  cacheKeyPrefix?: string,
) {
  const serverRef = useRef<{
    id: string;
    snapshot?: InitialState;
  }>({ id });
  const cachedState = useMemo(() => {
    return getCachedState(id, cacheKeyPrefix);
  }, [id, cacheKeyPrefix]);
  const serverInitial = useQuery(
    syncApi.getSnapshot,
    serverRef.current.snapshot && serverRef.current.id === id ? "skip" : { id },
  );
  const snapshot = useMemo(() => {
    return (
      serverInitial &&
      serverInitial.content !== null && {
        initialContent: JSON.parse(serverInitial.content) as Content,
        initialVersion: serverInitial.version,
      }
    );
  }, [serverInitial]);
  if (snapshot || serverRef.current.id !== id) {
    serverRef.current = { id, snapshot: snapshot || undefined };
  }
  const data = serverRef.current.snapshot || cachedState;

  if (data) {
    return {
      loading: false,
      ...data,
    };
  }
  if (!cachedState && serverInitial?.content === null) {
    // We couldn't find it locally or on the server.
    // We could dynamically create a new document here,
    // not sure if that's generally the right pattern (vs. explicit creation).
    return {
      loading: false,
      initialContent: null,
    };
  }
  return {
    loading: true,
  };
}

function getCachedState(
  id: string,
  cacheKeyPrefix?: string,
): InitialState | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  // TODO: Verify that this works
  const cacheKey = `${cacheKeyPrefix ?? "convex-sync"}-${id}`;
  const cache = sessionStorage.getItem(cacheKey);
  if (cache) {
    const { content, version, steps } = JSON.parse(cache);
    return {
      initialContent: content as Content,
      initialVersion: Number(version),
      restoredSteps: (steps ?? []) as object[],
    };
  }
}
