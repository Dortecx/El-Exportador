import { EventEmitter } from "events";
export interface LogEvent {
    type: "info" | "success" | "warning" | "error" | "progress" | "summary";
    message: string;
    data?: unknown;
}
declare class WebLogger extends EventEmitter {
    private clients;
    addClient(callback: (event: LogEvent) => void): () => void;
    private broadcast;
    info(message: string, data?: unknown): void;
    success(message: string, data?: unknown): void;
    warning(message: string, data?: unknown): void;
    error(message: string, data?: unknown): void;
    progress(current: number, total: number, message: string): void;
    summary(matched: number, ambiguous: number, unmatched: number, extra?: Record<string, unknown>): void;
}
export declare const webLogger: WebLogger;
export {};
//# sourceMappingURL=logger.d.ts.map