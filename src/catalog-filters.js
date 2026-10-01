export const TAG_POOL_LIMITS = Object.freeze({ include: 24, block: 50 });

export function normalizeTagIds(values, limit = TAG_POOL_LIMITS.include) {
  return new Set(
    [...new Set((Array.isArray(values) || values instanceof Set ? [...values] : [])
      .map(Number)
      .filter((id) => Number.isSafeInteger(id) && id > 0))].slice(0, limit),
  );
}

export function normalizeMinimumTokens(value) {
  if (String(value ?? "").trim() === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

export function createTagPools(included, blocked) {
  const blockedTagIds = normalizeTagIds(blocked, TAG_POOL_LIMITS.block);
  const selectedTagIds = normalizeTagIds(included);
  for (const id of blockedTagIds) selectedTagIds.delete(id);
  return { selectedTagIds, blockedTagIds };
}

export function changeTagPool(pools, tagId, pool, { remove = false, toggle = true } = {}) {
  const id = Number(tagId);
  if (!Number.isSafeInteger(id) || id <= 0) return pools;
  const next = createTagPools([...pools.selectedTagIds], [...pools.blockedTagIds]);
  const target = pool === "block" ? next.blockedTagIds : next.selectedTagIds;
  const other = pool === "block" ? next.selectedTagIds : next.blockedTagIds;
  if (remove || (toggle && target.has(id))) {
    target.delete(id);
  } else {
    if (!target.has(id) && target.size >= TAG_POOL_LIMITS[pool === "block" ? "block" : "include"]) {
      throw new Error(`You can ${pool === "block" ? "block" : "include"} up to ${TAG_POOL_LIMITS[pool === "block" ? "block" : "include"]} tags.`);
    }
    target.add(id);
    other.delete(id);
  }
  return next;
}

export function matchesMinimumTokens(character, minimumTokens) {
  if (minimumTokens === null) return true;
  const tokens = character?.totalTokens;
  return tokens !== null && tokens !== undefined && tokens !== "" &&
    Number.isFinite(Number(tokens)) && Number(tokens) >= minimumTokens;
}

// Keep the server's cursor even when local filters discard an entire page.
// Progress retains matches if a later page fails or is rate limited.
export async function scanCatalogPages({
  offset = 0,
  pageSize = 24,
  maxPages = 3,
  fetchPage,
  matches,
  isCurrent = () => true,
  onProgress = () => {},
}) {
  const characters = [];
  let hasMore = true;
  for (let page = 0; page < maxPages; page += 1) {
    const payload = await fetchPage(offset);
    if (!isCurrent()) return null;
    const rows = Array.isArray(payload.characters) ? payload.characters : [];
    for (const character of rows) {
      const accepted = await matches(character);
      if (!isCurrent()) return null;
      if (accepted) characters.push(character);
      onProgress({ characters: [...characters], nextOffset: offset, hasMore: true });
    }
    const nextOffset = Number(payload.paging?.nextOffset ?? offset + rows.length);
    hasMore = payload.paging?.hasMore === true;
    if (!Number.isSafeInteger(nextOffset) || nextOffset < offset || (hasMore && nextOffset === offset)) {
      throw new Error("Datacat returned an invalid catalog page cursor.");
    }
    offset = nextOffset;
    onProgress({ characters: [...characters], nextOffset: offset, hasMore });
    if (!hasMore || characters.length >= pageSize) break;
  }
  return { characters, nextOffset: offset, hasMore, manualMore: hasMore && characters.length < pageSize };
}
