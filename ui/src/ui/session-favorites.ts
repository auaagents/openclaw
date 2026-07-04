// Shared helpers for durable session favorites in Control UI.
import type { LocalFavoriteSession, UiSettings } from "./storage.ts";
import { normalizeFavoriteSessions } from "./storage.ts";
import { normalizeOptionalString } from "./string-coerce.ts";
import type { GatewaySessionRow } from "./types.ts";

export type SessionFavoritePatch = {
  permanentFavorite: boolean;
  favoriteOrder: number | null;
};

function validFavoriteOrder(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function findLocalFavoriteSession(
  favorites: readonly LocalFavoriteSession[] | undefined,
  key: string,
): LocalFavoriteSession | null {
  const normalizedKey = normalizeOptionalString(key);
  if (!normalizedKey) {
    return null;
  }
  return normalizeFavoriteSessions(favorites).find((entry) => entry.key === normalizedKey) ?? null;
}

export function isFavoriteSession(
  row: GatewaySessionRow,
  favorites: readonly LocalFavoriteSession[] | undefined,
): boolean {
  return row.permanentFavorite === true || Boolean(findLocalFavoriteSession(favorites, row.key));
}

export function resolveFavoriteOrder(
  row: GatewaySessionRow,
  favorites: readonly LocalFavoriteSession[] | undefined,
): number | null {
  return (
    validFavoriteOrder(row.favoriteOrder) ??
    validFavoriteOrder(findLocalFavoriteSession(favorites, row.key)?.favoriteOrder)
  );
}

export function compareFavoriteSessions(
  a: GatewaySessionRow,
  b: GatewaySessionRow,
  favorites: readonly LocalFavoriteSession[] | undefined,
): number {
  const orderA = resolveFavoriteOrder(a, favorites) ?? Number.MAX_SAFE_INTEGER;
  const orderB = resolveFavoriteOrder(b, favorites) ?? Number.MAX_SAFE_INTEGER;
  const orderDelta = orderA - orderB;
  if (orderDelta !== 0) {
    return orderDelta;
  }
  const updatedDelta = (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  if (updatedDelta !== 0) {
    return updatedDelta;
  }
  return a.key.localeCompare(b.key);
}

export function buildSessionFavoritePatch(
  row: GatewaySessionRow,
  favorites: readonly LocalFavoriteSession[] | undefined,
): SessionFavoritePatch {
  const nextFavorite = !isFavoriteSession(row, favorites);
  return {
    permanentFavorite: nextFavorite,
    favoriteOrder: nextFavorite ? (resolveFavoriteOrder(row, favorites) ?? Date.now()) : null,
  };
}

function localFavoriteSessionFromRow(
  row: GatewaySessionRow,
  favoriteOrder: number | null,
): LocalFavoriteSession {
  const label = normalizeOptionalString(row.label);
  const displayName = normalizeOptionalString(row.displayName);
  return {
    key: row.key,
    kind: row.kind,
    ...(label ? { label } : {}),
    ...(displayName ? { displayName } : {}),
    ...(favoriteOrder != null ? { favoriteOrder } : {}),
    ...(row.updatedAt != null ? { updatedAt: row.updatedAt } : {}),
  };
}

export function applyLocalFavoritePatch(
  settings: UiSettings,
  row: GatewaySessionRow,
  patch: SessionFavoritePatch,
): UiSettings {
  const favorites = normalizeFavoriteSessions(settings.favoriteSessions);
  const withoutRow = favorites.filter((entry) => entry.key !== row.key);
  if (!patch.permanentFavorite) {
    return { ...settings, favoriteSessions: withoutRow };
  }
  const entry = localFavoriteSessionFromRow(row, patch.favoriteOrder);
  return {
    ...settings,
    favoriteSessions: [...withoutRow, entry].toSorted((a, b) => {
      const orderA = validFavoriteOrder(a.favoriteOrder) ?? Number.MAX_SAFE_INTEGER;
      const orderB = validFavoriteOrder(b.favoriteOrder) ?? Number.MAX_SAFE_INTEGER;
      const orderDelta = orderA - orderB;
      if (orderDelta !== 0) {
        return orderDelta;
      }
      return a.key.localeCompare(b.key);
    }),
  };
}

export function rowFromLocalFavoriteSession(
  entry: LocalFavoriteSession,
  backingRow?: GatewaySessionRow,
): GatewaySessionRow {
  const favoriteOrder =
    validFavoriteOrder(backingRow?.favoriteOrder) ?? validFavoriteOrder(entry.favoriteOrder);
  const label = normalizeOptionalString(backingRow?.label ?? entry.label);
  const displayName = normalizeOptionalString(backingRow?.displayName ?? entry.displayName);
  return {
    ...(backingRow ?? {}),
    key: entry.key,
    kind: entry.kind ?? backingRow?.kind ?? "direct",
    ...(label ? { label } : {}),
    ...(displayName ? { displayName } : {}),
    permanentFavorite: true,
    ...(favoriteOrder != null ? { favoriteOrder } : {}),
    updatedAt: backingRow?.updatedAt ?? entry.updatedAt ?? null,
  };
}
