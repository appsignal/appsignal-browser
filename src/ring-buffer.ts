/** Fixed-capacity ring buffer. Oldest items are dropped when full. */
export class RingBuffer<T> {
  private items: T[] = [];
  private capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  push(item: T): void {
    if (this.items.length >= this.capacity) {
      this.items.shift();
    }
    this.items.push(item);
  }

  snapshot(): T[] {
    return [...this.items];
  }

  drain(): T[] {
    const items = [...this.items];
    this.items = [];
    return items;
  }

  clear(): void {
    this.items = [];
  }

  get length(): number {
    return this.items.length;
  }
}
