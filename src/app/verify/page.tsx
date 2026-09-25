import type { Metadata } from "next";
import { getJournal, getPins, getReleases } from "@/lib/data";
import { journalHeadline } from "@/lib/status";
import { PageHeader } from "@/components/PageHeader";
import { Stamp } from "@/components/Stamp";
import { formatUtc } from "@/lib/format";
import { VerifierClient } from "./verifier-client";

export const metadata: Metadata = { title: "Verify" };

export default function VerifyPage() {
  const journal = getJournal();
  const releases = getReleases();
  const pins = getPins();
  const headline = journalHeadline(
    releases.map((r) => r.manifest),
    journal.length,
  );
  const custodyCounts = journal.reduce<Record<string, number>>((acc, e) => {
    const c = e.availability?.custody ?? "unindexed";
    acc[c] = (acc[c] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="max-w-4xl">
      <PageHeader
        title="Verify the witnessed chain"
        lede={
          <>
            The journal’s releases are chained manifests, each timestamped
            by two RFC 3161 authorities and signed with the pinned producer
            key. This page fetches the exact committed bytes and re-runs the
            verifiable checks in your browser. What the browser cannot check
            is listed as exactly that — nothing here is reported as verified
            unless it was.
          </>
        }
      />

      <section aria-labelledby="state-heading">
        <h2 id="state-heading" className="text-xl">
          Current state, plainly
        </h2>
        <dl className="field-table mt-3">
          <dt>Journal rows</dt>
          <dd>{headline.totalRows}</dd>
          <dt>Releases</dt>
          <dd>
            {headline.releases} (genesis{" "}
            {formatUtc(headline.genesisAtUtc)})
          </dd>
          <dt>Witnessed appends</dt>
          <dd>
            {headline.witnessedAppends}
            {headline.witnessedAppends === 0 ? (
              <span className="block max-w-2xl text-sm text-text-secondary">
                Every current row predates the first witnessed append. The
                genesis release witnesses that the {headline.witnessedLineCount}
                -row state existed no later than its receipt times; it does not
                witness when any individual row was first recorded.
              </span>
            ) : null}
          </dd>
          <dt>Row custody</dt>
          <dd className="flex flex-wrap gap-2">
            {Object.entries(custodyCounts).map(([custody, count]) => (
              <Stamp
                key={custody}
                tone={custody === "rewritten_in_place" ? "flag" : "neutral"}
              >
                {count} {custody.replaceAll("_", " ")}
              </Stamp>
            ))}
          </dd>
        </dl>
        <p className="mt-3 max-w-3xl text-sm text-text-secondary">
          The 13 rows marked <em>rewritten in place</em> had bytes rewritten in
          git before the append-only contract was enforced on 2026-07-10. They
          are frozen in the immutable prefix and flagged in the acceptance
          index — recorded, not hidden.
        </p>
      </section>

      <section aria-labelledby="browser-heading" className="mt-10">
        <h2 id="browser-heading" className="text-xl">
          Browser verification
        </h2>
        <VerifierClient />
      </section>

      <section aria-labelledby="offline-heading" className="mt-10">
        <h2 id="offline-heading" className="text-xl">
          Full offline verification
        </h2>
        <p className="mt-2 max-w-3xl text-sm text-text-secondary">
          The complete check — including the RFC 3161 signature chains to the
          committed trust anchors, which browsers cannot do here — runs
          offline from a clone of the journal branch:
        </p>
        <pre className="mt-3 overflow-x-auto border border-border-soft bg-paper p-4 text-sm">
          {`git clone --branch ${pins.journal.branch} \\
    https://github.com/${pins.journal.repo}.git
cd ledger
python3 scripts/verify_release_chain.py --full`}
        </pre>
        <p className="mt-3 max-w-3xl text-sm text-text-secondary">
          Internal verification proves a clone is self-consistent; it cannot,
          by itself, distinguish the original history from a freshly witnessed
          replacement fork. Keep an external checkpoint — at minimum the head
          manifest’s SHA-256 — and compare it against later clones. This
          deployment pins {pins.journal.repo}@{pins.journal.commit.slice(0, 12)}.
        </p>
      </section>

      <section aria-labelledby="bitcoin-heading" className="mt-10">
        <h2 id="bitcoin-heading" className="text-xl">
          Bitcoin-anchored checkpoints
        </h2>
        <p className="mt-2 max-w-3xl text-sm text-text-secondary">
          Each release manifest is also timestamped in Bitcoin through
          OpenTimestamps, over the same exact bytes both RFC 3161 authorities
          witness. Once its proof carries a Bitcoin block attestation, the
          manifest — and with it the journal state and the chain it commits
          to — existed no later than that block, and neither we nor a
          timestamp authority can move that bound earlier. A job runs daily:
          it stamps any manifest that has no proof yet and upgrades pending
          proofs until the attestation is written into the file. The proofs
          are committed as <code>ots/&lt;stem&gt;.json.ots</code> on the
          repository’s <code>main</code> branch, not the journal
          branch. From the clone above, for any release:
        </p>
        <pre className="mt-3 overflow-x-auto border border-border-soft bg-paper p-4 text-sm">
          {`git show origin/main:ots/<stem>.json.ots > ../<stem>.json.ots
uvx --from opentimestamps-client==0.7.2 ots --no-bitcoin \\
    verify -f releases/manifests/<stem>.json ../<stem>.json.ots`}
        </pre>
        <p className="mt-3 max-w-3xl text-sm text-text-secondary">
          That is the OpenTimestamps client at the version the job pins. It
          first checks that the proof commits to the manifest’s exact
          bytes. With <code>--no-bitcoin</code> it then prints each attested
          block’s height and merkle root, to compare against any block
          source you trust; without the flag it looks each block up on your
          own Bitcoin node. The{" "}
          <a href={`https://github.com/${pins.journal.repo}/tree/main/ots`}>
            proofs’ README
          </a>{" "}
          documents a sweep over every release at once. Anchoring began in
          August 2026 — the earliest attestation is in block 963,242, mined
          on 2026-08-20 UTC — so for releases created before then the RFC
          3161 receipt times remain the earlier witnesses. This adds
          anteriority that cannot be backdated, not uniqueness: it cannot
          rule out a parallel fork, and a rewritten history would carry its
          own, later, Bitcoin times.
        </p>
      </section>
    </div>
  );
}
