import { cpus } from 'node:os';

/** Simple concurrency-limited task runner (adapted from parse-diagnostic). */
export class BoundedQueue {
  readonly concurrency: number;

  constructor(requested: number) {
    const numCpus = cpus().length;
    this.concurrency = Math.min(Math.max(1, requested), numCpus);
  }

  async runAll<T>(tasks: Array<() => Promise<T>>): Promise<T[]> {
    const results: T[] = new Array(tasks.length);
    let next = 0;

    const worker = async (): Promise<void> => {
      while (next < tasks.length) {
        const idx = next++;
        results[idx] = await tasks[idx]();
      }
    };

    await Promise.all(Array.from({ length: this.concurrency }, worker));
    return results;
  }
}
