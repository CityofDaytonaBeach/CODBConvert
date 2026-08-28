import { useCallback, useRef, useState } from "react";
import { codb, report } from "./codb";
import type { CODBInput, CODBOutput } from "@codb/core";

type OpId = "merge" | "toImages" | "imageConvert" | "office" | "extractText";

interface Status {
  phase: string;
  percent: number;
  message?: string;
}

export function App() {
  const [files, setFiles] = useState<File[]>([]);
  const [format, setFormat] = useState("webp");
  const [status, setStatus] = useState<Status | null>(null);
  const [resultName, setResultName] = useState<string | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const onFiles = useCallback((list: FileList | null) => {
    if (!list) return;
    setFiles(Array.from(list));
    setResultName(null);
    setResultUrl(null);
    setError(null);
  }, []);

  const run = useCallback(
    async (op: OpId) => {
      if (files.length === 0) return;
      setBusy(true);
      setError(null);
      setResultName(null);
      setResultUrl(null);
      setStatus({ phase: "preparing", percent: 0 });
      try {
        const cfg = { onProgress: (p: Status) => setStatus(p) };
        let output: CODBOutput | null = null;
        let filename = `codb-${op}.bin`;

        if (op === "merge") {
          output = await codb.pdf.merge(files as CODBInput[], cfg);
          filename = "merged.pdf";
        } else if (op === "extractText") {
          const text = await codb.extractText(files[0], { ...cfg, to: "txt" });
          output = new TextEncoder().encode(text);
          filename = "extracted.txt";
        } else if (op === "toImages") {
          const blob = (await codb.pdf.toImages(files[0], {
            format: format as "png" | "webp",
            scale: 1,
            ...cfg,
          })) as Uint8Array;
          filename = `pdf-pages.${format}`;
          output = blob;
        } else if (op === "imageConvert") {
          const blob = (await codb.image.convert(files[0], {
            format: format as "png" | "webp" | "jpeg",
            quality: 0.9,
            ...cfg,
          })) as Uint8Array;
          filename = `image-${Date.now()}.${format}`;
          output = blob;
        } else if (op === "office") {
          output = await codb.convert(files[0], { to: "json", ...cfg });
          filename = `${files[0].name.replace(/\.[^.]+$/, "")}.json`;
        }

        if (output) {
          const blob = output instanceof Blob
            ? output
            : new Blob([output as BlobPart]);
          const url = URL.createObjectURL(blob);
          setResultUrl(url);
          setResultName(filename);
        }
        setStatus({ phase: "done", percent: 100 });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setStatus(null);
      } finally {
        setBusy(false);
      }
    },
    [files, format],
  );

  const caps = report.available;
  const capChips = (Object.keys(caps) as Array<keyof typeof caps>)
    .filter((k) => caps[k])
    .join(", ");

  return (
    <div className="shell">
      <header>
        <h1>CODBConvert</h1>
        <p className="tagline">Browser-first document &amp; media conversion runtime</p>
        <p className="caps">Capabilities: {capChips || "none"} · env: {report.env}</p>
      </header>

      <section className="drop"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          onFiles(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => onFiles(e.target.files)}
        />
        {files.length === 0 ? (
          <p>Drop files here, or click to browse.</p>
        ) : (
          <ul className="filelist">
            {files.map((f, i) => (
              <li key={i}>{f.name} <span>{fmtBytes(f.size)}</span></li>
            ))}
          </ul>
        )}
      </section>

      <section className="controls">
        <label className="field">
          Output format
          <select value={format} onChange={(e) => setFormat(e.target.value)}>
            <option value="webp">webp</option>
            <option value="png">png</option>
            <option value="jpeg">jpeg</option>
          </select>
        </label>

        <div className="buttons">
          <button onClick={() => run("merge")} disabled={busy || files.length < 2}>
            Merge PDFs
          </button>
          <button onClick={() => run("toImages")} disabled={busy || files.length === 0}>
            PDF → images
          </button>
          <button onClick={() => run("imageConvert")} disabled={busy || files.length === 0}>
            Convert image
          </button>
          <button onClick={() => run("office")} disabled={busy || files.length === 0}>
            DOCX/XLSX → JSON
          </button>
          <button onClick={() => run("extractText")} disabled={busy || files.length === 0}>
            Extract text
          </button>
        </div>
      </section>

      {status && (
        <section className="status">
          <progress value={status.percent} max={100} />
          <span>{status.phase} {status.percent}%</span>
        </section>
      )}

      {error && <section className="error">{error}</section>}

      {resultUrl && resultName && (
        <section className="result">
          <a href={resultUrl} download={resultName}>{resultName}</a>
          <button onClick={() => { URL.revokeObjectURL(resultUrl); setResultUrl(null); }}>
            Clear
          </button>
        </section>
      )}
    </div>
  );
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
