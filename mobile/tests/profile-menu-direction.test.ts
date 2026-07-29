import { describe, expect, test } from "bun:test";

const profileMenu = await Bun.file(
  new URL("../src/components/profile/ProfileMenu.tsx", import.meta.url),
).text();

describe("profile menu direction", () => {
  test("anchors to the avatar side and enters from the right", () => {
    expect(profileMenu).toContain('right: 0,');
    expect(profileMenu).not.toContain('left: 0,');
    expect(profileMenu).toContain(
      "translateX: panelW * (1 - progress.value) + dragX.value",
    );
    expect(profileMenu).toContain(
      "progress.value - dragX.value / panelW",
    );
  });

  test("follows and dismisses with a rightward swipe", () => {
    expect(profileMenu).toContain(
      "dragX.value = Math.max(0, e.translationX)",
    );
    expect(profileMenu).toContain(
      "e.translationX > 80 || e.velocityX > 800",
    );
  });

  test("cannot leave an invisible full-screen touch blocker after closing", () => {
    expect(profileMenu).toContain(
      'pointerEvents={open ? "auto" : "none"}',
    );
    expect(profileMenu).toContain("accessibilityViewIsModal={open}");
  });
});
