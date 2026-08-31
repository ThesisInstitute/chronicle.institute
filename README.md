# Chronicle reference app

Read-only web app over the Thesis Institute's fact store — **Chronicle**
(formerly Ledger; renamed 2026-08-07) — live at `chronicle.institute`, with
`ledger.thesisinstitute.org` 308-redirecting there. Next.js App Router + bun +
Tailwind v4; Chronicle tokens inlined in
[src/app/globals.css](src/app/globals.css) (master set:
`constellation-design/tokens/chronicle.css`). The upstream repo is now
`PolicyEngine/chronicle` (GitHub redirects the old URL) with CLI `chronicle`
(`ledger` kept as an alias); the v1 machine surface keeps its names — schema
ids `ledger.*`, fact-identity hash domains, R2 buckets `ledger-raw`/`-derived`,
and the journal data paths under `data/` stay put until the gated canonical-URL
migration PR.

## Where this lives

`ThesisInstitute/chronicle.institute` — split out of
`ThesisInstitute/thesisinstitute.org` on 2026-08-30, where the app had been the
`ledger/` subdirectory since it was built. History came with it: every commit
that ever touched the app is here, rewritten to this repo's root. The domain
had already moved in the August rename; this moves the code to match, and gives
the app the CI it never had as a subdirectory.

Production is `chronicle.institute`, built by the Vercel project `chronicle`
from `main`. `ledger.thesisinstitute.org` and `www.chronicle.institute` redirect
there. Deploys are git-integrated: push to `main` and Vercel builds it.

**Unlisted until the public launch decision**: every response carries
`X-Robots-Tag: noindex, nofollow`, `metadata.robots` is noindex, and
`robots.txt` disallows all. Remove the three together at launch
([next.config.ts](next.config.ts), [src/app/layout.tsx](src/app/layout.tsx),
[src/app/robots.ts](src/app/robots.ts)). The app is not linked from
thesisinstitute.org navigation.

## What it serves

Two fact populations, kept distinct because their guarantees differ:

- **Journal** (`/journal/{source_record_id}`) — the witnessed first-print
  observation feed from PolicyEngine/ledger's `codex/thesis-ledger-facts`
  branch, joined with brier's per-row acceptance index. The `/verify` page
  re-runs the release-chain checks in the browser over the exact committed
  bytes and labels precisely what it cannot check (RFC 3161 signature chains
  → offline verifier).
- **Store** (`/store/{aggregate-key-hash}`) — consumer facts built from
  PolicyEngine/ledger main with `ledger build-bundle`, one gzipped file per
  source package under `data/store/packages/`.

Every fact page carries a one-line citation (format `draft-2`, versioned in
[src/lib/citation.ts](src/lib/citation.ts)) with the fact ID, recorded value,
first-print date, source, and position (journal line + release, or store
snapshot pin). The same data is served as JSON under `/api/*` — see
`/about#api`.

## Data is a pinned snapshot

The app has no runtime upstream dependency. Everything under `data/` was
vendored at the commits recorded in [data/pins.json](data/pins.json), which
`/api/pins` and the page footer expose. Journal bytes are vendored exactly;
tests assert byte-for-byte agreement with the genesis release manifest.

To refresh (produces a reviewable diff; snapshot updates ship as PRs):

```bash
LEDGER_REPO=~/PolicyEngine/ledger scripts/refresh-data.sh
```

## Light and dark

The register follows the reader's system by default and can be set explicitly
from the control in the header — system, light, dark. Every colour token in
[src/app/globals.css](src/app/globals.css) is written once as
`light-dark(light, dark)`; which half applies is decided by `color-scheme` on
`:root`, which the choice flips via a `data-theme` attribute. Two consequences:
the two registers cannot drift, because there is one place to edit a colour;
and with no choice stored the page is system-aware with no JavaScript at all.

The floor is `light-dark()` — Chrome 123 / Firefox 120 / Safari 17.5, Baseline
since mid-2024. Below it the palette drops to UA defaults entirely: readable,
because `color-scheme` still keeps canvas and text coherent, but unstyled. That
is a deliberate trade against keeping a second hard-coded palette, which is the
drift the single definition exists to prevent.

The choice lives in this browser's `localStorage` (`chronicle:register`) and is
applied by a small script in `<head>` before first paint, so a chosen register
never flashes the other one. Nothing about it reaches the server, and no page of
the record renders differently because of it. Logic and invariants:
[src/lib/theme.ts](src/lib/theme.ts), [tests/theme.test.ts](tests/theme.test.ts).

## Develop

```bash
bun install
bun run dev        # http://localhost:3000
bun run test       # vitest: chain verifier vs real bytes, citations, invariants
bun run typecheck
bun run build
```

## Honesty rails

- Witness status wording comes from [src/lib/status.ts](src/lib/status.ts)
  only; nothing is labeled "verified" that a verifier did not verify. Zero
  rows are witness-verified today: the genesis release witnesses the state,
  not any row's acceptance time.
- Custody enums (`append_derived`, `rewritten_in_place`) render verbatim,
  with the 13 pre-enforcement rewrites flagged, not hidden.
- Values render exactly as recorded — duplicate captures (including
  unit-inconsistent ones) are shown side by side on `/revisions`.
- No mock data anywhere; every number traces to the pinned snapshot.
