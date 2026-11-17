import { useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// This module is loaded on demand (see PreviewDialog), so pdf.js is only
// downloaded when someone opens a PDF preview.
pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

// Served by the pdfjsAssets plugin in vite.config.js.
const ASSETS = `${import.meta.env.BASE_URL}pdfjs/`;
const MAX_PIXEL_RATIO = 2; // sharp on high-density screens without huge canvases

// One page. It is drawn when it scrolls near the visible area and discarded
// when it leaves, so a long document only holds a few canvases at a time.
function Page({ pdf, number, defaultRatio, scroller }) {
  const sheet = useRef(null);
  const [near, setNear] = useState(false);
  const [ratio, setRatio] = useState(defaultRatio);

  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), {
      root: scroller.current,
      rootMargin: '400px 0px',
    });
    observer.observe(sheet.current);
    return () => observer.disconnect();
  }, [scroller]);

  useEffect(() => {
    if (!near) return;
    const el = sheet.current;
    let cancelled = false;
    let task;
    (async () => {
      const page = await pdf.getPage(number);
      if (cancelled) return;
      const natural = page.getViewport({ scale: 1 });
      setRatio(natural.width / natural.height);
      const scale = (el.clientWidth / natural.width) * Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
      const viewport = page.getViewport({ scale });
      // Drawn off-screen and swapped in when complete, so a page never shows half-painted.
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      task = page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport });
      await task.promise;
      if (!cancelled) el.replaceChildren(canvas);
    })().catch(() => {}); // a cancelled draw rejects; a page that fails stays blank
    return () => {
      cancelled = true;
      task?.cancel();
      for (const canvas of el.children) canvas.width = 0; // release the bitmap now, not at the next GC
      el.replaceChildren();
    };
  }, [near, pdf, number]);

  return (
    <div className="pv-page">
      <div ref={sheet} className="pv-sheet" style={{ aspectRatio: ratio }} />
      <span className="num">{number}</span>
    </div>
  );
}

// Renders every page of a PDF Blob as a scrolling stack.
// onPages receives the page count once the document has opened; onError is
// called if it cannot be opened (damaged, or locked with its own password).
export default function PdfPages({ blob, onPages, onError }) {
  const scroller = useRef(null);
  const [doc, setDoc] = useState(null); // { pdf, ratio } once opened
  const callbacks = useRef({ onPages, onError });
  callbacks.current = { onPages, onError };

  useEffect(() => {
    let live = true;
    let task;
    (async () => {
      const data = new Uint8Array(await blob.arrayBuffer());
      if (!live) return;
      task = pdfjs.getDocument({
        data,
        cMapUrl: `${ASSETS}cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `${ASSETS}standard_fonts/`,
        wasmUrl: `${ASSETS}wasm/`,
        iccUrl: `${ASSETS}iccs/`,
      });
      const pdf = await task.promise;
      const first = (await pdf.getPage(1)).getViewport({ scale: 1 });
      if (!live) return;
      setDoc({ pdf, ratio: first.width / first.height });
      callbacks.current.onPages(pdf.numPages);
    })().catch(() => { if (live) callbacks.current.onError(); });
    return () => {
      live = false;
      setDoc(null);
      task?.destroy();
    };
  }, [blob]);

  return (
    <div ref={scroller} className="pv-pages" tabIndex={0} role="group" aria-label="Document pages">
      {doc
        ? Array.from({ length: doc.pdf.numPages }, (_, i) => (
          <Page key={i} pdf={doc.pdf} number={i + 1} defaultRatio={doc.ratio} scroller={scroller} />
        ))
        : <span className="pv-note">Loading preview…</span>}
    </div>
  );
}
