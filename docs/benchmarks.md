# Default capture comparison

[Project architecture](../README.md) · [Plugin ports and coverage](plugin-ports.md)

This comparison captures **both `https://sweeting.me` and `https://docs.sweeting.me/s/blog`**, separately, with the tools' default plugins and settings. Measurements were taken on October 4, 2026 using real public pages, fresh collections/browser profiles, and the normal capture interfaces.

![Final snapshot storage for the two URLs](assets/capture-size.svg)

## Results

**The blog WACZ uses about 82% less disk space; the `sweeting.me` WACZ uses about 11% less.** The blog's native MHTML, SingleFile, PDF, response files, and WACZ each contain substantial copies of its assets. The landing page's ten audio tracks dominate both formats and are already compressed.

Ranges below cover two runs of each engine on each URL. MB means 1,000,000 bytes; RAM uses GiB. CPU, memory, disk activity, and network bytes are sampled process-tree measurements with the limits described below.

| Metric | sweeting.me — ArchiveBox | sweeting.me — JS/WACZ | docs.sweeting.me/s/blog — ArchiveBox | docs.sweeting.me/s/blog — JS/WACZ |
| --- | ---: | ---: | ---: | ---: |
| **End-to-end wall time** | **36.8–63.2 s** | **33.3–34.8 s** | **70.0–70.1 s** | **125.3–130.0 s** |
| CPU time, summed across sampled processes | 31.0–57.5 s | 30.3–32.3 s | 78.9–80.6 s | 98.8–102.8 s |
| Peak combined resident RAM | 4.16–4.21 GiB | 3.30–3.44 GiB | 9.03–10.43 GiB | 4.55–4.79 GiB |
| Peak combined physical footprint | 2.41–2.46 GiB | 2.25–2.27 GiB | 7.69–7.96 GiB | 3.45–3.58 GiB |
| Disk read activity | 165.9–170.9 MB | 322.8–338.2 MB | 458.2–476.3 MB | 311.9–441.3 MB |
| Disk write activity | 300.8–1,110.8 MB | 292.8–298.2 MB | 1,998.2–2,005.1 MB | 414.2–434.3 MB |
| IOPS | Not measured | Not measured | Not measured | Not measured |
| External network received | 74.1–74.5 MB | 36.58–36.59 MB | 130.6–134.2 MB | 53.4–53.7 MB |
| External network sent | 0.305–0.316 MB | 0.171–0.175 MB | 0.745–0.773 MB | 0.106–0.164 MB |
| Browser HTTP requests sent¹ | 50 | 207 | 415 | 155–157 |
| **Final allocated disk space** | **41.51–41.52 MB** | **36.92–36.93 MB** | **320.25–320.26 MB** | **57.23–57.24 MB** |
| Final logical file bytes | 41.03–41.04 MB | 36.92–36.93 MB | 319.59–319.60 MB | 57.23–57.24 MB |

¹ Native command-line downloader requests are additional and are not observed by Chrome NetLog. The native browser column must not be interpreted as its total request count; the JS plugin requests run through Chrome and appear in that column. External byte measurements cover the sampled process tree in both cases.

- **All eight runs completed without failed capture hooks.** The default native suite ran 50 snapshot hooks across 46 plugin namespaces. JS enabled all 48 namespaces, with 27 capture hooks across 26 namespaces and the remaining outputs provided through derived/shared views. These counts describe different plugin organizations, not equivalent independent engines.
- **The audio selection matches:** both engines selected the same ten SoundCloud track IDs and format IDs on `sweeting.me`. Native yt-dlp saved about 33.0 MB of assembled audio, plus artwork and metadata; WACZ preserves the originals and fragments for replay-time assembly. Both found no yt-dlp media on the blog.
- **The blog's JS run does more OCR work:** all 77 selected originals were parsed, taking approximately 70–72 seconds inside the capture. Native LiteParse returned no extracted content under its defaults. JS also ran the separate 30-second Browsertrix behavior phase. Its smaller archive does not mean every workload completes faster.
- **Some work moves to viewing:** SingleFile, printed PDF, article views, and other derived presentations are not generated during JS capture. Their first-open cost is excluded from the capture times, while OCR and the searchable text index are included.
- **Native timing varied substantially on `sweeting.me`.** Both repeated results are shown rather than presenting the fastest or slowest run as a general speed claim.

### Where the blog's bytes go

The first native blog snapshot contains these major outputs, counting shared files once:

| Native plugin directory | Logical bytes |
| --- | ---: |
| SingleFile | 72.04 MB |
| MHTML | 71.85 MB |
| Printed PDF | 58.41 MB |
| Responses | 56.47 MB |
| ArchiveWeb.page WACZ | 53.33 MB |
| Downloaded page assets | 7.54 MB |
| Screenshots | 0.89 MB |

The JS archive is 57.23 MB **including** shared original responses, ten PNG screenshot pages plus a JPEG preview, OCR results, the search index, hook observations, and WACZ indexes. MHTML has no browser-plugin equivalent here; SingleFile and PDF are generated from replay when requested. Screenshot defaults also differ: native captures a full-page PNG, while JS caps numbered screenshots at its default ten pages.

The native CLI reported roughly 403 MiB for the blog, but following its alternate filesystem links counts some payloads repeatedly. The table uses measured regular-file inodes and allocated filesystem blocks, not that application total. It also keeps native files uncompressed as requested; the native WACZ output is already compressed, and the other native representations are ordinary files.

[Download the complete measurement summary](benchmarks/2026-10-04.json), including individual runs, hook outcomes, per-plugin sizes, media selections, and WACZ SHA-256 hashes. [Plugin ports and coverage](plugin-ports.md) explains which outputs are native JS, which use Pyodide/WASM, and which native integrations are absent.

## Method

- **Host:** Apple M5 Max, 18 CPU cores, 64 GiB RAM, macOS 27.0. Runs execute sequentially on the same development machine, with two fresh captures per engine per URL. Host filesystem caches and upstream/CDN caches are not flushed.
- **ArchiveBox:** the normal `archivebox add --depth=0 --max-urls=1 URL` command, using its default plugin selection and browser resolution. Dependencies are already installed; every run starts with a new initialized collection and persona. Collection initialization is outside the timed interval.
- **Versions:** ArchiveBox 0.9.72rc82 with abx-dl 1.13.113, abx-plugins 1.13.138, abxpkg 1.13.28, and abxbus 2.5.74; ArchiveBox JS 0.1.0 using this repository's bundled engines and lockfile.
- **ArchiveBox JS:** the built extension in its normal Playwright Chromium harness, a fresh profile, and the studio's Capture tab / Download WACZ flow. All 48 plugin checkboxes are checked. There are no plugin, timeout, media-quality, viewport, or browser-path overrides.
- **Browser defaults:** ArchiveBox resolves the installed Chrome 156.0.8078.4; the extension harness uses its bundled Chrome for Testing 148.0.7778.96. Browser builds are recorded from NetLog, without forcing them to match. The only native capture setting added is Chrome's passive NetLog output path.
- **Time:** monotonic wall clock around the entire command, including browser startup and capture finalization/export. JS also records click-to-export time. These are elapsed times, not summed hook durations. Viewing derived SingleFile/PDF/article/forum outputs afterward is outside the capture interval.
- **CPU and memory:** a roughly 200 ms process-tree sampler uses macOS `proc_pid_rusage`. CPU Mach ticks are converted using the host timebase. RAM is the maximum simultaneous sum of resident bytes, with physical-footprint totals retained in the JSON. Shared pages can appear in multiple processes' RSS, and short-lived processes can fall between samples.
- **Disk activity:** sampled per-process disk bytes read/written, including temporary browser profiles and processing. These differ from final output size. IOPS are not measured: this unprivileged macOS setup does not expose per-process I/O operation counts through the sampler.
- **Network:** `nettop` samples external-interface byte counters for the same process tree, excluding localhost CDP traffic. These are lower bounds because processes/connections can finish between samples. NetLog counts actual browser HTTP request-header sends across HTTP/1, HTTP/2, and HTTP/3. ArchiveBox's additional native CLI requests are outside NetLog, so its browser count is not an all-process request total.
- **Output size:** final native snapshot directory versus exported WACZ. Allocated bytes use filesystem block counts; logical bytes count each regular-file inode once. Symlink targets and hard links are not counted repeatedly. Databases, crawl setup, downloaded engines, browser profiles, and benchmark logs are excluded. WACZ hashes and per-plugin sizes are retained in the JSON.

The small sample describes these pages and defaults. It is not a universal speed ratio: network latency, browser defaults, plugin applicability, and the amount of OCR or media vary between captures.

## Reproduce

The measurement helpers are macOS-specific; the capture itself remains the normal application flow. Use `uv` for the Python monitor and report commands.

```sh
# Build once, outside the measured interval.
pnpm install --frozen-lockfile
pnpm build
pnpm exec playwright install chromium

# Run from this repository, with results outside the checkout.
ABX_BENCHMARK_URL=https://docs.sweeting.me/s/blog \
ABX_BENCHMARK_OUTPUT=/tmp/abx-benchmark/blog-extension \
uv run --no-project python scripts/benchmark-process.py \
  --output /tmp/abx-benchmark/blog-extension/measurement \
  -- node scripts/benchmark-capture.mjs
```

For native ArchiveBox, initialize a fresh collection, then wrap the ordinary CLI command with the same monitor. Set `CHROME_ARGS_EXTRA` only to the `--log-net-log=/absolute/path/netlog.json` recording option. Leave the browser, plugin selection, and all extraction settings at their defaults. Run each URL independently at depth zero and repeat with another fresh collection/profile.

```sh
uv run --no-project python scripts/benchmark-report.py \
  /tmp/abx-benchmark /tmp/abx-benchmark/summary.json
```

The report expects paired `native` / `extension` and `blog-native` / `blog-extension` directories, with optional `-2` repeats. Each native directory contains `collection/`, `measurement/metrics.json`, and `netlog.json`; each extension directory contains its WACZ, capture/timing records, metrics, and NetLog. Raw logs and original archives stay outside the repository; the published summary contains measurements, hook outcomes, format selections, and hashes.
