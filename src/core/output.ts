/** 输出代理：把主体的表达广播到多个输出端（终端 TUI、Web SSE、未来的语音）。 */
export type OutMsg =
  | { type: "text"; text: string }
  | { type: "turn_start"; n: number; text: string; viaInternal: boolean }
  | { type: "turn_end"; n: number }
  | { type: "error"; text: string };

export class OutputBroker {
  private readonly sinks = new Set<(m: OutMsg) => void>();

  add(sink: (m: OutMsg) => void): void {
    this.sinks.add(sink);
  }

  remove(sink: (m: OutMsg) => void): void {
    this.sinks.delete(sink);
  }

  emit(m: OutMsg): void {
    for (const sink of this.sinks) sink(m);
  }
}