"use client";

import { useCallback, useState } from "react";
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconCircleDashed,
  IconPlayerPlay,
} from "@tabler/icons-react";
import type { Check, ChainVerification } from "@/lib/verify/chain";
import { verifyChain } from "@/lib/verify/chain";
import { fetchVerifierInputs } from "@/lib/verify/fetch";
import { formatUtc } from "@/lib/format";

function CheckRow({ check }: { check: Check }) {
  const icon =
    check.status === "pass" ? (
      <IconCircleCheck size={16} className="mt-0.5 shrink-0 text-horizon-700" aria-hidden />
    ) : check.status === "fail" ? (
      <IconAlertTriangle size={16} className="mt-0.5 shrink-0 text-text-primary" aria-hidden />
    ) : (
      <IconCircleDashed size={16} className="mt-0.5 shrink-0 text-text-tertiary" aria-hidden />
    );
  const statusText =
    check.status === "pass"
      ? "pass"
      : check.status === "fail"
        ? "FAIL"
        : "not checked in browser";
  return (
    <li className="flex items-start gap-2 py-1.5">
      {icon}
      <div>
        <span className="text-sm">{check.title}</span>{" "}
        <span
          className={
            check.status === "fail"
              ? "alert-text font-mono text-xs"
              : "font-mono text-xs text-text-tertiary"
          }
        >
          — {statusText}
        </span>
        <div className="font-mono text-xs text-text-tertiary">{check.detail}</div>
      </div>
    </li>
  );
}

export function VerifierClient() {
  const [state, setState] = useState<
    | { phase: "idle" }
    | { phase: "running"; step: string }
    | { phase: "done"; result: ChainVerification }
    | { phase: "error"; message: string }
  >({ phase: "idle" });

  const run = useCallback(async () => {
    try {
      setState({ phase: "running", step: "Fetching committed bytes" });
      const inputs = await fetchVerifierInputs();
      setState({ phase: "running", step: "Recomputing hashes and signatures" });
      const ed = await import("@noble/ed25519");
      const result = await verifyChain({
        ...inputs,
        verifyEd25519: (sig, msg, pub) => ed.verifyAsync(sig, msg, pub),
      });
      setState({ phase: "done", result });
    } catch (e) {
      setState({
        phase: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, []);

  return (
    <div className="mt-3">
      {state.phase === "error" ? (
        <p className="alert-slot mb-3 p-3 text-sm" role="alert">
          Verification could not run: {state.message}
        </p>
      ) : null}
      {state.phase === "idle" || state.phase === "error" ? (
        <button
          type="button"
          onClick={run}
          className="inline-flex items-center gap-2 border border-border-strong bg-paper px-4 py-2 text-sm font-medium hover:border-accent hover:text-accent"
        >
          <IconPlayerPlay size={16} aria-hidden />
          {state.phase === "error"
            ? "Run the checks again"
            : "Run the checks in this browser"}
        </button>
      ) : null}
      {state.phase === "running" ? (
        <p className="text-sm text-text-secondary" role="status">
          {state.step}…
        </p>
      ) : null}
      {state.phase === "done" ? <Results result={state.result} /> : null}
    </div>
  );
}

function Results({ result }: { result: ChainVerification }) {
  const headline =
    result.failures === 0
      ? `${result.browserChecked} checks passed in this browser; ${result.notCheckedInBrowser} require the offline verifier.`
      : `${result.failures} CHECK${result.failures === 1 ? "" : "S"} FAILED — the committed bytes do not verify.`;
  return (
    <div>
      <p
        className={
          result.failures === 0
            ? "border border-horizon-300 bg-paper p-3 text-sm"
            : "alert-slot p-3 text-sm font-medium"
        }
        role="status"
      >
        {headline}
      </p>

      <ul className="mt-4 divide-y divide-border-soft border-y border-border-soft">
        {result.journalChecks.map((c) => (
          <CheckRow key={c.id} check={c} />
        ))}
      </ul>

      {result.releases.map((release) => (
        <div key={release.stem} className="mt-6">
          <h3 className="font-mono text-sm">
            release {release.manifest.releaseIndex} · {release.stem}
          </h3>
          <p className="mt-1 text-xs text-text-tertiary">
            created {formatUtc(release.manifest.createdAtUtc)} ·{" "}
            {release.manifest.append === null
              ? "genesis (no append block)"
              : `append of ${release.manifest.append.appendedRowCount} rows`}
          </p>
          <ul className="mt-2 divide-y divide-border-soft border-y border-border-soft">
            {release.checks.map((c) => (
              <CheckRow key={c.id} check={c} />
            ))}
          </ul>
          {release.receipts.map((r) => (
            <div key={r.tsa} className="mt-3 pl-4">
              <h4 className="font-mono text-xs uppercase tracking-[0.08em] text-text-secondary">
                {r.tsa} receipt
                {r.genTimeUtc ? ` · genTime ${formatUtc(r.genTimeUtc)}` : ""}
              </h4>
              <ul className="mt-1 divide-y divide-border-soft border-y border-border-soft">
                {r.checks.map((c) => (
                  <CheckRow key={`${r.tsa}-${c.id}`} check={c} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
