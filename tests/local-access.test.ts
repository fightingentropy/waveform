import { describe, expect, test } from "bun:test";
import {
  allowsImplicitLocalAccess,
  requestRequiresPrivateProxyAuth,
} from "../src/server/local-access";

const noProxyHostnames = new Set<string>();

describe("local music server access policy", () => {
  test("trusts loopback host and peer without private-proxy auth", () => {
    expect(requestRequiresPrivateProxyAuth({
      hostname: "127.0.0.1",
      proxyHostnames: noProxyHostnames,
      trustLocalNetwork: false,
    })).toBe(false);
    expect(allowsImplicitLocalAccess({
      hostname: "localhost",
      peerAddress: "::1",
      trustLocalNetwork: false,
    })).toBe(true);
  });

  test("requires private-proxy auth for LAN and overlay-network requests by default", () => {
    for (const hostname of ["192.168.1.240", "100.121.144.60", "m4mini.local", "fd7a:115c:a1e0::1"]) {
      expect(requestRequiresPrivateProxyAuth({
        hostname,
        proxyHostnames: noProxyHostnames,
        trustLocalNetwork: false,
      })).toBe(true);
      expect(allowsImplicitLocalAccess({
        hostname,
        peerAddress: hostname,
        trustLocalNetwork: false,
      })).toBe(false);
    }
  });

  test("allows deliberate LAN trust only when both host and peer are local", () => {
    expect(allowsImplicitLocalAccess({
      hostname: "m4mini.local",
      peerAddress: "192.168.1.50",
      trustLocalNetwork: true,
    })).toBe(true);
    expect(allowsImplicitLocalAccess({
      hostname: "m4mini.local",
      peerAddress: "203.0.113.25",
      trustLocalNetwork: true,
    })).toBe(false);
  });

  test("always requires a token for configured proxy hostnames", () => {
    expect(requestRequiresPrivateProxyAuth({
      hostname: "music.streamarena.xyz",
      proxyHostnames: new Set(["music.streamarena.xyz"]),
      trustLocalNetwork: true,
    })).toBe(true);
  });
});
