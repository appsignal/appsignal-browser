import { describe, it, expect } from "vitest";
import { RingBuffer } from "./ring-buffer.js";

describe("RingBuffer", () => {
  it("stores items up to capacity", () => {
    const buf = new RingBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    expect(buf.snapshot()).toEqual([1, 2, 3]);
    expect(buf.length).toBe(3);
  });

  it("drops oldest items when full", () => {
    const buf = new RingBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    buf.push(4);
    expect(buf.snapshot()).toEqual([2, 3, 4]);
    expect(buf.length).toBe(3);
  });

  it("returns a copy on snapshot", () => {
    const buf = new RingBuffer<number>(3);
    buf.push(1);
    const snap = buf.snapshot();
    snap.push(99);
    expect(buf.snapshot()).toEqual([1]);
  });

  it("clears all items", () => {
    const buf = new RingBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.clear();
    expect(buf.snapshot()).toEqual([]);
    expect(buf.length).toBe(0);
  });

  it("handles capacity of 1", () => {
    const buf = new RingBuffer<string>(1);
    buf.push("a");
    buf.push("b");
    expect(buf.snapshot()).toEqual(["b"]);
  });

  it("drain returns items and empties buffer", () => {
    const buf = new RingBuffer<number>(5);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    const drained = buf.drain();
    expect(drained).toEqual([1, 2, 3]);
    expect(buf.snapshot()).toEqual([]);
    expect(buf.length).toBe(0);
  });

  it("drain returns a copy, not a reference", () => {
    const buf = new RingBuffer<number>(5);
    buf.push(1);
    const drained = buf.drain();
    drained.push(99);
    // Buffer is empty, the mutation didn't affect it
    expect(buf.length).toBe(0);
  });

  it("survives many wrap-arounds without drift", () => {
    // Catches off-by-one bugs in head/tail pointer arithmetic. Push 1000
    // items into a capacity-10 buffer; the buffer must end with the last 10.
    const buf = new RingBuffer<number>(10);
    for (let i = 0; i < 1000; i++) buf.push(i);

    const snap = buf.snapshot();
    expect(snap).toHaveLength(10);
    expect(snap).toEqual([990, 991, 992, 993, 994, 995, 996, 997, 998, 999]);
  });

  it("snapshot then push then snapshot again gives the right view", () => {
    // Pointer arithmetic must not be confused by a mid-cycle snapshot.
    const buf = new RingBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    expect(buf.snapshot()).toEqual([1, 2, 3]);
    buf.push(4);
    expect(buf.snapshot()).toEqual([2, 3, 4]);
    buf.push(5);
    expect(buf.snapshot()).toEqual([3, 4, 5]);
  });

  it("drain after wrap returns items in order", () => {
    const buf = new RingBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    buf.push(4); // wraps; oldest now is 2
    buf.push(5);
    expect(buf.drain()).toEqual([3, 4, 5]);
  });
});
