/**
 * A typed event emitter small enough to read in one go.
 *
 * Node's EventEmitter would do, but its listener signatures are `any` and a payload typo there
 * is a runtime surprise rather than a compile error. This one maps each event name to exactly
 * one payload type and returns an unsubscribe function, which is what every subscriber here
 * needs when a call ends.
 */
export class Emitter<Events extends Record<string, unknown>> {
  private readonly listeners = new Map<keyof Events, Set<(payload: never) => void>>();

  on<K extends keyof Events>(event: K, listener: (payload: Events[K]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as (payload: never) => void);
    return () => {
      set?.delete(listener as (payload: never) => void);
    };
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) (listener as (payload: Events[K]) => void)(payload);
  }

  removeAll(): void {
    this.listeners.clear();
  }
}
