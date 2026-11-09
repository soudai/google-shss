// Uploads run in the background so the import dialog can close and the viewer
// stays usable. Jobs run one at a time to keep upload bandwidth and the
// server's write lock for one document at a time.

let nextId = 0;

export class ImportQueue {
  constructor(send, {changed = () => {}, finished = () => {}} = {}) {
    Object.assign(this, {send, changed, finished});
    this.jobs = [];
    this.running = false;
  }
  get busy() {return this.jobs.some(job => job.state === 'queued' || job.state === 'uploading');}
  get active() {return this.jobs.filter(job => job.state === 'queued' || job.state === 'uploading');}
  get failed() {return this.jobs.filter(job => job.state === 'failed');}

  // target is the document ID for a new version, or null for a new document.
  enqueue({label, target = null, title, input}) {
    const job = {id: ++nextId, label, target, title, desiredTitle: title, input, state: 'queued', sent: false, unknown: false, error: null, result: null, started: Date.now()};
    this.jobs.push(job);
    this.changed(job);
    void this.pump();
    return job;
  }
  // The title can still change while the file uploads; it is applied afterwards.
  setTitle(job, title) {
    job.desiredTitle = title || job.title;
    this.changed(job);
  }
  // A job whose result is unknown may have been saved, so it is never resent.
  retry(job) {
    if (job.state !== 'failed' || job.unknown) return;
    Object.assign(job, {state: 'queued', error: null, sent: false, started: Date.now()});
    this.changed(job);
    void this.pump();
  }
  dismiss(job) {
    if (job.state === 'queued' || job.state === 'uploading') return;
    this.jobs = this.jobs.filter(j => j !== job);
    this.changed(job);
  }
  async pump() {
    if (this.running) return;
    const job = this.jobs.find(j => j.state === 'queued');
    if (!job) return;
    this.running = true;
    job.state = 'uploading';
    job.sent = true;
    this.changed(job);
    try {
      job.result = await this.send(job);
      job.state = 'done';
      job.input = null;
    } catch (error) {
      job.state = 'failed';
      job.error = error;
      // A network failure or internal error after sending leaves the outcome open.
      job.unknown = !error?.code || error.code === 'INTERNAL';
    } finally {
      this.running = false;
      this.changed(job);
      this.finished(job);
      void this.pump();
    }
  }
}
