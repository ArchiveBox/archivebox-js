# Auditable Mercury browser build

This directory contains unchanged readable compiled parser code and browser shims
from the official `@postlight/parser` 2.2.3 npm archive. `provenance.json` records
its registry integrity, source repository/commit, declared license and SHA-256
of each retained upstream source file. The bundled Postlight browser-request
fork is retained unchanged, including its Apache-2.0 license. File suffixes were
changed to `.cjs` where required by this repository's ESM package type.

The original package installs Node-only request/OAuth dependencies even when an
application uses only its browser bundle. We instead build the same parser
module with the upstream package's documented browser mappings. Extraction
rules, site parsers, request implementation and public API are not replaced.
The npm archive's Node source maps contain an older incompatible parse API;
they are deliberately not used to reconstruct sources. The pre-minified web
bundle is also not used, because its embedded versions do not reliably match
its package metadata.

`pnpm build:mercury` verifies upstream source hashes and produces:

- `mercury.browser.js`: browser IIFE exposing the existing `Mercury` API.
- `build-metafile.json`: complete esbuild input/import graph.
- `components.json`: actual component identities, declared licenses, license
  file locations and hashes of every executable source input.
- `bom.cdx.json`: CycloneDX 1.5 component inventory with input hashes.
- `public/mercury/THIRD_PARTY_NOTICES.txt`: package notices copied into both
  extension and player distributions, including difflib’s full PSF notice from
  its README and string-direction’s upstream MIT declaration/author metadata.

Generated outputs are ignored and rebuilt by both extension/player build
commands. Versions come from the committed lockfile. The build is offline and
contains no timestamps; repeated builds on the same locked inputs are identical.

Browser dependencies remain explicit npm dependencies, so ordinary dependency
scanning retains visibility. `url` uses `qs`; the direct qs 6.16.1 pin satisfies
its declared `^6.12.3` range. `moment-timezone` accepts `moment >=2.9.0`; Moment
2.31.0 fixes its applicable advisory without an override. These are normal
resolutions, not forced dependency replacements or suppressed advisories.
The deprecated core-js 2 runtime is retained because this published compiled
parser uses it; its identity remains visible in the component inventory.

## Security checks

Run **both** `pnpm audit` (entire project/toolchain) and `pnpm audit:mercury`
(actual browser inputs, including vendored components). The latter rebuilds the
inventory and queries npm's official bulk advisory API. It fails on any returned
advisory or request failure; it does not suppress findings based on browser
reachability. An empty response means no currently indexed npm advisories for
those versions, not a security guarantee. New upstream versions must retain
source integrity and full component/license provenance.

The parent parser declares MIT. Its npm archive omits license text, so the exact
LICENSE-MIT and LICENSE-APACHE files were retrieved from the verified source
commit and retained here; their source URLs and hashes are recorded in provenance.
The difflib license is in its README. string-direction declares MIT in its
package metadata/README but has no standalone license file in the verified
source tree; the distributed notices preserve its declaration and attribution
without inventing copyright text.

## Real offline regression

Use an existing complete, genuine Sweeting article WACZ:

```sh
ABX_MERCURY_CAPTURE=/path/to/real/sweeting-blog.wacz \
  pnpm exec playwright test tests/mercury-rebuild-live.test.ts
```

The test imports through the actual application UI, renders Mercury, verifies
article text and loaded replay images, exports article HTML, and rejects page
errors or live HTTP requests. `ABX_MERCURY_RESULT` saves the real output; setting
`ABX_MERCURY_BASELINE` to a prior original-bundle result additionally requires
exact text, image/dimension and HTML equality, normalizing only extension and
per-import capture identifiers.

Keep the existing `derivations-live.test.ts` and `article-images-live.test.ts`
unchanged. The latter requires a modern capture containing a real `urn:dom:`
record. A generic older WACZ without that record cannot satisfy that regression
and must not be rewritten or substituted to pretend it does.
