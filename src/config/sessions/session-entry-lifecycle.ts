import { getRuntimeConfig } from "../io.js";
import { resolveStorePath } from "./paths.js";
import {
  archiveRemovedSessionTranscripts,
  loadSessionStore,
  resolveSessionStoreEntry,
  updateSessionStore,
} from "./store.js";
import {
  mergeSessionEntry,
  mergeSessionEntryPreserveActivity,
  type SessionEntry,
} from "./types.js";

export type SessionEntryLifecycleScope = {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  storePath?: string;
};

export type SessionEntryLifecycleContext = {
  entry: SessionEntry;
  sessionKey: string;
};

export type SessionEntryLifecyclePatchOptions = {
  fallbackEntry?: SessionEntry;
  preserveActivity?: boolean;
  replaceEntry?: boolean;
  skipMaintenance?: boolean;
  takeCacheOwnership?: boolean;
};

export type SessionEntryLifecycleDeleteOptions = {
  skipMaintenance?: boolean;
  takeCacheOwnership?: boolean;
};

export type SessionEntriesPatchResult = {
  patched: Array<{ sessionKey: string; entry: SessionEntry }>;
};

export type SessionEntriesDeleteResult = {
  deleted: Array<{ sessionKey: string; entry: SessionEntry }>;
  referencedSessionIds: Set<string>;
  removedSessionFiles: Map<string, string | undefined>;
};

/** Patches one session entry through the lifecycle mutation seam. */
export async function patchSessionLifecycleEntry(
  scope: SessionEntryLifecycleScope & { sessionKey: string },
  update: (
    entry: SessionEntry,
    context: { existingEntry?: SessionEntry; sessionKey: string },
  ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null,
  options: SessionEntryLifecyclePatchOptions = {},
): Promise<SessionEntry | null> {
  const result = await updateSessionStore(
    resolveLifecycleStorePath(scope),
    async (store) => {
      const resolved = resolveSessionStoreEntry({ store, sessionKey: scope.sessionKey });
      const existing = resolved.existing ?? options.fallbackEntry;
      if (!existing) {
        return { changed: false, entry: null };
      }
      const patch = await update(structuredClone(existing), {
        existingEntry: resolved.existing ? structuredClone(resolved.existing) : undefined,
        sessionKey: resolved.normalizedKey,
      });
      if (!patch) {
        return {
          changed: false,
          entry: resolved.existing ? structuredClone(resolved.existing) : null,
        };
      }
      const next = options.replaceEntry
        ? structuredClone(patch as SessionEntry)
        : options.preserveActivity
          ? mergeSessionEntryPreserveActivity(existing, patch)
          : mergeSessionEntry(existing, patch);
      store[resolved.normalizedKey] = next;
      for (const legacyKey of resolved.legacyKeys) {
        delete store[legacyKey];
      }
      return { changed: true, entry: next };
    },
    {
      skipMaintenance: options.skipMaintenance,
      skipSaveWhenResult: (entry) => !entry.changed,
      takeCacheOwnership: options.takeCacheOwnership,
    },
  );
  return result.entry;
}

/** Patches zero or more session entries through the lifecycle mutation seam. */
export async function patchSessionEntries(
  scope: SessionEntryLifecycleScope,
  update: (
    entry: SessionEntry,
    context: SessionEntryLifecycleContext,
  ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null,
  options: SessionEntryLifecyclePatchOptions = {},
): Promise<SessionEntriesPatchResult> {
  return await updateSessionStore(
    resolveLifecycleStorePath(scope),
    async (store) => {
      const patched: SessionEntriesPatchResult["patched"] = [];
      for (const [sessionKey, entry] of Object.entries(store)) {
        if (!entry) {
          continue;
        }
        const entrySnapshot = structuredClone(entry);
        const patch = await update(structuredClone(entry), {
          entry: entrySnapshot,
          sessionKey,
        });
        if (!patch) {
          continue;
        }
        const next = options.replaceEntry
          ? structuredClone(patch as SessionEntry)
          : options.preserveActivity
            ? mergeSessionEntryPreserveActivity(entry, patch)
            : mergeSessionEntry(entry, patch);
        store[sessionKey] = next;
        patched.push({ sessionKey, entry: next });
      }
      return { patched };
    },
    {
      skipMaintenance: options.skipMaintenance,
      skipSaveWhenResult: (result) => result.patched.length === 0,
      takeCacheOwnership: options.takeCacheOwnership,
    },
  );
}

/** Deletes session entries through the lifecycle mutation seam. */
export async function deleteSessionEntries(
  scope: SessionEntryLifecycleScope,
  shouldDelete: (
    entry: SessionEntry,
    context: SessionEntryLifecycleContext,
  ) => Promise<boolean> | boolean,
  options: SessionEntryLifecycleDeleteOptions = {},
): Promise<SessionEntriesDeleteResult> {
  const storePath = resolveLifecycleStorePath(scope);
  const deletion = await updateSessionStore(
    storePath,
    async (store) => {
      const deleted: SessionEntriesDeleteResult["deleted"] = [];
      const removedSessionFiles = new Map<string, string | undefined>();
      for (const [sessionKey, entry] of Object.entries(store)) {
        if (!entry) {
          continue;
        }
        const entrySnapshot = structuredClone(entry);
        if (!(await shouldDelete(entrySnapshot, { entry: entrySnapshot, sessionKey }))) {
          continue;
        }
        rememberRemovedSessionFile(removedSessionFiles, entry);
        deleted.push({ sessionKey, entry });
        delete store[sessionKey];
      }
      return {
        deleted,
        referencedSessionIds: collectReferencedSessionIds(store),
        removedSessionFiles,
      };
    },
    {
      skipMaintenance: options.skipMaintenance,
      skipSaveWhenResult: (result) => result.deleted.length === 0,
      takeCacheOwnership: options.takeCacheOwnership,
    },
  );
  if (deletion.deleted.length === 0) {
    return deletion;
  }
  const persistedStore = loadSessionStore(storePath, { skipCache: true });
  return {
    ...deletion,
    referencedSessionIds: collectReferencedSessionIds(persistedStore),
  };
}

/** Archives transcript artifacts for entries removed by deleteSessionEntries. */
export async function archiveDeletedSessionEntryArtifacts(params: {
  deletion: SessionEntriesDeleteResult;
  reason: "deleted" | "reset";
  restrictToStoreDir?: boolean;
  storePath: string;
}): Promise<Set<string>> {
  return await archiveRemovedSessionTranscripts({
    removedSessionFiles: params.deletion.removedSessionFiles,
    referencedSessionIds: params.deletion.referencedSessionIds,
    storePath: params.storePath,
    reason: params.reason,
    restrictToStoreDir: params.restrictToStoreDir,
  });
}

function resolveLifecycleStorePath(scope: SessionEntryLifecycleScope): string {
  if (scope.storePath) {
    return scope.storePath;
  }
  return resolveStorePath(getRuntimeConfig().session?.store, {
    agentId: scope.agentId,
    env: scope.env,
  });
}

function collectReferencedSessionIds(store: Record<string, SessionEntry>): Set<string> {
  return new Set(
    Object.values(store)
      .map((entry) => entry?.sessionId)
      .filter((sessionId): sessionId is string => Boolean(sessionId)),
  );
}

function rememberRemovedSessionFile(
  removedSessionFiles: Map<string, string | undefined>,
  entry: SessionEntry,
): void {
  if (!removedSessionFiles.has(entry.sessionId) || entry.sessionFile) {
    removedSessionFiles.set(entry.sessionId, entry.sessionFile);
  }
}
