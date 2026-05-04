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
});
