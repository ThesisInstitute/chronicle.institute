import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import {
  IDLE_SEARCH,
  SEARCH_DEBOUNCE_MS,
  SEARCH_TIMEOUT_MS,
  searchErrorMessage,
  searchPath,
  startSearch,
  type SearchHit,
  type SearchState,
  type SearchUpdate,
} from "@/lib/search-request";
import {
  FETCH_TIMEOUT_MS,
  FetchNetworkError,
  FetchStatusError,
  FetchTimeoutError,
  type FetchLike,
} from "@/lib/verify/fetch";
import { NEVER, scripted, type Script } from "./support/scripted-fetch";

const D = 100;
const T = 1_000;

/** Fake timers from time zero, with a Date that follows them. */
function fakeClock() {
  vi.useFakeTimers({ now: 0, toFake: ["setTimeout", "clearTimeout", "Date"] });
}

function hit(q: string): SearchHit {
  return { kind: "journal", id: q, title: q, detail: `match for ${q}` };
}

function answer(q: string): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ query: q, results: [hit(q)] }),
  );
}

interface Harness {
  /** Scripts keyed by trimmed query; an unscripted query answers at once. */
  server?: Record<string, Script>;
  fetchImpl?: FetchLike;
  debounceMs?: number;
  timeoutMs?: number;
}

/**
 * The search page in miniature: `type` does what React does when the query
 * changes (run the previous effect's cleanup, then the new effect), and
 * `unmount` runs the last cleanup.
 */
function page({
  server = {},
  fetchImpl,
  debounceMs = D,
  timeoutMs = T,
}: Harness = {}) {
  const requests: { input: string; signal: AbortSignal; at: number }[] = [];
  const serve: FetchLike = (input, init) => {
    requests.push({ input, signal: init.signal, at: Date.now() });
    if (fetchImpl) return fetchImpl(input, init);
    const q = new URL(input, "http://chronicle.test").searchParams.get("q")!;
    return scripted({ body: answer(q), ...server[q] }).fetchImpl(input, init);
  };
  let state = IDLE_SEARCH;
  let current = "";
  const updates: { at: number; state: SearchState; current: string }[] = [];
  const update: SearchUpdate = (next) => {
    state = next(state);
    updates.push({ at: Date.now(), state, current });
  };
  let cleanup = () => {};
  return {
    type(query: string) {
      cleanup();
      current = query.trim();
      cleanup = startSearch(query, update, {
        fetchImpl: serve,
        debounceMs,
        timeoutMs,
      });
    },
    unmount() {
      cleanup();
    },
    get state() {
      return state;
    },
    updates,
    requests,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("startSearch", () => {
  it("is idle at once for a blank query and sends nothing", async () => {
    fakeClock();
    const p = page();
    p.type("   ");
    expect(p.state).toEqual(IDLE_SEARCH);
    await vi.advanceTimersByTimeAsync(D + T);
    expect(p.requests).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for the pause in typing, then asks for the trimmed query", async () => {
    fakeClock();
    const p = page();
    p.type("  a b ");
    expect(p.state).toEqual({ results: [], pending: true, error: null });
    await vi.advanceTimersByTimeAsync(D - 1);
    expect(p.requests).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(p.requests.map((r) => r.input)).toEqual(["/api/search?q=a%20b"]);
    expect(p.state).toEqual({
      results: [hit("a b")],
      pending: false,
      error: null,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends a stalled request in the error state at the deadline, and aborts it", async () => {
    fakeClock();
    // The page's own timings, not the test's.
    const p = page({
      server: { a: { headerMs: NEVER } },
      debounceMs: SEARCH_DEBOUNCE_MS,
      timeoutMs: SEARCH_TIMEOUT_MS,
    });
    p.type("a");
    await vi.advanceTimersByTimeAsync(
      SEARCH_DEBOUNCE_MS + SEARCH_TIMEOUT_MS - 1,
    );
    expect(p.state.pending).toBe(true);
    expect(p.requests[0].signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(p.state).toEqual({
      results: [],
      pending: false,
      error: "no response within 10 s",
    });
    expect(p.requests[0].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends a stall at the deadline even when the fetch ignores the abort", async () => {
    fakeClock();
    const p = page({ server: { a: { headerMs: NEVER, honorAbort: false } } });
    p.type("a");
    await vi.advanceTimersByTimeAsync(D + T);
    expect(p.state.error).toBe("no response within 1 s");
    expect(p.state.pending).toBe(false);
  });

  it("ends a body that stalls after the headers the same way", async () => {
    fakeClock();
    const p = page({ server: { a: { headerMs: 10, bodyMs: NEVER } } });
    p.type("a");
    await vi.advanceTimersByTimeAsync(D + T);
    expect(p.state.error).toBe("no response within 1 s");
    expect(p.requests[0].signal.aborted).toBe(true);
  });

  it("drops the earlier results when the new query fails", async () => {
    fakeClock();
    const p = page({ server: { ab: { status: 503 } } });
    p.type("a");
    await vi.advanceTimersByTimeAsync(D);
    expect(p.state.results).toEqual([hit("a")]);

    p.type("ab");
    // While the new query runs, the earlier results stay on screen.
    expect(p.state).toEqual({
      results: [hit("a")],
      pending: true,
      error: null,
    });
    await vi.advanceTimersByTimeAsync(D);
    expect(p.state).toEqual({
      results: [],
      pending: false,
      error: "the server answered HTTP 503",
    });
  });

  it("reports a network failure in the browser's words", async () => {
    const p = page({
      fetchImpl: () => Promise.reject(new TypeError("Failed to fetch")),
      debounceMs: 0,
    });
    p.type("a");
    await vi.waitFor(() => expect(p.state.pending).toBe(false));
    expect(p.state.error).toBe("Failed to fetch");
  });

  it("reports a body that is not JSON, or JSON without results", async () => {
    const garbled = page({
      fetchImpl: async () => new Response("<html>"),
      debounceMs: 0,
    });
    garbled.type("a");
    await vi.waitFor(() => expect(garbled.state.pending).toBe(false));
    expect(garbled.state.error).toMatch(/JSON/);

    const shapeless = page({
      fetchImpl: async () => Response.json({ error: "query too long" }),
      debounceMs: 0,
    });
    shapeless.type("a");
    await vi.waitFor(() => expect(shapeless.state.pending).toBe(false));
    expect(shapeless.state).toEqual({
      results: [],
      pending: false,
      error: "the server sent an unexpected response",
    });
  });

  it("clears an earlier error as soon as a new query starts", async () => {
    fakeClock();
    const p = page({ server: { a: { status: 500 } } });
    p.type("a");
    await vi.advanceTimersByTimeAsync(D);
    expect(p.state.error).toBe("the server answered HTTP 500");
    p.type("ab");
    expect(p.state).toEqual({ results: [], pending: true, error: null });
    p.type("");
    expect(p.state).toEqual(IDLE_SEARCH);
  });

  it("searching the same query again retries it", async () => {
    fakeClock();
    let calls = 0;
    const p = page({
      fetchImpl: (input, init) =>
        scripted(
          ++calls === 1 ? { headerMs: NEVER } : { body: answer("a") },
        ).fetchImpl(input, init),
    });
    p.type("a");
    await vi.advanceTimersByTimeAsync(D + T);
    expect(p.state.error).toBe("no response within 1 s");
    p.type("a"); // "Search again" re-runs the effect for the same query
    expect(p.state).toEqual({ results: [], pending: true, error: null });
    await vi.advanceTimersByTimeAsync(D);
    expect(p.state).toEqual({
      results: [hit("a")],
      pending: false,
      error: null,
    });
    expect(p.requests).toHaveLength(2);
  });

  it("sends nothing for a query replaced within the pause", async () => {
    fakeClock();
    const p = page();
    p.type("a");
    await vi.advanceTimersByTimeAsync(D - 1);
    p.type("ab");
    await vi.advanceTimersByTimeAsync(D);
    expect(p.requests.map((r) => r.input)).toEqual([searchPath("ab")]);
    expect(p.state.results).toEqual([hit("ab")]);
  });

  it("aborts the request in flight when the query changes, and never shows its answer", async () => {
    fakeClock();
    // The old request answers after the new one does, and ignores the abort:
    // only cancellation, not ordering or the abort, can keep it off screen.
    const p = page({
      server: {
        a: { headerMs: 300, honorAbort: false },
        ab: { headerMs: 50 },
      },
    });
    p.type("a");
    await vi.advanceTimersByTimeAsync(D + 10);
    expect(p.requests).toHaveLength(1);
    p.type("ab");
    expect(p.requests[0].signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(T);
    expect(p.state).toEqual({
      results: [hit("ab")],
      pending: false,
      error: null,
    });
    expect(
      p.updates.some((u) => u.state.results.some((r) => r.id === "a")),
    ).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves nothing scheduled when the page goes away during the pause", async () => {
    fakeClock();
    const p = page();
    p.type("a");
    await vi.advanceTimersByTimeAsync(D - 1);
    p.unmount();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(D);
    expect(p.requests).toHaveLength(0);
    expect(p.updates).toHaveLength(1);
  });

  it("aborts the request and stops updating when the page goes away", async () => {
    fakeClock();
    const p = page({ server: { a: { headerMs: 300, honorAbort: false } } });
    p.type("a");
    await vi.advanceTimersByTimeAsync(D + 10);
    const seen = p.updates.length;
    p.unmount();
    expect(p.requests[0].signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(3 * T);
    expect(p.updates).toHaveLength(seen);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses a deadline suited to typing: finite, and shorter than the verifier's", () => {
    expect(Number.isFinite(SEARCH_TIMEOUT_MS)).toBe(true);
    expect(SEARCH_TIMEOUT_MS).toBe(10_000);
    expect(SEARCH_TIMEOUT_MS).toBeLessThan(FETCH_TIMEOUT_MS);
  });
});

describe("searchErrorMessage", () => {
  const path = searchPath("a b");

  it("says how long it waited, without the request path", () => {
    expect(searchErrorMessage(new FetchTimeoutError(path, 10_000))).toBe(
      "no response within 10 s",
    );
  });

  it("names the HTTP status", () => {
    expect(searchErrorMessage(new FetchStatusError(path, 502))).toBe(
      "the server answered HTTP 502",
    );
  });

  it("passes on the browser's own words for a network failure", () => {
    const e = new FetchNetworkError(path, new TypeError("Load failed"));
    expect(searchErrorMessage(e)).toBe("Load failed");
    expect(searchErrorMessage(new FetchNetworkError(path, "offline"))).toBe(
      "offline",
    );
  });

  it("falls back to the message, or the value itself", () => {
    expect(searchErrorMessage(new Error("boom"))).toBe("boom");
    expect(searchErrorMessage("boom")).toBe("boom");
  });
});

// The model. A session is a sequence of queries typed at chosen intervals,
// against a server whose every answer is scripted (header and body delays,
// failure, whether it honours the abort), optionally ending with the page
// going away. For every such session the page's state updates, and when they
// happen, equal what this model predicts:
//
//   1. Each new query updates the state at once: idle for a blank query;
//      otherwise pending, with any error cleared and earlier results kept.
//   2. A request goes out for a non-blank query only after the pause, and only
//      if the query is still current then; never one for a superseded query.
//   3. That request settles the state exactly once, no later than the
//      deadline after it was sent: to its results, or to its error with no
//      results. Pending therefore never outlasts pause + deadline.
//   4. A request superseded (or orphaned by the page going away) before it
//      settles never updates the state at all, and is aborted. Nothing updates
//      the state after the page goes away.
//   5. No timer outlives the session.
describe("startSearch model", () => {
  // No pair of delays sums to exactly T, so no response arrives at the very
  // instant of the deadline; those ties are excluded, as in fetch.test.ts.
  const DELAYS = [0, 1, 300, T - 2, T + 1, NEVER];
  // Each query fails with its own status, so an error on screen names the
  // request it came from.
  const FAIL_STATUS: Record<string, number> = { a: 500, ab: 502, "b c": 503 };
  const QUERIES = ["", "  ", "a", " a", "ab", "b c "];

  interface Answer {
    headerMs: number;
    bodyMs: number;
    fails: boolean;
    honorAbort: boolean;
  }

  /** When a request for `q` settles after it is sent, and to what. */
  function outcome(q: string, a: Answer) {
    if (a.fails && a.headerMs < T) {
      return {
        afterMs: a.headerMs,
        timedOut: false,
        state: {
          results: [],
          pending: false,
          error: `the server answered HTTP ${FAIL_STATUS[q]}`,
        },
      };
    }
    if (!a.fails && a.headerMs + a.bodyMs < T) {
      return {
        afterMs: a.headerMs + a.bodyMs,
        timedOut: false,
        state: { results: [hit(q)], pending: false, error: null },
      };
    }
    return {
      afterMs: T,
      timedOut: true,
      state: { results: [], pending: false, error: "no response within 1 s" },
    };
  }

  interface Session {
    answers: Record<string, Answer>;
    steps: { query: string; gap: number }[];
    unmount: boolean;
  }

  function predict({ answers, steps, unmount }: Session) {
    let state: SearchState = IDLE_SEARCH;
    let t = 0;
    let tie = false;
    const updates: { at: number; state: SearchState }[] = [];
    const requests: { input: string; at: number; aborted: boolean }[] = [];
    steps.forEach(({ query, gap }, i) => {
      const q = query.trim();
      // How long this query stays current: until the next one, or the page
      // going away; the last query on a page that stays has no end.
      const window = i === steps.length - 1 && !unmount ? Infinity : gap;
      state = q ? { ...state, pending: true, error: null } : IDLE_SEARCH;
      updates.push({ at: t, state });
      if (q && D <= window) {
        const o = outcome(q, answers[q]);
        const settles = D + o.afterMs < window;
        // An event at the very instant the query is replaced is a tie; the
        // model makes no claim about which comes first.
        tie ||= D === window || D + o.afterMs === window;
        requests.push({
          input: searchPath(q),
          at: t + D,
          aborted: !settles || o.timedOut,
        });
        if (settles) {
          state = o.state;
          updates.push({ at: t + D + o.afterMs, state });
        }
      }
      t += gap;
    });
    return { updates, requests, tie };
  }

  const answerArb = fc.record({
    headerMs: fc.constantFrom(...DELAYS),
    bodyMs: fc.constantFrom(...DELAYS),
    fails: fc.boolean(),
    honorAbort: fc.boolean(),
  });
  const gapArb = fc.oneof(
    fc.constantFrom(0, 1, D - 1, D + 1, D + 2, D + 301, D + T - 1, D + T + 1),
    fc.integer({ min: 0, max: 2 * (D + T) }),
  );
  const sessionArb = fc.record({
    answers: fc.record({ a: answerArb, ab: answerArb, "b c": answerArb }),
    steps: fc.array(
      fc.record({ query: fc.constantFrom(...QUERIES), gap: gapArb }),
      {
        minLength: 1,
        maxLength: 6,
      },
    ),
    unmount: fc.boolean(),
  });

  it("every session updates the state exactly as the model predicts", async () => {
    await fc.assert(
      fc.asyncProperty(sessionArb, async (session) => {
        const expected = predict(session);
        fc.pre(!expected.tie);
        fakeClock();
        try {
          const server = Object.fromEntries(
            Object.entries(session.answers).map(([q, a]) => [
              q,
              {
                headerMs: a.headerMs,
                bodyMs: a.bodyMs,
                status: a.fails ? FAIL_STATUS[q] : 200,
                honorAbort: a.honorAbort,
              },
            ]),
          );
          const p = page({ server });
          for (const { query, gap } of session.steps) {
            p.type(query);
            await vi.advanceTimersByTimeAsync(gap);
          }
          if (session.unmount) p.unmount();
          // Long enough for every deadline and every scripted server timer.
          await vi.advanceTimersByTimeAsync(3 * (D + T));

          expect(p.updates.map(({ at, state }) => ({ at, state }))).toEqual(
            expected.updates,
          );
          expect(
            p.requests.map(({ input, at, signal }) => ({
              input,
              at,
              aborted: signal.aborted,
            })),
          ).toEqual(expected.requests);

          // Model-free restatements of the guarantees the page relies on.
          for (const u of p.updates) {
            // Results on screen, once settled, are the current query's.
            if (!u.state.pending && u.state.error === null && u.current) {
              expect(u.state.results).toEqual([hit(u.current)]);
            }
          }
          if (!session.unmount) expect(p.state.pending).toBe(false);
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          vi.useRealTimers();
        }
      }),
      { numRuns: 500 },
    );
  });
});
