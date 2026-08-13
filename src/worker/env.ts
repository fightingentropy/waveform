import type { SqlTag } from "@/lib/sql-tag";
import {
  LOCAL_OWNER_EMAIL,
  LOCAL_OWNER_IMAGE_URL,
  LOCAL_OWNER_NAME,
  LOCAL_OWNER_USER_ID,
} from "../../packages/shared/src/local-owner";

export type AuthUser = {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  emailVerified?: string | Date | null;
};

export type Variables = {
  user: AuthUser | null;
  db: SqlTag;
};

export type AppEnv = {
  Bindings: CloudflareEnv;
  Variables: Variables;
};

export const LOCAL_MAC_MINI_AUTH_USER: AuthUser = {
  id: LOCAL_OWNER_USER_ID,
  email: LOCAL_OWNER_EMAIL,
  name: LOCAL_OWNER_NAME,
  image: LOCAL_OWNER_IMAGE_URL,
  emailVerified: "owner",
};
