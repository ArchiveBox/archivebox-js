// Compiled original gdrive/dropbox full.html script; only archived file access is injected.

export function initializeCloudFiles(document, manifest, options) {
        const byId = (id) => document.getElementById(id),
          el = (tag, text, cls) => {
            const n = document.createElement(tag);
            if (text != null) n.textContent = text;
            if (cls) n.className = cls;
            return n;
          };

        const bytes = (n) =>
          n < 1024
            ? n + " B"
            : n < 1048576
            ? (n / 1024).toFixed(1) + " KB"
            : n < 1073741824
            ? (n / 1048576).toFixed(1) + " MB"
            : (n / 1073741824).toFixed(2) + " GB";
        const valid = (path) =>
          typeof path === "string" &&
          path.startsWith("files/") &&
          !path.split("/").some((p) => !p || p === "." || p === "..") &&
          !path.includes("\\");
        const fileURL = file => options.url(file);
        let files = [],
          prefix = "",
          selected = null,
          controller = null;
        const clearPreview = () => {
          controller?.abort();
          byId("content").replaceChildren();
        };
        const report = (error) => {
          if (error.name !== "AbortError")
            byId("error").textContent = error.message;
        };
        function browse(next) {
          prefix = next;
          const filter = byId("search").value.toLowerCase(),
            crumbs = byId("breadcrumbs");
          crumbs.replaceChildren();
          const crumb = (label, path) => {
            const b = el("button", label);
            b.onclick = () => {
              byId("search").value = "";
              browse(path);
            };
            crumbs.append(b);
          };
          crumb("Files", "");
          let part = "";
          for (const segment of prefix.split("/").filter(Boolean)) {
            part += segment + "/";
            crumbs.append(el("span", "/"));
            crumb(segment, part);
          }
          const items = new Map();
          for (const f of files) {
            if (!f.filename.startsWith(prefix)) continue;
            const tail = f.filename.slice(prefix.length),
              name = tail.split("/")[0];
            if (!name || !name.toLowerCase().includes(filter)) continue;
            const directory = tail.includes("/");
            if (!items.has(name) || directory)
              items.set(
                name,
                directory ? { filename: prefix + name, directory: true } : f
              );
          }
          const table = byId("entries");
          table.replaceChildren();
          for (const file of [...items.values()].sort(
            (a, b) =>
              Number(b.directory) - Number(a.directory) ||
              a.filename.localeCompare(b.filename)
          )) {
            const row = el("tr");
            if (file === selected) row.className = "selected";
            const name = el("td", null, "name"),
              button = el("button", null, "entry");
            button.append(
              el("span", file.directory ? "📁" : "📄"),
              el("span", file.filename.slice(prefix.length))
            );
            button.onclick = () =>
              file.directory ? browse(file.filename + "/") : openFile(file).catch(report);
            name.append(button);
            row.append(
              name,
              el("td", file.directory ? "—" : bytes(file.size), "size")
            );
            table.append(row);
          }
          byId("count").textContent = items.size + " items";
          if (!items.size) {
            const row = el("tr"),
              cell = el("td", "No files", "empty");
            cell.colSpan = 2;
            row.append(cell);
            table.append(row);
          }
        }
        async function openFile(file) {
          clearPreview();
          selected = file;
          controller = new AbortController();
          const signal = controller.signal;
          byId("error").textContent = "";
          byId("preview").hidden = false;
          byId("filename").textContent = file.filename.split("/").pop();
          const url = await fileURL(file);
          if(signal.aborted)return;
          byId("download").onclick = () => options.download(file).catch(report);
          browse(prefix);
          const content = byId("content"),
            ext = file.filename.split(".").pop().toLowerCase();
          if (ext === "zip") {
            const link = el("button", "Browse archive");
            link.onclick = () => options.browseZip(file, document).catch(report);
            content.append(link);
            return;
          }
          if (file.size > 16 * 1024 * 1024) {
            content.append(
              el("span", "File is too large to preview. Use Download.", "empty")
            );
            return;
          }
          if (
            ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp"].includes(ext)
          ) {
            const img = el("img");
            img.alt = file.filename;
            img.src = url;
            content.append(img);
          } else if (ext === "pdf") {
            const frame = el("iframe");
            frame.title = file.filename;
            
            frame.src = url;
            content.append(frame);
          } else if (["mp3", "ogg", "wav", "mp4", "webm"].includes(ext)) {
            const media = el(["mp4", "webm"].includes(ext) ? "video" : "audio");
            media.controls = true;
            media.src = url;
            content.append(media);
          } else if (
            /^(txt|md|csv|tsv|json|xml|html?|css|js|py|log|ya?ml|svg|rtf)$/.test(
              ext
            )
          ) {
            content.append(el("span", "Loading…", "empty"));
            try {
              const response = await fetch(url, { signal });
              if (!response.ok) throw Error("File unavailable");
              const text = await response.text();
              if (!signal.aborted) content.replaceChildren(el("pre", text));
            } catch (error) {
              report(error);
            }
          } else
            content.append(
              el(
                "span",
                "Preview unavailable for this file type. Use Download.",
                "empty"
              )
            );
        }
        byId("search").oninput = () => browse(prefix);
        byId("close").onclick = () => {
          clearPreview();
          selected = null;
          byId("preview").hidden = true;
          browse(prefix);
        };
        byId("title").textContent = manifest.title || "Saved files";
        document.title = byId("title").textContent;
        files = (manifest.files || []).filter(f => valid(f.path)).map(f => ({...f, filename:f.path.slice(6)}));
        browse("");
return clearPreview;
}