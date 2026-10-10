// A scripted fetch for tests: each exchange responds on a timetable, on
// whatever timers the test is running (fake or real).

import type { FetchLike } from "@/lib/verify/fetch";

export const NEVER = Number.POSITIVE_INFINITY;
export const BODY = new Uint8Array([1, 2, 3]);

export interface Script {
  /** Delay before the response headers arrive (NEVER = they don't). */
  headerMs?: number;
  /** Further delay before the body completes (NEVER = it doesn't). */
  bodyMs?: number;
  status?: number;
  body?: Uint8Array;
  /** A real fetch rejects and errors its body when the signal aborts. */
  honorAbort?: boolean;
}

export function after(ms: number, fn: () => void) {
  // Zero means now: the fake clock schedules a 0 ms timer created mid-tick
  // one millisecond out, which would move a "T - 1" completion onto T.
  if (ms === 0) fn();
  else if (ms !== NEVER) setTimeout(fn, ms);
}

/**
 * One scripted exchange: a fetch that responds on a timetable. The response
 * is a minimal stand-in rather than a platform Response so that every delay
 * runs on the (fake) timers under test, not on the runtime's stream plumbing.
 */
export function scripted({
  headerMs = 0,
  bodyMs = 0,
  status = 200,
  body = BODY,
  honorAbort = true,
}: Script) {
  const inputs: string[] = [];
  const signals: AbortSignal[] = [];
  const fetchImpl: FetchLike = (input, { signal }) => {
    inputs.push(input);
    signals.push(signal);
    return new Promise<Response>((resolve, reject) => {
      if (honorAbort) {
        signal.addEventListener("abort", () => reject(signal.reason));
      }
      after(headerMs, () => {
        const complete = new Promise<Uint8Array>((done, fail) => {
          if (honorAbort) {
            signal.addEventListener("abort", () => fail(signal.reason));
          }
          after(bodyMs, () => done(body));
        });
        complete.catch(() => {}); // a body nobody reads may still be aborted
        resolve({
          ok: status >= 200 && status < 300,
          status,
          arrayBuffer: async () => (await complete).slice().buffer,
          json: async () =>
            JSON.parse(new TextDecoder().decode(await complete)),
        } as unknown as Response);
      });
    });
  };
  return { fetchImpl, inputs, signals };
}

/** Track a promise's settlement without awaiting it. */
export function observe<T>(promise: Promise<T>) {
  const seen: { settled: boolean; value?: T; error?: unknown } = {
    settled: false,
  };
  promise.then(
    (value) => Object.assign(seen, { settled: true, value }),
    (error) => Object.assign(seen, { settled: true, error }),
  );
  return seen;
}
