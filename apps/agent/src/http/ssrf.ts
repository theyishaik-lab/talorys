/**
 * SSRF guard for the agent's `http_request` tool. A request may only go to a public host: no
 * loopback, private (RFC 1918 / ULA), link-local (cloud metadata at 169.254.169.254 included),
 * CGNAT, multicast, reserved or documentation ranges, in IPv4 or IPv6 (mapped forms included),
 * and no names that only mean something inside a network (`localhost`, `*.internal`, `*.local`).
 *
 * Names are also resolved over DNS-over-HTTPS before the request goes out, and every address they
 * resolve to must be public too. That check is best effort: when the resolver cannot be reached,
 * the literal checks above still apply (the Worker runtime itself cannot reach private networks).
 * Each redirect hop is checked again by the caller.
 */

export class BlockedHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedHostError";
  }
}

const BLOCKED_NAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback", "metadata", "metadata.google.internal", "instance-data", "kubernetes.default"]);
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa", ".lan", ".intranet", ".corp", ".private"];

/** Parses a dotted IPv4 address (only the canonical 4-part decimal form) to its 4 bytes. */
export function parseIPv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n >= 0 && n <= 255) ? parts : null;
}

/** True for IPv4 addresses that are not on the public internet. */
export function isPrivateIPv4(b: number[]): boolean {
  const [a, b1, c] = b as [number, number, number, number];
  return (
    a === 0 || // "this" network
    a === 10 || // RFC 1918
    a === 127 || // loopback
    (a === 100 && b1 >= 64 && b1 <= 127) || // CGNAT
    (a === 169 && b1 === 254) || // link-local, cloud metadata (169.254.169.254)
    (a === 172 && b1 >= 16 && b1 <= 31) || // RFC 1918
    (a === 192 && b1 === 0 && c === 0) || // IETF protocol assignments
    (a === 192 && b1 === 0 && c === 2) || // TEST-NET-1
    (a === 192 && b1 === 88 && c === 99) || // 6to4 relay
    (a === 192 && b1 === 168) || // RFC 1918
    (a === 198 && (b1 === 18 || b1 === 19)) || // benchmarking
    (a === 198 && b1 === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b1 === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast, reserved, broadcast
  );
}

/** Expands an IPv6 literal (no brackets, an optional embedded IPv4 tail) to 8 16-bit groups. */
export function parseIPv6(host: string): number[] | null {
  let h = host.toLowerCase();
  const zone = h.indexOf("%");
  if (zone >= 0) h = h.slice(0, zone);
  if (!/^[0-9a-f:.]+$/.test(h) || !h.includes(":")) return null;
  let tail: number[] = [];
  const lastColon = h.lastIndexOf(":");
  const maybeV4 = h.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    const v4 = parseIPv4(maybeV4);
    if (!v4) return null;
    tail = [(v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!];
    h = `${h.slice(0, lastColon + 1)}0:0`;
  }
  const halves = h.split("::");
  if (halves.length > 2) return null;
  const group = (s: string) => (s === "" ? [] : s.split(":"));
  const head = group(halves[0]!);
  const rest = halves.length === 2 ? group(halves[1]!) : [];
  if ([...head, ...rest].some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...rest].map((g) => parseInt(g, 16));
  if (tail.length) groups.splice(6, 2, ...tail);
  return groups.length === 8 ? groups : null;
}

/** True for IPv6 addresses that are not on the public internet (IPv4-mapped/compatible/NAT64/6to4 forms are checked as IPv4). */
export function isPrivateIPv6(g: number[]): boolean {
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  const v4 = (): number[] => [g[6]! >> 8, g[6]! & 0xff, g[7]! >> 8, g[7]! & 0xff];
  if (zero(0, 8)) return true; // :: unspecified
  if (zero(0, 7) && g[7] === 1) return true; // ::1 loopback
  if (zero(0, 5) && g[5] === 0xffff) return isPrivateIPv4(v4()); // ::ffff:a.b.c.d mapped
  if (zero(0, 6)) return isPrivateIPv4(v4()); // ::a.b.c.d compatible (deprecated)
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return isPrivateIPv4(v4()); // 64:ff9b::/96 NAT64
  if (g[0] === 0x2002) return isPrivateIPv4([g[1]! >> 8, g[1]! & 0xff, g[2]! >> 8, g[2]! & 0xff]); // 6to4
  const first = g[0]!;
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (first & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (first & 0xffc0) === 0xfec0 || // fec0::/10 site-local (deprecated)
    (first & 0xff00) === 0xff00 || // ff00::/8 multicast
    (first === 0x2001 && g[1] === 0x0db8) || // 2001:db8::/32 documentation
    (first === 0x0100 && zero(1, 4)) // 100::/64 discard
  );
}

/** True when `address` (an IPv4 or IPv6 literal) is not a public internet address. */
export function isPrivateAddress(address: string): boolean {
  const v4 = parseIPv4(address);
  if (v4) return isPrivateIPv4(v4);
  const v6 = parseIPv6(address.replace(/^\[|\]$/g, ""));
  if (v6) return isPrivateIPv6(v6);
  return false;
}

/**
 * Throws BlockedHostError when the URL's host is not allowed without looking anything up:
 * a non-http(s) scheme, credentials in the URL, a private or reserved IP literal (including the
 * shorthand forms URL parsing normalizes, like `http://2130706433/` or `http://0x7f.1/`), or an
 * internal-only name.
 */
export function assertPublicUrl(url: URL): void {
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new BlockedHostError(`Only http and https URLs are allowed (got ${url.protocol}).`);
  if (url.username || url.password) throw new BlockedHostError("Credentials in the URL are not allowed; save them on an API connection instead.");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) throw new BlockedHostError("The URL has no host.");
  const bare = host.replace(/^\[|\]$/g, "");
  if (parseIPv4(bare) || parseIPv6(bare)) {
    if (isPrivateAddress(bare)) throw new BlockedHostError(`${host} is a private, local or reserved address; only public hosts can be called.`);
    return;
  }
  if (!host.includes(".") || BLOCKED_NAMES.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new BlockedHostError(`${host} is a local or internal name; only public hosts can be called.`);
  }
}

/** A DNS lookup: the addresses a name resolves to (empty when it does not), or null when the lookup itself failed. */
export type Resolver = (host: string) => Promise<string[] | null>;

const DOH_URL = "https://cloudflare-dns.com/dns-query";

/** Resolves A and AAAA records over DNS-over-HTTPS (JSON API). Null when the resolver could not be reached. */
export const dohResolver: Resolver = async (host) => {
  const one = async (type: "A" | "AAAA"): Promise<string[] | null> => {
    try {
      const r = await fetch(`${DOH_URL}?name=${encodeURIComponent(host)}&type=${type}`, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(3_000) });
      if (!r.ok) return null;
      const data = (await r.json()) as { Answer?: { type?: number; data?: string }[] };
      const want = type === "A" ? 1 : 28;
      return (data.Answer ?? []).filter((a) => a.type === want && typeof a.data === "string").map((a) => a.data!);
    } catch {
      return null;
    }
  };
  const [a, aaaa] = await Promise.all([one("A"), one("AAAA")]);
  if (a === null && aaaa === null) return null;
  return [...(a ?? []), ...(aaaa ?? [])];
};

/**
 * assertPublicUrl plus the DNS check: every address the name resolves to must be public. A name
 * that resolves to nothing is refused (it cannot be reached anyway); a resolver that cannot be
 * reached leaves the decision to the literal checks.
 */
export async function assertPublicDestination(url: URL, resolve: Resolver = dohResolver): Promise<void> {
  assertPublicUrl(url);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (parseIPv4(host) || parseIPv6(host)) return;
  const addresses = await resolve(host);
  if (addresses === null) return;
  if (addresses.length === 0) throw new BlockedHostError(`${host} does not resolve to any address.`);
  const bad = addresses.find(isPrivateAddress);
  if (bad) throw new BlockedHostError(`${host} resolves to ${bad}, a private, local or reserved address; only public hosts can be called.`);
}
