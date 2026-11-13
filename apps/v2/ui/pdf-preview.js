import { esc, icon } from '/ui/common.js';

export class PdfPreview {
  constructor(host, onClose = () => {}) {
    this.host = host;
    this.onClose = onClose;
    this.generation = 0;
    this.queue = Promise.resolve();
    this.resize = new ResizeObserver(() => this.draw());
    this.resize.observe(host);
  }

  async open(url, name) {
    const generation = ++this.generation;
    const previous = this.loading;
    this.pdf = null;
    if (previous) previous.destroy().catch(() => {});
    this.host.hidden = false;
    this.host.innerHTML = `<header><div class="pdf-name">${esc(name)}</div><button class="btn quiet" data-close aria-label="Close PDF">${icon('x')}</button></header>
      <div class="pdf-tools"><button class="btn" data-prev aria-label="Previous page">←</button><label>Page <input type="number" data-page min="1" value="1" aria-label="PDF page"></label><span data-total></span><button class="btn" data-next aria-label="Next page">→</button><a class="btn quiet" href="${esc(url + '&download=1')}" download>Download</a></div>
      <div class="pdf-status" role="status">Loading PDF…</div><div class="pdf-page"><canvas aria-label="PDF page"></canvas></div>`;
    this.host.querySelector('[data-close]').onclick = () => this.close();
    this.host.querySelector('[data-prev]').onclick = () => this.go(this.page - 1);
    this.host.querySelector('[data-next]').onclick = () => this.go(this.page + 1);
    this.host.querySelector('[data-page]').onchange = (e) => this.go(Number(e.target.value));
    this.page = 1;
    try {
      const pdfjs = await import('/vendor/pdfjs/pdf.min.mjs');
      if (generation !== this.generation) return;
      pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
      this.loading = pdfjs.getDocument({ url, cMapUrl: '/vendor/pdfjs/cmaps/', cMapPacked: true,
        standardFontDataUrl: '/vendor/pdfjs/standard_fonts/', wasmUrl: '/vendor/pdfjs/wasm/',
        isEvalSupported: false });
      const pdf = await this.loading.promise;
      if (generation !== this.generation) return;
      this.pdf = pdf;
      this.host.querySelector('[data-total]').textContent = `of ${pdf.numPages}`;
      this.host.querySelector('[data-page]').max = pdf.numPages;
      await this.draw();
    } catch (e) {
      if (generation === this.generation) this.status(`Could not render this PDF. ${e.message || 'Try downloading it.'}`);
    }
  }

  status(text) { const el = this.host.querySelector('.pdf-status'); if (el) el.textContent = text; }

  go(page) {
    if (!this.pdf) return;
    this.page = Math.max(1, Math.min(this.pdf.numPages, Math.trunc(page) || 1));
    this.host.querySelector('[data-page]').value = this.page;
    this.draw();
  }

  draw() {
    if (!this.pdf || this.host.hidden) return;
    const generation = this.generation, pageNumber = this.page;

    this.queue = this.queue.catch(() => {}).then(async () => {
      if (generation !== this.generation || !this.pdf || pageNumber !== this.page) return;
      const page = await this.pdf.getPage(pageNumber);
      if (generation !== this.generation || pageNumber !== this.page) return;
      const canvas = this.host.querySelector('canvas');
      const width = Math.max(100, this.host.querySelector('.pdf-page').clientWidth - 24);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(width / base.width, 2);
      const viewport = page.getViewport({ scale });
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.ceil(viewport.width * ratio);
      canvas.height = Math.ceil(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport, transform: [ratio, 0, 0, ratio, 0, 0] }).promise;
      if (generation !== this.generation) return;
      this.status('');
      this.host.querySelector('[data-prev]').disabled = pageNumber <= 1;
      this.host.querySelector('[data-next]').disabled = pageNumber >= this.pdf.numPages;
    }).catch((e) => { if (generation === this.generation) this.status(e.message); });
    return this.queue;
  }

  close() {
    ++this.generation;
    this.pdf = null;
    this.loading?.destroy().catch(() => {});
    this.loading = null;
    this.host.hidden = true;
    this.host.replaceChildren();
    this.onClose();
  }
}
