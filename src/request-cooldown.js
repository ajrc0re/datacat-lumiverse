const FALLBACK_RETRY_MS = 60_000;

export function retryAfterMilliseconds(headers, now = Date.now()) {
  const entry = Object.entries(headers || {}).find(([name]) => name.toLowerCase() === "retry-after");
  const value = String(entry?.[1] ?? "").trim();
  if (!value) return FALLBACK_RETRY_MS;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    if (seconds < 0 || !Number.isSafeInteger(now + Math.ceil(seconds * 1000))) return FALLBACK_RETRY_MS;
    return Math.max(1000, Math.ceil(seconds * 1000));
  }
  const deadline = Date.parse(value);
  return Number.isFinite(deadline) && deadline > now ? deadline - now : FALLBACK_RETRY_MS;
}

// Datacat limits can apply to the host IP, so share the cooldown across users
// and persist it outside account credentials and browser session state.
export function createRequestCooldown({ load, save, now = Date.now }) {
  let expiresAt = 0;
  let loading;
  let saving = Promise.resolve();

  async function restore() {
    loading ??= Promise.resolve().then(load).then((record) => {
      const deadline = Number(record?.expiresAt);
      if (Number.isSafeInteger(deadline) && deadline > now()) expiresAt = Math.max(expiresAt, deadline);
    }).catch(() => {});
    await loading;
  }

  return {
    async blockedResponse() {
      await restore();
      const retryAfter = Math.ceil((expiresAt - now()) / 1000);
      if (retryAfter <= 0) return null;
      return {
        status: 429,
        statusText: "Too Many Requests",
        headers: { "Retry-After": String(retryAfter) },
        body: JSON.stringify({ success: false, error: "DATACAT_RATE_LIMITED" }),
        encoding: null,
      };
    },

    async observe(response) {
      if (Number(response?.status) !== 429) return;
      await restore();
      const timestamp = now();
      expiresAt = Math.max(expiresAt, timestamp + retryAfterMilliseconds(response.headers, timestamp));
      // Serialize writes so an earlier response cannot overwrite a later deadline.
      saving = saving.then(() => save({ expiresAt })).catch(() => {});
      await saving;
    },
  };
}
