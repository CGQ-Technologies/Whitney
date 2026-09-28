import { describe, expect, test } from "bun:test";
import { mergeLiveElements } from "./live.js";
import type { LiveElement } from "./live.js";

const rectangle = (id: string, x: number, version = 1, versionNonce = 1, isDeleted = false): LiveElement => ({
  id,
  type: "rectangle",
  x,
  y: 10,
  version,
  versionNonce,
  isDeleted,
});

describe("live whiteboard scene merge", () => {
  test("preserves independent edits received concurrently in either order", () => {
    const firstEdit = rectangle("first", 100);
    const secondEdit = rectangle("second", 200);

    const firstThenSecond = mergeLiveElements(mergeLiveElements([], [firstEdit]), [secondEdit]);
    const secondThenFirst = mergeLiveElements(mergeLiveElements([], [secondEdit]), [firstEdit]);

    expect(firstThenSecond).toEqual([firstEdit, secondEdit]);
    expect(secondThenFirst).toEqual([secondEdit, firstEdit]);
    expect(Object.fromEntries(firstThenSecond.map(({ id, x }) => [id, x])))
      .toEqual(Object.fromEntries(secondThenFirst.map(({ id, x }) => [id, x])));
  });

  test("chooses the newest version and retains deletion tombstones", () => {
    const original = rectangle("shape", 10, 2, 30);
    const deletion = rectangle("shape", 10, 3, 31, true);
    const staleMove = rectangle("shape", 40, 2, 99);

    const deleted = mergeLiveElements([original], [deletion]);
    expect(deleted).toEqual([deletion]);
    expect(mergeLiveElements(deleted, [staleMove])).toEqual([deletion]);
  });

  test("uses nonce and canonical content to resolve equal versions consistently", () => {
    const current = rectangle("shape", 10, 4, 10);
    const greaterNonce = rectangle("shape", 20, 4, 11);
    expect(mergeLiveElements([current], [greaterNonce])).toEqual([greaterNonce]);
    expect(mergeLiveElements([greaterNonce], [current])).toEqual([greaterNonce]);
  });
});
