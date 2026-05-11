"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.webLogger = void 0;
const events_1 = require("events");
class WebLogger extends events_1.EventEmitter {
    clients = new Set();
    addClient(callback) {
        this.clients.add(callback);
        return () => this.clients.delete(callback);
    }
    broadcast(event) {
        console.log(`[PROGRESS-DEBUG] logger.ts: broadcast called with type=${event.type}, message=${event.message}, clientCount=${this.clients.size}`);
        for (const client of this.clients) {
            try {
                console.log(`[PROGRESS-DEBUG] logger.ts: sending event to client`);
                client(event);
            }
            catch {
                this.clients.delete(client);
            }
        }
    }
    info(message, data) {
        this.broadcast({ type: "info", message, data });
    }
    success(message, data) {
        this.broadcast({ type: "success", message, data });
    }
    warning(message, data) {
        this.broadcast({ type: "warning", message, data });
    }
    error(message, data) {
        this.broadcast({ type: "error", message, data });
    }
    progress(current, total, message) {
        this.broadcast({ type: "progress", message, data: { current, total } });
    }
    summary(matched, ambiguous, unmatched, extra) {
        this.broadcast({
            type: "summary",
            message: "Conversion complete",
            data: { matched, ambiguous, unmatched, ...extra },
        });
    }
}
exports.webLogger = new WebLogger();
//# sourceMappingURL=logger.js.map