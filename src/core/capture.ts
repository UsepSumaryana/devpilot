// Service output goes to files, not pipes, and the daemon tails them.
//
// With pipes, a service's stdout dies with the daemon: on restart the
// service hits a broken pipe (EPIPE/SIGPIPE) or loses its console, and an
// adopted process has no logs. Files outlive the daemon, so a restarted
// daemon resumes tailing where the previous one stopped.
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const MAX_CAPTURE = 50 * 1024 * 1024;
const CHUNK = 256 * 1024;

export interface TailPos {
  out: number;
  err: number;
}

export class OutputTail {
  private decoders = { out: new StringDecoder('utf8'), err: new StringDecoder('utf8') };

  constructor(
    readonly files: { out: string; err: string },
    public pos: TailPos = { out: 0, err: 0 },
  ) {}

  static files(dir: string, name: string) {
    return { out: path.join(dir, `${name}.stdout`), err: path.join(dir, `${name}.stderr`) };
  }

  /** Fresh capture files for a new run; returns fds to hand to spawn (close them after). */
  static prepare(dir: string, name: string): { tail: OutputTail; fds: [number, number] } {
    fs.mkdirSync(dir, { recursive: true });
    const files = OutputTail.files(dir, name);
    const out = fs.openSync(files.out, 'w');
    const err = fs.openSync(files.err, 'w');
    return { tail: new OutputTail(files), fds: [out, err] };
  }

  /** Read whatever was appended since the last call. */
  drain(write: (stream: 'out' | 'err', text: string) => void) {
    for (const stream of ['out', 'err'] as const) {
      const file = this.files[stream];
      let size: number;
      try {
        size = fs.statSync(file).size;
      } catch {
        continue;
      }
      if (size < this.pos[stream]) this.pos[stream] = 0; // truncated
      if (size === this.pos[stream]) continue;
      let fd: number | undefined;
      try {
        fd = fs.openSync(file, 'r');
        while (this.pos[stream] < size) {
          const len = Math.min(CHUNK, size - this.pos[stream]);
          const buf = Buffer.alloc(len);
          const n = fs.readSync(fd, buf, 0, len, this.pos[stream]);
          if (n <= 0) break;
          this.pos[stream] += n;
          const text = this.decoders[stream].write(buf.subarray(0, n));
          if (text) write(stream, text);
        }
      } catch {
        /* file vanished mid-read */
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
      // Writers use O_APPEND, so truncating under them is safe.
      if (this.pos[stream] > MAX_CAPTURE) {
        try {
          fs.truncateSync(file, 0);
          this.pos[stream] = 0;
        } catch {
          /* windows may refuse while locked; try next time */
        }
      }
    }
  }
}
