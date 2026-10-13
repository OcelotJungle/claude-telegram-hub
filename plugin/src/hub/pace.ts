// A sliding-window rate limit: at most `count` slots in any `perMs`. A send
// waiting for a slot goes before every waiting edit; within a kind, first
// come, first served.
export type Priority = "send" | "edit";

type Waiter = { priority: Priority; resolve: () => void };

export class Pace {
  private taken: number[] = [];
  private waiters: Waiter[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private count: number,
    private perMs: number,
  ) {}

  take(priority: Priority): Promise<void> {
    return new Promise(resolve => {
      const waiter = { priority, resolve };
      const firstEdit = this.waiters.findIndex(w => w.priority === "edit");
      if (priority === "send" && firstEdit >= 0) this.waiters.splice(firstEdit, 0, waiter);
      else this.waiters.push(waiter);
      this.drain();
    });
  }

  private drain(): void {
    if (this.timer) return;
    const now = Date.now();
    this.taken = this.taken.filter(t => t > now - this.perMs);
    while (this.waiters.length && this.taken.length < this.count) {
      this.taken.push(now);
      this.waiters.shift()?.resolve();
    }
    const oldest = this.taken[0];
    if (!this.waiters.length || oldest === undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.drain();
    }, oldest + this.perMs - now);
  }
}
