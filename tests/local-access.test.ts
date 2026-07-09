import { describe, expect, test } from "bun:test";
import {
  allowsImplicitLocalAccess,
  requestRequiresProxyToken,
} from "../src/server/local-access";

const noProxyHostnames = new Set<string>();

describe("local music server access policy", () => {
  test("trusts loopback host and peer without a proxy token", () => {
    expect(requestRequiresProxyToken({
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

  test("requires a proxy token for LAN and Tailscale requests by default", () => {
    for (const hostname of ["192.168.1.240", "100.121.144.60", "m4mini.local", "fd7a:115c:a1e0::1"]) {
      expect(requestRequiresProxyToken({
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
    expect(requestRequiresProxyToken({
      hostname: "music.streamarena.xyz",
      proxyHostnames: new Set(["music.streamarena.xyz"]),
      trustLocalNetwork: true,
    })).toBe(true);
  });
});
