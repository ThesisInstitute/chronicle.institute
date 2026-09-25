import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import * as ed from "@noble/ed25519";
import { verifyChain } from "@/lib/verify/chain";
import {
  FETCH_TIMEOUT_MS,
  FetchStatusError,
  FetchTimeoutError,
  fetchBytes,
  fetchJson,
  fetchOptionalBytes,
  fetchVerifierInputs,
  type FetchLike,
} from "@/lib/verify/fetch";

const T = 1_000;
const NEVER = Number.POSITIVE_INFINITY;
const BODY = new Uint8Array([1, 2, 3]);

interface Script {
  /** Delay before the response headers arrive (NEVER = they don't). */
  headerMs?: number;
  /** Further delay before the body completes (NEVER = it doesn't). */
  bodyMs?: number;
  status?: number;
  body?: Uint8Array;
  /** A real fetch rejects and errors its body when the signal aborts. */
  honorAbort?: boolean;
}

function after(ms: number, fn: () => void) {
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
function scripted({
  headerMs = 0,
  bodyMs = 0,
  status = 200,
  body = BODY,
  honorAbort = true,
}: Script) {
  const signals: AbortSignal[] = [];
  const fetchImpl: FetchLike = (_input, { signal }) => {
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
  return { fetchImpl, signals };
}

/** Track a promise's settlement without awaiting it. */
function observe<T>(promise: Promise<T>) {
  const seen: { settled: boolean; value?: T; error?: unknown } = {
    settled: false,
  };
  promise.then(
    (value) => Object.assign(seen, { settled: true, value }),
    (error) => Object.assign(seen, { settled: true, error }),
  );
  return seen;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("fetchBytes", () => {
  it("returns the body when the whole exchange beats the deadline", async () => {
    const { fetchImpl } = scripted({});
    await expect(fetchBytes("/x", { fetchImpl, timeoutMs: T })).resolves.toEqual(
      BODY,
    );
  });

  it("rejects a non-OK response with its status", async () => {
    const { fetchImpl } = scripted({ status: 500 });
    const err = await fetchBytes("/x", { fetchImpl, timeoutMs: T }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(FetchStatusError);
    expect(err.message).toBe("/x: HTTP 500");
  });

  it("ends a request whose headers never arrive, and aborts it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { fetchImpl, signals } = scripted({ headerMs: NEVER });
    const seen = observe(fetchBytes("/stalled", { fetchImpl, timeoutMs: T }));

    await vi.advanceTimersByTimeAsync(T - 1);
    expect(seen.settled).toBe(false);
    expect(signals[0].aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(seen.error).toBeInstanceOf(FetchTimeoutError);
    expect((seen.error as Error).message).toBe(
      "/stalled: no complete response within 1 s",
    );
    expect(signals[0].aborted).toBe(true);
  });

  it("ends a response whose body stalls after the headers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { fetchImpl, signals } = scripted({ headerMs: 10, bodyMs: NEVER });
    const seen = observe(fetchBytes("/slow-body", { fetchImpl, timeoutMs: T }));
    await vi.advanceTimersByTimeAsync(T);
    expect(seen.error).toBeInstanceOf(FetchTimeoutError);
    expect(signals[0].aborted).toBe(true);
  });

  it("holds the deadline even when fetch ignores the abort signal", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { fetchImpl } = scripted({ headerMs: NEVER, honorAbort: false });
    const seen = observe(fetchBytes("/deaf", { fetchImpl, timeoutMs: T }));
    await vi.advanceTimersByTimeAsync(T);
    expect(seen.error).toBeInstanceOf(FetchTimeoutError);
  });

  it("defaults to a finite deadline", async () => {
    expect(Number.isFinite(FETCH_TIMEOUT_MS)).toBe(true);
    expect(FETCH_TIMEOUT_MS).toBeGreaterThan(0);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { fetchImpl } = scripted({ headerMs: NEVER });
    const seen = observe(fetchBytes("/x", { fetchImpl }));
    await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS);
    expect(seen.error).toBeInstanceOf(FetchTimeoutError);
  });

  it("leaves no timer behind once settled", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const ok = observe(fetchBytes("/x", { ...scripted({}), timeoutMs: T }));
    const bad = observe(
      fetchBytes("/x", { ...scripted({ status: 503 }), timeoutMs: T }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(ok.value).toEqual(BODY);
    expect(bad.error).toBeInstanceOf(FetchStatusError);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// Invariant, over every class of timing: the call settles no later than the
// deadline; it settles with the body exactly when headers and body complete
// before the deadline, and otherwise with a FetchTimeoutError — whether or
// not the fetch implementation honours the abort.
describe("fetchBytes timing invariant", () => {
  const delays = [0, 1, T / 2, T - 1, T + 1, NEVER];
  const cases = delays.flatMap((headerMs) =>
    delays.flatMap((bodyMs) =>
      [true, false].map((honorAbort) => ({ headerMs, bodyMs, honorAbort })),
    ),
  );
  // Exactly-on-the-deadline completions are a tie; the invariant is stated
  // for strictly-before and strictly-after.
  const decisive = cases.filter((c) => c.headerMs + c.bodyMs !== T);

  it.each(decisive)(
    "headers +$headerMs ms, body +$bodyMs ms, honours abort: $honorAbort",
    async ({ headerMs, bodyMs, honorAbort }) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { fetchImpl } = scripted({ headerMs, bodyMs, honorAbort });
      const seen = observe(fetchBytes("/x", { fetchImpl, timeoutMs: T }));

      await vi.advanceTimersByTimeAsync(T);
      expect(seen.settled).toBe(true);
      if (headerMs + bodyMs < T) {
        expect(seen.error).toBeUndefined();
        expect(seen.value).toEqual(BODY);
      } else {
        expect(seen.error).toBeInstanceOf(FetchTimeoutError);
      }
    },
  );
});

describe("fetchJson", () => {
  it("parses the body and is bounded by the same deadline", async () => {
    const json = new TextEncoder().encode('{"stems":["a"]}');
    await expect(
      fetchJson("/api/releases", { ...scripted({ body: json }), timeoutMs: T }),
    ).resolves.toEqual({ stems: ["a"] });

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const seen = observe(
      fetchJson("/api/releases", {
        ...scripted({ headerMs: NEVER }),
        timeoutMs: T,
      }),
    );
    await vi.advanceTimersByTimeAsync(T);
    expect(seen.error).toBeInstanceOf(FetchTimeoutError);
  });
});

describe("fetchOptionalBytes", () => {
  it("maps only a 404 to an absent file", async () => {
    await expect(
      fetchOptionalBytes("/x", { ...scripted({ status: 404 }), timeoutMs: T }),
    ).resolves.toBeNull();
  });

  it("propagates a server error rather than reporting the file absent", async () => {
    await expect(
      fetchOptionalBytes("/x", { ...scripted({ status: 500 }), timeoutMs: T }),
    ).rejects.toBeInstanceOf(FetchStatusError);
  });

  it("propagates a timeout rather than reporting the file absent", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const seen = observe(
      fetchOptionalBytes("/x", {
        ...scripted({ headerMs: NEVER }),
        timeoutMs: T,
      }),
    );
    await vi.advanceTimersByTimeAsync(T);
    expect(seen.value).toBeUndefined();
    expect(seen.error).toBeInstanceOf(FetchTimeoutError);
  });
});

// The loader against the vendored bytes, served by the same paths the app's
// /api routes expose.
describe("fetchVerifierInputs", () => {
  const DATA = path.join(__dirname, "../data/journal");
  const STEM = "0000-307cedbc91de43be";
  const files: Record<string, string> = {
    "/api/raw/journal.jsonl": "official_observations.jsonl",
    "/api/raw/immutable_prefix.json": "immutable_prefix.json",
    "/api/raw/anchors/producer-ed25519.pub": "releases/anchors/producer-ed25519.pub",
    ...Object.fromEntries(
      [".json", ".freetsa.tsr", ".digicert.tsr", ".producer.sig"].map((ext) => [
        `/api/raw/releases/${STEM}${ext}`,
        `releases/manifests/${STEM}${ext}`,
      ]),
    ),
  };

  /** Serve the vendored bytes; `override` scripts particular paths instead. */
  function server(override: Record<string, Script> = {}) {
    const requested: string[] = [];
    const fetchImpl: FetchLike = (input, init) => {
      requested.push(input);
      if (override[input]) return scripted(override[input]).fetchImpl(input, init);
      if (input === "/api/releases") {
        return Promise.resolve(Response.json({ stems: [STEM] }));
      }
      const file = files[input];
      if (!file) return Promise.resolve(new Response(null, { status: 404 }));
      return Promise.resolve(
        new Response(new Uint8Array(fs.readFileSync(path.join(DATA, file)))),
      );
    };
    return { fetchImpl, requested };
  }

  it("fetches exactly the committed bytes the chain verifies", async () => {
    const { fetchImpl, requested } = server();
    const inputs = await fetchVerifierInputs({ fetchImpl, timeoutMs: T });
    expect(new Set(requested)).toEqual(
      new Set(["/api/releases", ...Object.keys(files)]),
    );
    const result = await verifyChain({
      ...inputs,
      verifyEd25519: (sig, msg, pub) => ed.verifyAsync(sig, msg, pub),
    });
    expect(result.failures).toBe(0);
  });

  it("still reports a receipt the server says is absent as missing", async () => {
    const { fetchImpl } = server({
      [`/api/raw/releases/${STEM}.digicert.tsr`]: { status: 404 },
    });
    const inputs = await fetchVerifierInputs({ fetchImpl, timeoutMs: T });
    expect(inputs.manifestFiles[0].digicert).toBeNull();
    const result = await verifyChain({
      ...inputs,
      verifyEd25519: (sig, msg, pub) => ed.verifyAsync(sig, msg, pub),
    });
    expect(result.failures).toBeGreaterThan(0);
  });

  it("turns a stalled receipt into an error, not a failed check", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stalled = `/api/raw/releases/${STEM}.digicert.tsr`;
    const { fetchImpl } = server({ [stalled]: { headerMs: NEVER } });
    const seen = observe(fetchVerifierInputs({ fetchImpl, timeoutMs: T }));
    await vi.advanceTimersByTimeAsync(T);
    expect(seen.value).toBeUndefined();
    expect(seen.error).toBeInstanceOf(FetchTimeoutError);
    expect((seen.error as FetchTimeoutError).path).toBe(stalled);
  });

  it("turns a stalled release list into an error", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { fetchImpl } = server({ "/api/releases": { headerMs: NEVER } });
    const seen = observe(fetchVerifierInputs({ fetchImpl, timeoutMs: T }));
    await vi.advanceTimersByTimeAsync(T);
    expect(seen.error).toBeInstanceOf(FetchTimeoutError);
  });
});
