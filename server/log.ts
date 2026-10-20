// Redacting logger. Anything that looks like a private key, a signature
// component, a cookie or a bearer token is masked BEFORE it reaches stdout —
// the watcher handles keys that can trade user funds, and Railway logs are
// not a place for them. (SPEC.md §8)

const HEX64 = /0x[0-9a-fA-F]{64}/g; // private keys, r/s, tx hashes (over-redacting is fine)
const COOKIE = /(bi_[a-z]+=)[^;\s"]+/gi;
const SECRETS = /("?(?:privateKey|private_key|key_cipher|signature|secret|kek|password|cookie|authorization)"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi;

export function redact(s: string): string {
  return s
    .replace(SECRETS, "$1[redacted]")
    .replace(HEX64, (m) => `${m.slice(0, 6)}…[64hex]`)
    .replace(COOKIE, "$1[redacted]");
}

function fmt(args: unknown[]): string {
  return redact(
    args
      .map((a) => {
        if (a instanceof Error) return `${a.name}: ${a.message}`;
        if (typeof a === "string") return a;
        try {
          return JSON.stringify(a, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
        } catch {
          return String(a);
        }
      })
      .join(" ")
  );
}

export const log = {
  info: (...a: unknown[]) => console.log(`[watcher] ${fmt(a)}`),
  warn: (...a: unknown[]) => console.warn(`[watcher] ${fmt(a)}`),
  error: (...a: unknown[]) => console.error(`[watcher] ${fmt(a)}`),
  api: (...a: unknown[]) => console.log(`[api] ${fmt(a)}`),
};
