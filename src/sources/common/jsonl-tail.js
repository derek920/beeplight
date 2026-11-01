import fs from 'node:fs';
import { config as defaultConfig } from '../../config/index.js';

// Follows a JSONL file an agent appends to, reading only what was written since the last poll.
// Transcripts can pass 100 MB, so the first read takes only the tail (transcript.initialTailMB)
// and each read is capped (transcript.maxReadMB). Lines are split on the byte, so a multi-byte
// character is never cut in half. Subclasses parse lines in onLine() and start over in onReset().
const MB = 1024 * 1024;

export class JsonlTail {
  constructor(file, config = defaultConfig) {
    this.file = file;
    this.config = config;
    this.offset = 0;
    this.ino = null;
    this.remainder = Buffer.alloc(0);
    this.skipPartial = false;
    this.version = 0;
  }

  /** One complete line; returns true if it changed what the subclass knows. */
  onLine() {
    return false;
  }

  /** The file was rewritten or replaced: drop everything learned from it. */
  onReset() {}

  // Reads whatever was appended since the last call. Returns true if the analysis changed.
  poll() {
    let st;
    try {
      st = fs.statSync(this.file);
    } catch {
      return false;
    }
    if (this.ino !== null && (st.ino !== this.ino || st.size < this.offset)) {
      // Rewritten or replaced: start over.
      this.ino = null;
      this.offset = 0;
      this.remainder = Buffer.alloc(0);
      this.onReset();
      this.version++;
    }
    if (this.ino === null) {
      this.ino = st.ino;
      // Some transcripts pass 100 MB; the recent end is what matters.
      const tail = Math.floor(this.config.get('transcript.initialTailMB') * MB);
      if (st.size > tail) {
        this.offset = st.size - tail;
        this.skipPartial = true;
      }
    }
    if (st.size <= this.offset) return false;

    const len = Math.min(st.size - this.offset, Math.floor(this.config.get('transcript.maxReadMB') * MB));
    const buf = Buffer.allocUnsafe(len);
    const fd = fs.openSync(this.file, 'r');
    try {
      fs.readSync(fd, buf, 0, len, this.offset);
    } finally {
      fs.closeSync(fd);
    }
    this.offset += len;
    return this.ingestBuffer(buf);
  }

  ingestBuffer(buf) {
    const data = this.remainder.length ? Buffer.concat([this.remainder, buf]) : buf;
    let start = 0;
    if (this.skipPartial) {
      const nl = data.indexOf(10);
      if (nl < 0) {
        this.remainder = Buffer.from(data);
        return false;
      }
      start = nl + 1;
      this.skipPartial = false;
    }
    const last = data.lastIndexOf(10);
    if (last < start) {
      this.remainder = Buffer.from(data.subarray(start));
      return false;
    }
    // Split on the byte, not the string, so a multi-byte char is never cut in half.
    this.remainder = Buffer.from(data.subarray(last + 1));
    let changed = false;
    for (const line of data.toString('utf8', start, last).split('\n')) {
      if (line && this.onLine(line)) changed = true;
    }
    if (changed) this.version++;
    return changed;
  }
}
