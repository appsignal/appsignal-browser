/** Fixed-capacity ring buffer. Oldest items are dropped when full.
 *
 * Backed by a fixed-size array indexed by a head pointer, so push and
 * snapshot are O(1) and O(n) respectively without the O(n) shift the
 * naive array-as-queue implementation incurs on every push past capacity. */
export class RingBuffer<T> {
  private items: (T | undefined)[];
  private head = 0;
  private size = 0;
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.items = new Array(capacity);
  }

  push(item: T): void {
    if (this.size < this.capacity) {
      this.items[(this.head + this.size) % this.capacity] = item;
      this.size++;
    } else {
      // At capacity — overwrite the oldest entry and advance head.
      this.items[this.head] = item;
      this.head = (this.head + 1) % this.capacity;
    }
  }

  snapshot(): T[] {
    const result: T[] = new Array(this.size);
    for (let i = 0; i < this.size; i++) {
      result[i] = this.items[(this.head + i) % this.capacity] as T;
    }
    return result;
  }

  drain(): T[] {
    const result = this.snapshot();
    this.clear();
    return result;
  }

  clear(): void {
    // Drop references so dropped entries can be GC'd.
    for (let i = 0; i < this.capacity; i++) this.items[i] = undefined;
    this.head = 0;
    this.size = 0;
  }

  get length(): number {
    return this.size;
  }
}
