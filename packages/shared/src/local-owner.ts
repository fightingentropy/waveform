export const LOCAL_OWNER_USER_ID = "local-mac-mini";
export const LOCAL_OWNER_EMAIL = "owner@localhost";
export const LOCAL_OWNER_NAME = "Library Owner";
export const LOCAL_OWNER_IMAGE_URL = "/profile.jpg";

export function isLocalOwnerUserId(id: string): boolean {
  return id === LOCAL_OWNER_USER_ID;
}

export function defaultLocalOwnerImage(email: string): string | null {
  const normalized = email.trim().toLowerCase();
  if (normalized === LOCAL_OWNER_EMAIL || normalized.endsWith("@spotify.local")) {
    return LOCAL_OWNER_IMAGE_URL;
  }
  return null;
}
