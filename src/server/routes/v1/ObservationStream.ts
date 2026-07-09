// SPDX-License-Identifier: Apache-2.0
// In-process SSE fan-out for new observations. Best-effort: a broken subscriber
// is dropped, never throws into the publisher (generation path must not break).
type SseResponse = { write: (chunk: string) => void; writableEnded?: boolean };
export type StreamEvent = { type: 'initial_load' | 'new_observation'; observation?: unknown };

export class ObservationStream {
  private subscribers = new Set<SseResponse>();
  subscribe(res: SseResponse): () => void {
    this.subscribers.add(res);
    return () => { this.subscribers.delete(res); };
  }
  publish(event: StreamEvent): void {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of [...this.subscribers]) {
      try {
        if (res.writableEnded) { this.subscribers.delete(res); continue; }
        res.write(frame);
      } catch { this.subscribers.delete(res); }
    }
  }
  static instance = new ObservationStream();
}
