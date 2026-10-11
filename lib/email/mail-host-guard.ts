import { lookup } from "dns/promises";
import { BlockList, isIP } from "net";

// A manually configured mailbox's SMTP/IMAP host is user input, and the
// server opens a TCP connection to it (connection tests, every send, every
// reply sync). Without this check a user could point it at loopback, the
// private network or a cloud metadata address and use those connections to
// probe infrastructure the app can reach but they can't (SSRF). Only
// publicly routable addresses are allowed.
//
// The host is resolved here and then connected to by name, so a DNS record
// that changes between the two (rebinding) isn't covered; this closes the
// direct case — an IP literal or a name that already resolves internally.
const BLOCKED = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, incl. cloud metadata (169.254.169.254)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, incl. broadcast
] as const) {
  BLOCKED.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["64:ff9b::", 96], // NAT64 — embeds an IPv4 address
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
  ["2001:db8::", 32], // documentation
] as const) {
  BLOCKED.addSubnet(network, prefix, "ipv6");
}

export const MAIL_HOST_NOT_ALLOWED_MESSAGE =
  "That mail server address isn't allowed. Use your email provider's public SMTP/IMAP host name.";

export class MailHostNotAllowedError extends Error {
  constructor() {
    super(MAIL_HOST_NOT_ALLOWED_MESSAGE);
    this.name = "MailHostNotAllowedError";
  }
}

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return BLOCKED.check(address, "ipv4");
  if (family === 6) {
    // An IPv4-mapped IPv6 address (::ffff:10.0.0.1) reaches the IPv4 host.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return BLOCKED.check(mapped[1], "ipv4");
    return BLOCKED.check(address, "ipv6");
  }
  return true;
}

// Throws MailHostNotAllowedError when the host is, or resolves to, a
// non-public address. A name that doesn't resolve at all is left for the
// connection attempt itself to report ("Couldn't reach the mail server").
export async function assertPublicMailHost(host: string): Promise<void> {
  const trimmed = host.trim().replace(/^\[(.*)\]$/, "$1");
  if (!trimmed || trimmed.toLowerCase() === "localhost" || trimmed.toLowerCase().endsWith(".localhost")) {
    throw new MailHostNotAllowedError();
  }

  if (isIP(trimmed)) {
    if (isBlockedAddress(trimmed)) throw new MailHostNotAllowedError();
    return;
  }

  let addresses: { address: string }[];
  try {
    addresses = await lookup(trimmed, { all: true, verbatim: true });
  } catch {
    return;
  }
  if (addresses.some(({ address }) => isBlockedAddress(address))) {
    throw new MailHostNotAllowedError();
  }
}
