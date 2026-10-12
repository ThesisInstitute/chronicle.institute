// Every request the browser verifier makes is bounded, and so is every search
// request (src/lib/search-request.ts). A stalled server or a dropped
// connection must end in a visible error — never a spinner that waits
// forever, and never a check reported as FAILED because a file did not arrive
// in time. The deadline covers the whole exchange (headers and body) and
// aborts the underlying request when it passes.

import type { ChainInputs } from "./chain";

export const FETCH_TIMEOUT_MS = 30_000;

export class FetchTimeoutError extends Error {
  constructor(
    readonly path: string,
    readonly timeoutMs: number,
  ) {
    super(`${path}: no complete response within ${timeoutMs / 1000} s`);
    this.name = "FetchTimeoutError";
  }
}

export class FetchStatusError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
  ) {
    super(`${path}: HTTP ${status}`);
    this.name = "FetchStatusError";
  }
}

/**
 * The request failed outright (network, unparseable body). The browser's own
 * message does not say which file; this prefixes the path that failed.
 */
export class FetchNetworkError extends Error {
  constructor(
    readonly path: string,
    cause: unknown,
  ) {
    super(`${path}: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
    this.name = "FetchNetworkError";
  }
}

export type FetchLike = (
  input: string,
  init: { signal: AbortSignal },
) => Promise<Response>;

export interface FetchOptions {
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  /**
   * The caller's own cancellation. When it aborts, the call rejects at once
   * with the signal's reason, as `fetch` does, and the request is aborted.
   */
  signal?: AbortSignal;
}

const globalFetch: FetchLike = (input, init) => fetch(input, init);

/**
 * Fetch `path` and read its body with `read`, settling within `timeoutMs`,
 * or as soon as the caller's `signal` aborts if that comes first.
 *
 * The race against the deadline, not the abort alone, is what guarantees the
 * bound: an implementation that ignores the signal still cannot hold the
 * caller past the deadline. The abort is what cancels the request itself.
 * The caller's abort is raced the same way.
 */
export async function fetchWithTimeout<T>(
  path: string,
  read: (res: Response) => Promise<T>,
  {
    timeoutMs = FETCH_TIMEOUT_MS,
    fetchImpl = globalFetch,
    signal,
  }: FetchOptions = {},
): Promise<T> {
  if (signal?.aborted) throw signal.reason;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  // Each way of ending early settles the call before aborting the request, so
  // the abort's own rejection can never be what the caller sees.
  const cutoff = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new FetchTimeoutError(path, timeoutMs);
      reject(error);
      controller.abort(error);
    }, timeoutMs);
    if (signal) {
      onAbort = () => {
        reject(signal.reason);
        controller.abort(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  const exchange = (async () => {
    const res = await fetchImpl(path, { signal: controller.signal });
    if (!res.ok) throw new FetchStatusError(path, res.status);
    return read(res);
  })().catch((e: unknown) => {
    if (e instanceof FetchStatusError) throw e;
    throw new FetchNetworkError(path, e);
  });
  try {
    return await Promise.race([exchange, cutoff]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

export function fetchBytes(
  path: string,
  options?: FetchOptions,
): Promise<Uint8Array> {
  return fetchWithTimeout(
    path,
    async (res) => new Uint8Array(await res.arrayBuffer()),
    options,
  );
}

export function fetchJson<T>(path: string, options?: FetchOptions): Promise<T> {
  return fetchWithTimeout(path, (res) => res.json() as Promise<T>, options);
}

/**
 * A release file the chain may legitimately lack. Only the server's own 404
 * means "absent" (the verifier then reports it missing); a timeout, a server
 * error, or a network failure propagates, so an unreachable file is never
 * reported as a missing one.
 */
export async function fetchOptionalBytes(
  path: string,
  options?: FetchOptions,
): Promise<Uint8Array | null> {
  try {
    return await fetchBytes(path, options);
  } catch (e) {
    if (e instanceof FetchStatusError && e.status === 404) return null;
    throw e;
  }
}

export type VerifierInputs = Omit<ChainInputs, "verifyEd25519">;

/** Fetch the exact committed bytes the browser verifier checks. */
export async function fetchVerifierInputs(
  options?: FetchOptions,
): Promise<VerifierInputs> {
  const { stems } = await fetchJson<{ stems: string[] }>(
    "/api/releases",
    options,
  );
  const [journalBytes, prefixBytes, pubkeyBytes, manifestFiles] =
    await Promise.all([
      fetchBytes("/api/raw/journal.jsonl", options),
      fetchBytes("/api/raw/immutable_prefix.json", options),
      fetchBytes("/api/raw/anchors/producer-ed25519.pub", options),
      Promise.all(
        stems.map(async (stem) => {
          const [json, freetsa, digicert, producerSig] = await Promise.all([
            fetchBytes(`/api/raw/releases/${stem}.json`, options),
            fetchOptionalBytes(`/api/raw/releases/${stem}.freetsa.tsr`, options),
            fetchOptionalBytes(`/api/raw/releases/${stem}.digicert.tsr`, options),
            fetchOptionalBytes(`/api/raw/releases/${stem}.producer.sig`, options),
          ]);
          return { stem, json, freetsa, digicert, producerSig };
        }),
      ),
    ]);
  return {
    journalBytes,
    prefixBytes,
    producerPubkeyPem: new TextDecoder().decode(pubkeyBytes),
    manifestFiles,
  };
}
