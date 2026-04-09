import type { BridgeAuthEventName, BridgeAuthEvents } from './types.js';

type Handler<T> = (data: T) => void;

export class EventEmitter {
  private listeners = new Map<string, Set<Handler<any>>>();

  on<E extends BridgeAuthEventName>(event: E, handler: Handler<BridgeAuthEvents[E]>): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);
    return () => this.off(event, handler);
  }

  off<E extends BridgeAuthEventName>(event: E, handler: Handler<BridgeAuthEvents[E]>): void {
    this.listeners.get(event)?.delete(handler);
  }

  emit<E extends BridgeAuthEventName>(event: E, data: BridgeAuthEvents[E]): void {
    this.listeners.get(event)?.forEach((handler) => {
      try {
        handler(data);
      } catch {
        // Swallow listener errors to prevent cascading failures
      }
    });
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }
}
