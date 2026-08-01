function normalizeHost(value: string): string {
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
}

export function isLoopbackHost(value: string): boolean {
  const host = normalizeHost(value);
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function parseIpv4Host(value: string): number[] | null {
  const octets = normalizeHost(value).split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return octets;
}

function isPrivateIpv4Host(value: string): boolean {
  const octets = parseIpv4Host(value);
  if (!octets) return false;
  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

function isTailscaleIpv4Host(value: string): boolean {
  const octets = parseIpv4Host(value);
  return Boolean(octets && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127);
}

function isPrivateIpv6Host(value: string): boolean {
  const host = normalizeHost(value).replace(/^\[|\]$/g, "");
  return /^(fc|fd)[0-9a-f]{2}:/i.test(host) || /^fe[89ab][0-9a-f]:/i.test(host);
}

export function isLocalNetworkHost(value: string): boolean {
  const host = normalizeHost(value);
  return (
    isLoopbackHost(host) ||
    host === "m4mini.local" ||
    host.endsWith(".local") ||
    isPrivateIpv4Host(host) ||
    isTailscaleIpv4Host(host) ||
    isPrivateIpv6Host(host)
  );
}

export function requestRequiresPrivateProxyAuth(options: {
  hostname: string;
  proxyHostnames: ReadonlySet<string>;
  trustLocalNetwork: boolean;
}): boolean {
  const hostname = normalizeHost(options.hostname);
  if (options.proxyHostnames.has(hostname)) return true;
  if (isLoopbackHost(hostname)) return false;
  if (options.trustLocalNetwork && isLocalNetworkHost(hostname)) return false;
  return true;
}

export function allowsImplicitLocalAccess(options: {
  hostname: string;
  peerAddress: string | null | undefined;
  trustLocalNetwork: boolean;
}): boolean {
  const hostname = normalizeHost(options.hostname);
  const peerAddress = normalizeHost(options.peerAddress || "");
  if (!peerAddress) return false;

  const hostAllowed =
    isLoopbackHost(hostname) || (options.trustLocalNetwork && isLocalNetworkHost(hostname));
  const peerAllowed =
    isLoopbackHost(peerAddress) || (options.trustLocalNetwork && isLocalNetworkHost(peerAddress));
  return hostAllowed && peerAllowed;
}
