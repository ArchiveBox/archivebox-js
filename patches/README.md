# Webrecorder replay and evidence patches

`@webrecorder__wabac@2.27.4.patch` applies to the exact npm package version and
integrity pinned in `pnpm-lock.yaml`. Upstream source:
https://github.com/webrecorder/wabac.js/blob/f62b924492339cf2ee069f51319ab6603f63500d/src/cdxloader.ts
(the published package's npm `gitHead`).

The indexing behavior change is in `CDXFromWARCLoader.addCdx`: retain HEAD and
OPTIONS evidence rather than dropping these records. Upstream's existing
`appendRequestQuery` gives every non-GET request a method-qualified index URL, so
HEAD and OPTIONS cannot replace or satisfy a GET lookup. Keep the complete
method/body-qualified key rather than truncating it, because truncation loses
exact extractor and revisit identity. The source and rebuilt service-worker
bundles carry the same changes; their minified lines make the diff large. No CDX
parser, WARC reader, payload resolver, or index is replaced.

Observed failure: a real Commons gallery capture preserved all 76 records in
WARC, including two HEAD probes used by gallery-dl's Wikimedia API discovery.
Upstream loaded only 74 into its replay index. Our strict sealing check correctly
refused to discard the recoverable capture database. Retaining HEAD in that same
upstream index permits both exact sealing verification and replay of the original
API-discovery responses by the source-ported extractor. WARC loading and ordinary
GET replay are unchanged. `tests/gallery-upstream-live.test.ts` exercises the real
public Commons capture, WARC request methods and offline extraction.

The upstream AGPL-3.0-or-later license remains in the patched package. This is a
local source modification, not an upstream release or a claim that the unmodified
ReplayWeb.page library indexes HEAD records.

The service-worker library also exports its existing `SingleRecordWARCLoader`
class (source, type declaration and published runtime export). Its parser is
unchanged. Plugin header queries feed this loader fully consumed 64 KiB ZIP
ranges, so stopping after headers cannot retain an unread large HTTP stream.
The original WARC parser handles compression, HTTP headers, resource records,
revisits and metadata exactly as in ordinary replay.

`FetchRangeLoader` now uses the browser's `default` cache mode for its existing
HEAD and byte-range requests instead of `no-store`. This respects the WACZ
server's Cache-Control, ETag and Content-Range headers while retaining upstream
ZIP/CDX seeking. The TypeScript source and its three published bundles carry the
same change. No extracted payload cache or whole-file download is introduced.

The existing HTML rewriter also switches its parse5 tokenizer to DATA mode inside
`noscript`, allowing the same URL/CSS handlers to rewrite fallback markup.
Otherwise parse5 emits that content verbatim; Chromium's script-disabled replay
then requests its original URLs. The retained Commons all-card test reproduced
an unrewritten CentralAutoLogin tracking image. This change keeps that fallback
request inside replay, without adding another HTML parser or live fallback.

The classic JavaScript rewriter preserves a single global binding for top-level
function declarations. Its replay block previously gave ordinary functions an
Annex B outer copy that did not follow later reassignment, and hid async and
generator declarations entirely. In a real Google Sheets capture, a stale global
lazy initializer reset the menu action registry, causing `undefined.Hl` during
startup; another script could not access the top-level async function `hul`.
The existing Acorn pass now moves these declarations to anonymous function
expressions initialized at the beginning of the replay scope, with script-level
`var` bindings. This preserves declaration hoisting and the replay globals in
their closures while keeping subsequent assignments visible across scripts.
Edits are assembled in one pass. Wabac 2.27.4's new `HoistEntry` representation
and mutable class handling remain intact. Its function-specific end-of-scope
copy is replaced by the existing single-binding logic: copying a function after
script execution still leaves later reassignment disconnected from its closure.
The TypeScript source and all three rebuilt bundles carry the same change;
archived source bytes remain unchanged.

The on-demand payload reader compares original URL query fields with
`URLSearchParams`, preserving their order, repeated names and values. POST CDX
keys can serialize spaces as `+` where the WARC URI uses `%20`; their appended
request-body query can also end with a truncated percent escape. The existing
whole-key `decodeURIComponent` comparison either rejected those identical
original URLs or threw. Only the original query fields are compared, and any
remaining fields must begin with the exact `__wb_method` boundary. Origins,
paths, fragments, literal plus signs and original query values must still match;
the previous loose URL-prefix acceptance is removed. The source and both
published payload-reader bundles carry the change. The retained real Drive
all-plugin capture exercises two affected 204 POST revisits in
`tests/replay-payloads-live.test.ts`, which reads every indexed payload through
the production endpoint, verifies its digest and checks the original archive is
unchanged.

Revisit resolution retains `WARC-Record-ID` and `WARC-Refers-To`. When IDs are
present, the referenced record must match the original URL, timestamp, payload
digest and record ID, rather than accepting an arbitrary equal-digest capture.
A revisit at the same URL and timestamp is retained if it refers to a different
record ID. Exact originals whose CDX keys include request bodies are searched in
bounded batches; MultiWACZ preloads the existing compressed index blocks. Older
producers without record IDs keep their existing URL/date fallback. Upstream
2.27.4's unrelated `nonSurt` reset is retained.

## Wombat document.write values

`@webrecorder__wombat@3.11.0.patch` converts the single argument to
`document.write`/`writeln` to its string value before the existing HTML rewriter
inspects it. These APIs accept `TrustedHTML` as well as strings
([HTML Standard](https://html.spec.whatwg.org/multipage/dynamic-markup-insertion.html#document-write-steps)).
Google Slides and Drawings pass a `TrustedHTML` object; the upstream wrapper
called `indexOf` on that object and stopped the editor's initialization. Source,
published Wombat runtime, and the Wombat text embedded in both Wabac service
worker bundles have the same correction. The existing replay rewriting and CSP
remain in place.

## SingleFile extension replay URLs

`single-file-core@1.6.24.patch` extends upstream's two resource URL validators to
accept `chrome-extension://`. The unmodified core otherwise drops extension
replay resources before calling its supported fetch adapter. That adapter still
restricts reads to this player's WACZ replay paths (and existing inline data).
No saving, CSS, font, image, or HTML processing is reimplemented.

## Rebuilding and verifying the Webrecorder patches

Wabac 2.27.4 upgrades its XML parser requirement to `fast-xml-parser@^5.7.0` and
Wombat to `^3.11.0`. The checked-in bundles are generated from their patched
sources, not modified through minified-string replacements. Generated type
signatures and declaration maps are updated with the runtime code.

Run `node scripts/rebuild-webrecorder.mjs` with Node 24 and `git`/`tar` installed.
The script writes only to a new temporary package-staging directory. It verifies
npm package integrity, downloads build configurations and dependency locks at
the exact published `gitHead` commits, applies only source hunks, and builds with
all dependency install scripts disabled. It then compares every generated
`dist` file byte-for-byte with fresh packages receiving the complete patches.
It preserves the staging directory and prints its SHA-256 manifest for review.

Build provenance:

- Wabac 2.27.4: `f62b924492339cf2ee069f51319ab6603f63500d`, its own Yarn 4.17.1
  lock, official `webpack.config.cjs` and `tsconfig.json`. The separate
  `wabac-build-lock.patch` merges the CLI-only `ansi-regex@^5.0.0` resolution
  into the already present, compatible 5.0.1 entry using Yarn's normal dedupe
  operation. This removes GHSA-93q8-gq69-wqmw without an override and does not
  change any generated distribution bytes. The patched build lock is installed
  in immutable mode.
- Wombat 3.11.0: `ad69888a2c57f8fdc408f054eaefce9c25011926`, its own frozen Yarn
  classic lock, Yarn 1.22.22 and official `rollup.config.prod.js`.
- The Wabac build consumes the patched Wombat source when generating embedded
  replay scripts. Copyright banners use the releases' 2026 year so rebuilding
  after a calendar-year change does not alter distribution bytes.

Focused unit checks are supplementary to browser integration. Before release,
run the existing capture/replay, payload, Google editor, gallery and browser
HTTP-cache tests against the installed patches, including real TrustedHTML
values in Chromium. Passing source-level checks alone is not a full replay pass.

The emitted browser dependency graph and the build's production dependency
install have no reported npm advisories at this revision. The complete upstream
development toolchain still has findings in lint/test/server dependencies and
some build-time dependencies; it is not claimed advisory-free. Keep rebuilds
isolated and retain the full audit report when changing that toolchain. These
packages are not shipped in the rebuilt browser bundles.
