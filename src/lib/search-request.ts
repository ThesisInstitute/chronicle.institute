// The search page's request for one query. It waits for a pause in typing,
// runs against a deadline, and is cancelled outright when the query changes or
// the page goes away. A stalled request ends in the error state at the
// deadline instead of leaving the page waiting for the next keystroke, and a
// superseded request is aborted rather than left running and ignored.
//
// startSearch has the shape of a React effect (it returns the cleanup), which
// is how the page runs it: React's effect cleanup is what cancels the old
// query's request when a new one starts.

import type { SearchDoc } from "./search";
import {
  FetchNetworkError,
  FetchStatusError,
  FetchTimeoutError,
  fetchJson,
  type FetchLike,
} from "./verify/fetch";

/**
 * Search answers from an in-memory index in milliseconds, so a request still
 * open after ten seconds has stalled; it is not a slow search worth waiting
 * thirty seconds for, as the verifier's large files are.
 */
export const SEARCH_TIMEOUT_MS = 10_000;

/** The pause in typing before a request goes out. */
export const SEARCH_DEBOUNCE_MS = 150;

export type SearchHit = Omit<SearchDoc, "haystack">;

export interface SearchState {
  /** The last results that arrived; kept on screen while a new query runs. */
  results: SearchHit[];
  /** The current query's request is waiting on the pause or in flight. */
  pending: boolean;
  /** Why the current query's request failed. */
  error: string | null;
}

export const IDLE_SEARCH: SearchState = {
  results: [],
  pending: false,
  error: null,
};

/** React's state setter, called only with an updater. */
export type SearchUpdate = (next: (prev: SearchState) => SearchState) => void;

export interface SearchOptions {
  debounceMs?: number;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

export function searchPath(query: string): string {
  return `/api/search?q=${encodeURIComponent(query)}`;
}

/** What the page says after "Search failed:". */
export function searchErrorMessage(e: unknown): string {
  if (e instanceof FetchTimeoutError) {
    return `no response within ${e.timeoutMs / 1000} s`;
  }
  if (e instanceof FetchStatusError) {
    return `the server answered HTTP ${e.status}`;
  }
  // The browser's own words ("Failed to fetch", a JSON parse error), without
  // the request path, which here is only the query the reader just typed.
  if (e instanceof FetchNetworkError) {
    return e.cause instanceof Error ? e.cause.message : String(e.cause);
  }
  return e instanceof Error ? e.message : String(e);
}

function hits(data: unknown): SearchHit[] {
  const results = (data as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) {
    throw new Error("the server sent an unexpected response");
  }
  return results as SearchHit[];
}

/**
 * Start the search for `query` and return the function that cancels it.
 *
 * A blank query is idle at once and sends nothing. Otherwise the state goes
 * pending (clearing any earlier error, keeping the earlier results on screen),
 * and after `debounceMs` one request goes out for the trimmed query. It
 * settles to the results, or to an error with no results, at most `timeoutMs`
 * after it was sent. Cancelling clears the pause, aborts the request, and
 * guarantees `update` is never called again by this search.
 */
export function startSearch(
  query: string,
  update: SearchUpdate,
  {
    debounceMs = SEARCH_DEBOUNCE_MS,
    timeoutMs = SEARCH_TIMEOUT_MS,
    fetchImpl,
  }: SearchOptions = {},
): () => void {
  const q = query.trim();
  if (!q) {
    update(() => IDLE_SEARCH);
    return () => {};
  }
  update((prev) => ({ ...prev, pending: true, error: null }));
  const controller = new AbortController();
  const { signal } = controller;
  const pause = setTimeout(async () => {
    let settled: SearchState;
    try {
      const data = await fetchJson<unknown>(searchPath(q), {
        timeoutMs,
        fetchImpl,
        signal,
      });
      settled = { results: hits(data), pending: false, error: null };
    } catch (e) {
      settled = { results: [], pending: false, error: searchErrorMessage(e) };
    }
    // Cancelling rejects the request at once, but this also covers a cancel
    // that lands after the response arrived and before this line ran.
    if (!signal.aborted) update(() => settled);
  }, debounceMs);
  return () => {
    clearTimeout(pause);
    controller.abort();
  };
}
