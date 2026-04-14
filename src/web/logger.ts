import { EventEmitter } from "events";

export interface LogEvent {
  type: "info" | "success" | "warning" | "error" | "progress" | "summary";
  message: string;
  data?: unknown;
}

class WebLogger extends EventEmitter {
  private clients: Set<(event: LogEvent) => void> = new Set();

  addClient(callback: (event: LogEvent) => void): () => void {
    this.clients.add(callback);
    return () => this.clients.delete(callback);
  }

  private broadcast(event: LogEvent): void {
    console.log(`[PROGRESS-DEBUG] logger.ts: broadcast called with type=${event.type}, message=${event.message}, clientCount=${this.clients.size}`);
    for (const client of this.clients) {
      try {
        console.log(`[PROGRESS-DEBUG] logger.ts: sending event to client`);
        client(event);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  info(message: string, data?: unknown): void {
    this.broadcast({ type: "info", message, data });
  }

  success(message: string, data?: unknown): void {
    this.broadcast({ type: "success", message, data });
  }

  warning(message: string, data?: unknown): void {
    this.broadcast({ type: "warning", message, data });
  }

  error(message: string, data?: unknown): void {
    this.broadcast({ type: "error", message, data });
  }

  progress(current: number, total: number, message: string): void {
    this.broadcast({ type: "progress", message, data: { current, total } });
  }

  summary(matched: number, ambiguous: number, unmatched: number, extra?: Record<string, unknown>): void {
    this.broadcast({
      type: "summary",
      message: "Conversion complete",
      data: { matched, ambiguous, unmatched, ...extra },
    });
  }
}

export const webLogger = new WebLogger();
