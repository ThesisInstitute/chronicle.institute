"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { IconSearch } from "@tabler/icons-react";
import {
  IDLE_SEARCH,
  startSearch,
  type SearchHit,
  type SearchState,
} from "@/lib/search-request";

const KIND_LABEL: Record<SearchHit["kind"], string> = {
  journal: "journal",
  store: "store",
  package: "package",
};

export function SearchClient({ corpusSize }: { corpusSize: number }) {
  const [query, setQuery] = useState("");
  const [{ results, pending, error }, setSearch] =
    useState<SearchState>(IDLE_SEARCH);
  // "Search again" bumps this to re-run an unchanged query.
  const [attempt, setAttempt] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const trimmed = query.trim();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // The cleanup aborts the request in flight, so a new query (or leaving the
  // page) cancels the old one instead of letting it run on unseen.
  useEffect(() => startSearch(trimmed, setSearch), [trimmed, attempt]);

  function searchAgain() {
    setAttempt((n) => n + 1);
    inputRef.current?.focus();
  }

  return (
    <div className="max-w-3xl">
      <label className="flex items-center gap-2 border border-border-strong bg-paper px-3 py-2 focus-within:border-horizon-700">
        <IconSearch size={18} className="shrink-0 text-text-tertiary" aria-hidden />
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${corpusSize.toLocaleString()} records`}
          aria-label="Search Chronicle"
          className="w-full bg-transparent text-base outline-none placeholder:text-text-disabled"
        />
      </label>
      {error ? (
        <div className="mt-4 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
          <p className="alert-text" role="alert">
            Search failed: {error}
          </p>
          <button
            type="button"
            onClick={searchAgain}
            className="text-text-secondary underline underline-offset-2 hover:text-accent"
          >
            Search again
          </button>
        </div>
      ) : null}
      {trimmed && !pending && !error ? (
        <p className="mt-3 text-sm text-text-tertiary" role="status">
          {results.length === 50
            ? "First 50 matches"
            : `${results.length} match${results.length === 1 ? "" : "es"}`}
        </p>
      ) : null}
      <ul className="mt-2 divide-y divide-border-soft">
        {results.map((r) => (
          <li key={`${r.kind}:${r.id}`} className="py-3">
            <div className="flex items-baseline gap-3">
              <span className="stamp stamp-neutral">{KIND_LABEL[r.kind]}</span>
              <Link
                href={
                  r.kind === "journal"
                    ? `/journal/${encodeURIComponent(r.id)}`
                    : r.kind === "store"
                      ? `/store/${r.id}`
                      : `/sources/${encodeURIComponent(r.id)}`
                }
                className="record-id"
              >
                {r.title}
              </Link>
            </div>
            <p className="mt-1 text-sm text-text-tertiary">{r.detail}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
