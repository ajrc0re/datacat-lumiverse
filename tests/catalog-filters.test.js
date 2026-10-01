import { describe, expect, test } from "bun:test";
import {
  cardHasLorebook, changeTagPool, createTagPools, matchesMinimumTokens,
  normalizeMinimumTokens, scanCatalogPages,
} from "../src/catalog-filters.js";

describe("tag pools", () => {
  test("moving and removing tags keeps include and block mutually exclusive", () => {
    let pools = createTagPools([2, 3], [4]);
    pools = changeTagPool(pools, 2, "block");
    expect([...pools.selectedTagIds]).toEqual([3]);
    expect([...pools.blockedTagIds]).toEqual([4, 2]);
    pools = changeTagPool(pools, 2, "include");
    expect([...pools.blockedTagIds]).toEqual([4]);
    expect([...pools.selectedTagIds]).toEqual([3, 2]);
    pools = changeTagPool(pools, 4, "block", { remove: true });
    expect([...pools.blockedTagIds]).toEqual([]);
    pools = changeTagPool(pools, 2, "include");
    expect([...pools.selectedTagIds]).toEqual([3]);
  });

  test("restored state rejects bad IDs and gives blocking precedence", () => {
    const pools = createTagPools([2, "2", 3, -1, 1.5, "bad"], [3, 4]);
    expect([...pools.selectedTagIds]).toEqual([2]);
    expect([...pools.blockedTagIds]).toEqual([3, 4]);
  });

  test("API pool limits reject additional tags without changing existing selections", () => {
    const pools = createTagPools(Array.from({ length: 24 }, (_, i) => i + 1), []);
    expect(() => changeTagPool(pools, 25, "include")).toThrow("24 tags");
    expect(changeTagPool(pools, 24, "include", { toggle: false }).selectedTagIds.size).toBe(24);
    expect(changeTagPool(pools, 24, "block").selectedTagIds.size).toBe(23);
    const blocked = createTagPools([], Array.from({ length: 50 }, (_, i) => i + 1));
    expect(() => changeTagPool(blocked, 51, "block")).toThrow("50 tags");
  });
});

test("minimum tokens uses an inclusive boundary and rejects unavailable counts", () => {
  expect(normalizeMinimumTokens("")).toBeNull();
  expect(normalizeMinimumTokens("2500")).toBe(2500);
  for (const value of [-1, "1.5", "bad", Infinity]) expect(normalizeMinimumTokens(value)).toBeNull();
  expect(matchesMinimumTokens({ totalTokens: 2499 }, 2500)).toBe(false);
  expect(matchesMinimumTokens({ totalTokens: 2500 }, 2500)).toBe(true);
  expect(matchesMinimumTokens({ totalTokens: 2501 }, 2500)).toBe(true);
  expect(matchesMinimumTokens({ totalTokens: null }, 2500)).toBe(false);
  expect(matchesMinimumTokens({}, null)).toBe(true);
});

test("lorebook presence requires nonempty embedded entries in v2/v3 or flat cards", () => {
  const book = { entries: [{ content: "World lore", enabled: false }] };
  expect(cardHasLorebook({ spec: "chara_card_v2", data: { character_book: book } })).toBe(true);
  expect(cardHasLorebook({ spec: "chara_card_v3", data: { character_book: book } })).toBe(true);
  expect(cardHasLorebook({ character_book: book })).toBe(true);
  for (const card of [{}, { data: {} }, { data: { character_book: { entries: [] } } },
    { data: { character_book: { entries: [null, { content: " " }] } } }]) {
    expect(cardHasLorebook(card)).toBe(false);
  }
});

describe("filtered paging", () => {
  test("continues past discarded pages using raw API offsets", async () => {
    const offsets = [];
    const result = await scanCatalogPages({
      pageSize: 2,
      fetchPage: async (offset) => {
        offsets.push(offset);
        return { characters: [{ id: offset, totalTokens: offset * 1000 }, { id: offset + 1, totalTokens: (offset + 1) * 1000 }],
          paging: { nextOffset: offset + 2, hasMore: offset < 2 } };
      },
      matches: (character) => matchesMinimumTokens(character, 2000),
    });
    expect(offsets).toEqual([0, 2]);
    expect(result.characters.map((character) => character.id)).toEqual([2, 3]);
    expect(result.nextOffset).toBe(4);
    expect(result.hasMore).toBe(false);
  });

  test("bounds sparse scans and offers manual continuation", async () => {
    const offsets = [];
    const result = await scanCatalogPages({
      fetchPage: async (offset) => {
        offsets.push(offset);
        return { characters: [{ id: offset }], paging: { nextOffset: offset + 24, hasMore: true } };
      },
      matches: () => false,
    });
    expect(offsets).toEqual([0, 24, 48]);
    expect(result).toEqual({ characters: [], nextOffset: 72, hasMore: true, manualMore: true });
  });

  test("preserves matches and the unconsumed page on verification renewal", async () => {
    let progress;
    await expect(scanCatalogPages({
      fetchPage: async () => ({ characters: [{ id: "known" }, { id: "unchecked" }], paging: { nextOffset: 24, hasMore: false } }),
      matches: async (character) => {
        if (character.id === "unchecked") throw new Error("CLIENT_VERIFICATION_REQUIRED");
        return true;
      },
      onProgress: (next) => { progress = next; },
    })).rejects.toThrow("CLIENT_VERIFICATION_REQUIRED");
    expect(progress).toEqual({ characters: [{ id: "known" }], nextOffset: 0, hasMore: true });
  });

  test("stale responses stop before checking cards or updating progress", async () => {
    let current = true;
    let checked = 0;
    let progressed = 0;
    const result = await scanCatalogPages({
      fetchPage: async () => { current = false; return { characters: [{ id: 1 }] }; },
      matches: () => { checked += 1; return true; },
      isCurrent: () => current,
      onProgress: () => { progressed += 1; },
    });
    expect(result).toBeNull();
    expect(checked).toBe(0);
    expect(progressed).toBe(0);
  });

  test("stops if the filter changes while card metadata is loading", async () => {
    let current = true;
    let progressed = 0;
    const result = await scanCatalogPages({
      fetchPage: async () => ({ characters: [{ id: 1 }, { id: 2 }] }),
      matches: async () => { current = false; return true; },
      isCurrent: () => current,
      onProgress: () => { progressed += 1; },
    });
    expect(result).toBeNull();
    expect(progressed).toBe(0);
  });

  test("rejects a nonadvancing server cursor", async () => {
    await expect(scanCatalogPages({
      fetchPage: async () => ({ characters: [], paging: { nextOffset: 0, hasMore: true } }),
      matches: () => true,
    })).rejects.toThrow("cursor");
  });
});
