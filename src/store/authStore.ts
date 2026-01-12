// src/store/authStore.ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { get } from "../lib/api";

export type AuthUser = {
  id?: string;
  name?: string;
  roleId?: string | null;
  roleName?: string | null;
  permissions: string[];
};

type AuthState = {
  user: AuthUser | null;
  permissions: string[];

  setUser: (u: AuthUser | null) => Promise<void>;
  setPermissions: (perms: string[]) => Promise<void>;

  hasPermission: (code: string) => boolean;

  hydrate: () => Promise<void>;
  refresh: () => Promise<void>;
  clear: () => Promise<void>;
};

const STORAGE_USER = "pos_user";
const STORAGE_PERMS = "pos_permissions";
// ✅ add token key(s) used in your app
const STORAGE_TOKEN = "pos_token";
const STORAGE_TOKEN_ALT = "token"; // optional safety if you also store "token"

function cleanPerms(perms: any): string[] {
  return Array.from(
    new Set(
      (Array.isArray(perms) ? perms : [])
        .map((p) => (typeof p === "string" ? p.trim() : ""))
        .filter(Boolean)
    )
  );
}

// ✅ helper: detect auth revocation from API error shape
function isAuthRevokedError(e: any): boolean {
  const msg = (e?.message || "").toString();
  const code = (e?.code || e?.response?.data?.code || e?.data?.code || "").toString();
  const status = e?.status || e?.response?.status;

  // If your lib/api throws "401 Unauthorized" etc.
  if (status === 401) return true;
  if (msg.includes("401")) return true;
  if (msg.toLowerCase().includes("unauthorized")) return true;

  // Backend codes we return
  if (code === "ROLE_REVOKED" || code === "USER_DISABLED") return true;

  // Sometimes backend error serialized in message
  if (msg.includes("ROLE_REVOKED") || msg.includes("USER_DISABLED")) return true;

  return false;
}

export const useAuthStore = create<AuthState>((set, getState) => ({
  user: null,
  permissions: [],

  setUser: async (u) => {
    const perms = cleanPerms(u?.permissions);
    set({ user: u ? { ...u, permissions: perms } : null, permissions: perms });

    try {
      if (u) {
        await AsyncStorage.setItem(
          STORAGE_USER,
          JSON.stringify({ ...u, permissions: perms })
        );
        await AsyncStorage.setItem(STORAGE_PERMS, JSON.stringify(perms));
      } else {
        await AsyncStorage.multiRemove([STORAGE_USER, STORAGE_PERMS]);
      }
    } catch (e) {
      console.log("setUser storage error", e);
    }
  },

  setPermissions: async (perms) => {
    const clean = cleanPerms(perms);
    set({ permissions: clean });

    try {
      await AsyncStorage.setItem(STORAGE_PERMS, JSON.stringify(clean));
      const u = getState().user;
      if (u) {
        await AsyncStorage.setItem(
          STORAGE_USER,
          JSON.stringify({ ...u, permissions: clean })
        );
      }
    } catch (e) {
      console.log("setPermissions storage error", e);
    }
  },

  hasPermission: (code) => {
    const c = (code || "").trim();
    if (!c) return false;
    const perms = getState().permissions || [];
    return perms.includes(c);
  },

  hydrate: async () => {
    try {
      const rawUser = await AsyncStorage.getItem(STORAGE_USER);
      const rawPerms = await AsyncStorage.getItem(STORAGE_PERMS);

      const user = rawUser ? (JSON.parse(rawUser) as AuthUser) : null;
      const perms = rawPerms ? JSON.parse(rawPerms) : user?.permissions;

      set({
        user,
        permissions: cleanPerms(perms),
      });
    } catch (e) {
      console.log("auth hydrate error", e);
      set({ user: null, permissions: [] });
    }
  },

  // ✅ This forces logout if role revoked / user disabled / token invalid
  refresh: async () => {
    try {
      const me: any = await get("/auth/me"); // backend returns latest role permissions

      // 🚫 If backend returns user but role removed (extra safety)
      if (!me?.roleId) {
        await getState().clear();
        console.log("🚫 role revoked: missing roleId");
        return;
      }

      const nextUser: AuthUser = {
        id: me?.id,
        name: me?.name,
        roleId: me?.roleId ?? null,
        roleName: me?.roleName ?? null,
        permissions: cleanPerms(me?.permissions),
      };

      await getState().setUser(nextUser);
      console.log("✅ permissions refreshed", nextUser.permissions);
    } catch (e: any) {
      // ✅ force logout only for auth revoke
      if (isAuthRevokedError(e)) {
        console.log("🚫 auth revoked, logging out", e?.message || e);
        await getState().clear();
        return;
      }

      // ✅ offline / server down => keep cached perms (your original behavior)
      console.log("auth refresh error (kept cached perms)", e?.message || e);
    }
  },

  clear: async () => {
    set({ user: null, permissions: [] });
    try {
      await AsyncStorage.multiRemove([
        STORAGE_USER,
        STORAGE_PERMS,
        STORAGE_TOKEN,
        STORAGE_TOKEN_ALT, // optional safety
      ]);
    } catch (e) {
      console.log("auth clear storage error", e);
    }
  },
}));

export const authStore = useAuthStore;
