export type ScopeCleanup = () => void | Promise<void>;
export type ScopeWork<T> = (signal: AbortSignal) => T | Promise<T>;

type ScopeState = "open" | "closing" | "closed";

/** The only lifecycle primitive shared by extensions and app activations. */
export class ResourceScope {
  private state: ScopeState = "open";
  private readonly controller = new AbortController();
  private readonly pending = new Map<Promise<unknown>, () => boolean>();
  private readonly cleanups: ScopeCleanup[] = [];
  private closePromise?: Promise<void>;

  constructor(readonly id: string, readonly path = id) {}

  get active(): boolean {
    return this.state === "open";
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  run<T>(work: ScopeWork<T>, signal?: AbortSignal): Promise<T> {
    if (this.state !== "open") return Promise.reject(new Error("Resource scope is closed: " + this.id));
    const combined = signal ? AbortSignal.any([signal, this.signal]) : this.signal;
    const task = Promise.resolve().then(() => {
      if (this.signal.aborted) throw new Error("Resource scope is closed: " + this.id);
      return work(combined);
    });
    this.pending.set(task, () => combined.aborted);
    void task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task),
    );
    return task;
  }

  onDispose(cleanup: ScopeCleanup): void {
    if (this.state !== "open") throw new Error("Resource scope is closed: " + this.id);
    this.cleanups.push(cleanup);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.state = "closing";
    this.controller.abort(new Error("Resource scope closed: " + this.id));
    this.closePromise = this.finishClose();
    return this.closePromise;
  }

  private async finishClose(): Promise<void> {
    const errors: unknown[] = [];
    const pending = [...this.pending.entries()];
    const results = await Promise.all(pending.map(async ([task, cancelled]) => ({ result: await Promise.allSettled([task]), cancelled })));
    for (const { result, cancelled } of results) {
      if (result[0].status === "rejected" && !cancelled()) errors.push(result[0].reason);
    }

    for (const cleanup of this.cleanups.splice(0).reverse()) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }

    this.state = "closed";
    if (errors.length > 0) {
      throw new AggregateError(errors, "Resource scope cleanup failed: " + this.id);
    }
  }
}
