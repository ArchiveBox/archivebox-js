# ArchiveBox snapshot presentation

Source: canonical ArchiveBox and abx-plugins checkouts, 2026-10-03. Original snapshot templates, output taxonomy, plugin configs and templates are retained with SHA256SUMS. snapshot.css is their CSS inside a CSS @scope (body-level .snapshot-stacks selectors target :scope.snapshot-stacks). stacks.js is the original stack controller with a scoped root, supplied preview callback, disposal, and server-only orphan file discovery removed. WACZ entries provide the Other files inventory. SnapshotDetail ports template markup and data binding; plugin templates keep their own viewers. No Django runtime or saved derived report files are required.

Source checkout HEADs at vendoring: ArchiveBox `da52653575b7624b2197ca609c9d7408514537cb`; abx-plugins `477ccfe842deaa395fd71118115a85375365da64`. Template bytes are identified by SHA256SUMS. Server-only source-selection clauses and dependencies for omitted plugins are removed from these local templates and configs. abx-plugins copyright is retained in PLUGINS-LICENSE.

SEO uses the literal vendored `plugins/seo/full.html` document and styles with
its script compiled in `src/ui/seo-template.ts`. The original DOM construction,
field precedence, badges, social links, image error handling and SVG icons are
retained. The shared canonical wrapper supplies the derived JSON and output
actions; exact WACZ response references replace Django's response/favicon file
lists. No featured-image copy or generated SEO report is stored in the WACZ.

Console and Hashes retain their literal vendored full documents and styles.
`src/ui/console-template.js` and `src/ui/hashes-template.js` compile their
original inline renderers, replacing filesystem fetches with transient data.
Console rows are derived from captured CDP events; hash-tree leaves are the
WACZ manifest's actual package member paths, byte counts, and SHA-256 digests.
The canonical Merkle construction combines adjacent hexadecimal leaf hashes,
duplicating the last leaf for odd levels, as the original hashes hook does.
Opening the viewer does not re-read or duplicate archived payloads.

SSL Certificates and Accessibility likewise use their literal full documents
and compiled original renderers (`src/ui/sslcerts-template.ts` and
`src/ui/accessibility-template.ts`). Existing X.509 and CDP/DOM adapters supply
the canonical models. Certificate PEM actions use transient URLs for the
original DER-derived PEM strings, released on unmount; no additional PEM files
are captured. The separate React metadata layouts and copied stylesheets were
removed.
