import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import * as ed from "@noble/ed25519";
import { verifyChain } from "@/lib/verify/chain";
import {
  FETCH_TIMEOUT_MS,
  FetchNetworkError,
  FetchStatusError,
  FetchTimeoutError,
  fetchBytes,
  fetchJson,
  fetchOptionalBytes,
  fetchVerifierInputs,
  type FetchLike,
} from "@/lib/verify/fetch";
import {
  BODY,
  NEVER,
  after,
  observe,
  scripted,
  type Script,
} from "./support/scripted-fetch";

const T = 1_000;

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

  it("names the file when the request fails outright", async () => {
    const fetchImpl: FetchLike = () =>
      Promise.reject(new TypeError("Failed to fetch"));
    const err = await fetchBytes("/api/raw/journal.jsonl", {
      fetchImpl,
      timeoutMs: T,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(FetchNetworkError);
    expect(err.message).toBe("/api/raw/journal.jsonl: Failed to fetch");
    expect(err.cause).toBeInstanceOf(TypeError);
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

// The caller's own signal (search cancels a superseded query this way).
describe("fetchBytes with the caller's signal", () => {
  const REASON = new Error("superseded");

  it.each([true, false])(
    "settles at once with the caller's reason and aborts the request (honours abort: %s)",
    async (honorAbort) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const caller = new AbortController();
      const { fetchImpl, signals } = scripted({ headerMs: NEVER, honorAbort });
      const seen = observe(
        fetchBytes("/x", { fetchImpl, timeoutMs: T, signal: caller.signal }),
      );
      await vi.advanceTimersByTimeAsync(T / 2);
      expect(seen.settled).toBe(false);

      caller.abort(REASON);
      await vi.advanceTimersByTimeAsync(0);
      expect(seen.error).toBe(REASON);
      expect(signals[0].aborted).toBe(true);
      // The deadline timer went with it.
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("sends nothing when the signal has already aborted", async () => {
    const caller = new AbortController();
    caller.abort(REASON);
    const { fetchImpl, signals } = scripted({});
    await expect(
      fetchBytes("/x", { fetchImpl, timeoutMs: T, signal: caller.signal }),
    ).rejects.toBe(REASON);
    expect(signals).toHaveLength(0);
  });

  it("lets go of the signal once settled", async () => {
    const caller = new AbortController();
    const { fetchImpl, signals } = scripted({});
    await expect(
      fetchBytes("/x", { fetchImpl, timeoutMs: T, signal: caller.signal }),
    ).resolves.toEqual(BODY);
    // Were the listener still attached, this would abort the finished request.
    caller.abort(REASON);
    expect(signals[0].aborted).toBe(false);
  });

  it("keeps the timeout as the outcome when the caller aborts afterwards", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const caller = new AbortController();
    const { fetchImpl } = scripted({ headerMs: NEVER });
    const seen = observe(
      fetchBytes("/x", { fetchImpl, timeoutMs: T, signal: caller.signal }),
    );
    await vi.advanceTimersByTimeAsync(T);
    caller.abort(REASON);
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.error).toBeInstanceOf(FetchTimeoutError);
  });
});

// Invariant, with the caller's signal: the call settles with whichever comes
// first of the complete response (the body), the caller's abort (its reason),
// and the deadline (FetchTimeoutError), whether or not the fetch
// implementation honours the abort.
describe("fetchBytes caller-abort invariant", () => {
  const REASON = new Error("superseded");
  const delays = [0, 1, T / 2, T - 1, T + 1, NEVER];
  const cases = delays.flatMap((headerMs) =>
    delays.flatMap((bodyMs) =>
      delays.flatMap((abortMs) =>
        [true, false].map((honorAbort) => ({
          headerMs,
          bodyMs,
          abortMs,
          honorAbort,
        })),
      ),
    ),
  );
  // Simultaneous events are ties; the invariant is stated for the rest.
  const decisive = cases.filter(({ headerMs, bodyMs, abortMs }) => {
    const done = headerMs + bodyMs;
    const finite = [done, abortMs, T].filter(Number.isFinite);
    return new Set(finite).size === finite.length;
  });

  it.each(decisive)(
    "headers +$headerMs ms, body +$bodyMs ms, caller aborts +$abortMs ms, honours abort: $honorAbort",
    async ({ headerMs, bodyMs, abortMs, honorAbort }) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const caller = new AbortController();
      const { fetchImpl } = scripted({ headerMs, bodyMs, honorAbort });
      const seen = observe(
        fetchBytes("/x", { fetchImpl, timeoutMs: T, signal: caller.signal }),
      );
      after(abortMs, () => caller.abort(REASON));

      await vi.advanceTimersByTimeAsync(T);
      expect(seen.settled).toBe(true);
      const first = Math.min(headerMs + bodyMs, abortMs, T);
      if (first === headerMs + bodyMs) {
        expect(seen.error).toBeUndefined();
        expect(seen.value).toEqual(BODY);
      } else if (first === abortMs) {
        expect(seen.error).toBe(REASON);
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

    const garbled = await fetchJson<{ stems: string[] }>("/api/releases", {
      ...scripted({ body: new TextEncoder().encode("<html>") }),
      timeoutMs: T,
    }).catch((e) => e);
    expect(garbled).toBeInstanceOf(FetchNetworkError);
    expect(garbled.message).toMatch(/^\/api\/releases: /);

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

  it("propagates a network failure rather than reporting the file absent", async () => {
    const fetchImpl: FetchLike = () =>
      Promise.reject(new TypeError("Load failed"));
    await expect(
      fetchOptionalBytes("/x", { fetchImpl, timeoutMs: T }),
    ).rejects.toBeInstanceOf(FetchNetworkError);
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
