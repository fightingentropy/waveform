import { describe, expect, test } from "bun:test";
import {
  LOCAL_OWNER_EMAIL,
  LOCAL_OWNER_IMAGE_URL,
  LOCAL_OWNER_USER_ID,
  defaultLocalOwnerImage,
  isLocalOwnerUserId,
} from "../packages/shared/src/local-owner";

describe("local owner identity", () => {
  test("keeps the sentinel user id and maps cached local emails to the profile image", () => {
    expect(LOCAL_OWNER_USER_ID).toBe("local-mac-mini");
    expect(isLocalOwnerUserId(LOCAL_OWNER_USER_ID)).toBe(true);
    expect(defaultLocalOwnerImage(LOCAL_OWNER_EMAIL)).toBe(LOCAL_OWNER_IMAGE_URL);
    expect(defaultLocalOwnerImage("erlin@spotify.local")).toBe(LOCAL_OWNER_IMAGE_URL);
    expect(defaultLocalOwnerImage("someone@example.com")).toBeNull();
  });
});
