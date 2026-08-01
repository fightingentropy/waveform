import { describe, expect, test } from "bun:test";
import { SHARED_CLIENT_CAPABILITIES } from "../src/lib/client-parity";

const webRoutes = await Bun.file(new URL("../src/client/App.tsx", import.meta.url)).text();
const mobileStack = await Bun.file(new URL("../mobile/src/app/_layout.tsx", import.meta.url)).text();
const mobileTabs = await Bun.file(new URL("../mobile/src/app/(tabs)/_layout.tsx", import.meta.url)).text();
const webStats = await Bun.file(new URL("../src/client/pages/ListeningStatsPage.tsx", import.meta.url)).text();
const mobileStats = await Bun.file(new URL("../mobile/src/app/listening-stats.tsx", import.meta.url)).text();

describe("web/mobile navigation parity", () => {
  test("keeps every shared client workflow reachable on both platforms", () => {
    for (const capability of SHARED_CLIENT_CAPABILITIES) {
      expect(webRoutes, `web route missing for ${capability.id}`).toContain(`path="${capability.webRoute}"`);
      const mobileSource = ["index", "search", "library"].includes(capability.mobileRoute)
        ? mobileTabs
        : mobileStack;
      expect(mobileSource, `mobile route missing for ${capability.id}`).toContain(
        `name="${capability.mobileRoute}"`,
      );
    }
  });

  test("uses the same listening-stats API contract on web and mobile", () => {
    expect(webStats).toContain('withAccountScope("/api/stats/listening"');
    expect(mobileStats).toContain('withAccountScope("/api/stats/listening"');
    expect(webStats).toContain("minutesListened");
    expect(mobileStats).toContain("minutesListened");
  });
});
