/**
 * Read-only library listing helpers (feed/v3 filters).
 *
 * Filter names mirror the Suno web client (public bundle, captured 2026-11): `liked: 'True'`,
 * `searchText`, `workspace: { presence, workspaceId }`, `playlist: { presence, playlistId }`.
 * Pagination is cursor based (`next_cursor`), not page-number based.
 */

export const LIBRARY_DEFAULT_LIMIT = 20;
export const LIBRARY_MAX_LIMIT = 50;
export const LIBRARY_MAX_SEARCH_LENGTH = 200;
const ID = /^[0-9a-zA-Z][0-9a-zA-Z_-]{0,127}$/;

export type LibraryFeedOptions = {
  workspaceId?: string | null;
  playlistId?: string | null;
  searchText?: string | null;
  liked?: boolean;
  cursor?: string | null;
  limit?: number;
};

export type LibraryFeedRequest = {
  cursor: string | null;
  limit: number;
  filters: Record<string, unknown>;
};

const bad = (message: string) => Object.assign(new Error(message), { status: 400 });

/** Validates user input and builds the feed/v3 request body. Workspace and playlist are mutually exclusive. */
export function buildLibraryFeedRequest(options: LibraryFeedOptions): LibraryFeedRequest {
  const workspaceId = options.workspaceId?.trim() || null;
  const playlistId = options.playlistId?.trim() || null;
  if (workspaceId && playlistId) throw bad('workspace_id and playlist_id are mutually exclusive');
  if (workspaceId && !ID.test(workspaceId)) throw bad('Invalid workspace_id');
  if (playlistId && !ID.test(playlistId)) throw bad('Invalid playlist_id');

  const searchText = (options.searchText ?? '').trim();
  if (searchText.length > LIBRARY_MAX_SEARCH_LENGTH) throw bad('q is too long');

  const rawLimit = options.limit ?? LIBRARY_DEFAULT_LIMIT;
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > LIBRARY_MAX_LIMIT)
    throw bad(`limit must be an integer from 1 to ${LIBRARY_MAX_LIMIT}`);

  const cursor = options.cursor?.trim() || null;
  if (cursor && cursor.length > 2048) throw bad('Invalid cursor');

  const filters: Record<string, unknown> = {
    disliked: 'False',
    trashed: 'False',
    fromStudioProject: { presence: 'False' },
    stem: { presence: 'False' },
    stemComplement: 'False',
    // Without a scope the listing is the default workspace, like /api/get.
    ...(playlistId
      ? { playlist: { presence: 'True', playlistId } }
      : { workspace: { presence: 'True', workspaceId: workspaceId || 'default' } }),
    ...(options.liked ? { liked: 'True' } : {}),
    ...(searchText ? { searchText } : {}),
  };
  return { cursor, limit: rawLimit, filters };
}
