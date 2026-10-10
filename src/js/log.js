// The live log. Entries queue up and appear one at a time, each sliding the list down and
// arriving in white before settling, so the panel reads as a feed rather than a static table.

const STEP_MS = 900;
const KEEP = 40;
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pad = n => String(n).padStart(2, '0');
const stamp = d => `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;

export class Log {
  constructor(list, { reducedMotion = false, onCount } = {}) {
    this.list = list;
    this.queue = [];
    this.count = 0;
    this.still = reducedMotion;
    this.onCount = onCount;
    setInterval(() => this.step(), STEP_MS);
  }

  // entry: { t, tag, text, cls }. Entries waiting to show are capped so a burst can't back up.
  push(entry) {
    this.queue.push(entry);
    if (this.queue.length > 24) this.queue.splice(0, this.queue.length - 24);
  }

  step() {
    if (document.hidden || !this.queue.length) return;
    const e = this.queue.shift();
    const li = document.createElement('li');
    li.className = 'new';
    li.innerHTML = `<time datetime="${new Date(e.t).toISOString()}">${stamp(new Date(e.t))}</time>` +
      `<span class="t ${e.cls ?? ''}">${esc(e.tag)}</span><span>${esc(e.text)}</span>`;
    this.list.prepend(li);
    while (this.list.children.length > KEEP) this.list.lastElementChild.remove();
    this.count++;
    this.onCount?.(this.count);
    setTimeout(() => li.classList.remove('new'), 1200);
    if (this.still) return;
    // Slide everything down by one line over 160 ms.
    const h = li.getBoundingClientRect().height;
    this.list.style.transition = 'none';
    this.list.style.transform = `translateY(${-h}px)`;
    void this.list.offsetHeight;
    this.list.style.transition = 'transform 160ms ease-out';
    this.list.style.transform = '';
  }
}
