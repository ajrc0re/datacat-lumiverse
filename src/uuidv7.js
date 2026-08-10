let lastTimestamp = -1;
let sequence = 0;

function fillRandomBytes(bytes) {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.getRandomValues === "function") {
    try {
      cryptoApi.getRandomValues(bytes);
      return;
    } catch (_) {
      // Some embedded/insecure contexts expose crypto but reject random values.
    }
  }

  // UUIDs in this client are correlation and installation identifiers, not
  // credentials. This fallback keeps those flows working in non-SSL contexts.
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256);
  }
}

/**
 * Creates a time-ordered RFC 9562 UUID version 7.
 *
 * WebCrypto is used when available, but is optional so remote Lumiverse
 * installations served over HTTP can still create request identifiers.
 */
export function uuidv7() {
  let timestamp = Math.max(0, Math.floor(Date.now()));

  if (timestamp > lastTimestamp) {
    lastTimestamp = timestamp;
    sequence = 0;
  } else {
    timestamp = lastTimestamp;
    sequence += 1;
    if (sequence > 0x0fff) {
      lastTimestamp += 1;
      timestamp = lastTimestamp;
      sequence = 0;
    }
  }

  const bytes = new Uint8Array(16);
  fillRandomBytes(bytes);

  bytes[0] = Math.floor(timestamp / 0x10000000000) & 0xff;
  bytes[1] = Math.floor(timestamp / 0x100000000) & 0xff;
  bytes[2] = Math.floor(timestamp / 0x1000000) & 0xff;
  bytes[3] = Math.floor(timestamp / 0x10000) & 0xff;
  bytes[4] = Math.floor(timestamp / 0x100) & 0xff;
  bytes[5] = timestamp & 0xff;
  bytes[6] = 0x70 | ((sequence >> 8) & 0x0f);
  bytes[7] = sequence & 0xff;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}
