// src/lib/api.ts
import { API_URL } from "./config";
import { getToken } from "./auth";
import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";

// -------------------------
// Token helpers
// -------------------------

async function getRefreshToken() {
  return AsyncStorage.getItem("refreshToken");
}

async function setAccessToken(value: string | null) {
  // IMPORTANT: this must match what `getToken()` reads.
  // To be safe, we sync both "token" and "accessToken".
  if (value == null) {
    await AsyncStorage.removeItem("token");
    await AsyncStorage.removeItem("accessToken");
  } else {
    await AsyncStorage.setItem("token", value);
    await AsyncStorage.setItem("accessToken", value);
  }
}

async function setRefreshToken(value: string | null) {
  if (value == null) {
    await AsyncStorage.removeItem("refreshToken");
  } else {
    await AsyncStorage.setItem("refreshToken", value);
  }
}

// -------------------------
// Global logout (no circular deps)
// -------------------------

async function forceLogout(reason: string, errorData?: any) {
  console.log("🚫 FORCE LOGOUT:", reason, errorData ?? "");

  // clear tokens
  await setAccessToken(null);
  await setRefreshToken(null);

  // clear auth store if available (dynamic import avoids circular deps)
  try {
    const mod = await import("../store/authStore");
    const store = mod.useAuthStore?.getState?.();
    if (store?.clear) {
      await store.clear();
    }
  } catch (e) {
    console.log("forceLogout: could not clear authStore (ok)", e);
  }
}

// -------------------------
// Refresh logic
// -------------------------

let refreshPromise: Promise<void> | null = null;

async function refreshAccessToken() {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      const refreshToken = await getRefreshToken();
      if (!refreshToken) {
        throw new Error("NO_REFRESH_TOKEN");
      }

      const url = `${API_URL}/auth/refresh`;
      console.log("API POST (refresh)", url);

      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          refreshToken,
          deviceId: "POS-ANDROID",
        }),
      });

      const text = await resp.text();
      console.log("API RESP (refresh)", resp.status, text);

      if (!resp.ok) {
        throw new Error(`REFRESH_FAILED ${resp.status} – ${text}`);
      }

      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error("REFRESH_RESPONSE_INVALID");
      }

      if (!data.accessToken) {
        throw new Error("NO_ACCESS_TOKEN_IN_REFRESH");
      }

      // Save new tokens
      await setAccessToken(data.accessToken);
      if (data.refreshToken) {
        await setRefreshToken(data.refreshToken);
      }
    })().finally(() => {
      refreshPromise = null;
    });
  }

  return refreshPromise;
}

// -------------------------
// Response handler
// -------------------------

async function handleResponse(res: Response) {
  const text = await res.text();
  console.log("API RESP", res.status, text);

  if (!res.ok) {
    // Try to parse structured error
    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    // Attach helpful info (your callers can still catch)
    const err: any = new Error(`HTTP ${res.status} – ${text}`);
    err.status = res.status;
    err.data = data;
    err.code = data?.code || data?.error || null;

    throw err;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// -------------------------
// Core request with auto-refresh + forced logout
// -------------------------

async function apiRequest(method: "GET" | "POST", path: string, body?: any) {
  // 1) Offline check – do NOT hit API if device is offline
  const netState = await NetInfo.fetch();
  if (!netState.isConnected) {
    console.log("API SKIP (offline)", path);
    throw new Error("OFFLINE_MODE");
  }

  const url = `${API_URL}${path}`;
  let token = await getToken();

  const doFetch = async () => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };

    if (method === "GET") console.log("API GET", url);
    else console.log("API POST", url, body);

    const res = await fetch(url, {
      method,
      headers,
      ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
    });

    // If not 401, return as-is
    if (res.status !== 401) return res;

    // Parse 401 body once (clone to not consume)
    let errorData: any = null;
    try {
      const cloneText = await res.clone().text();
      try {
        errorData = JSON.parse(cloneText);
      } catch {
        errorData = { raw: cloneText };
      }
      console.log("API 401 body", errorData);
    } catch {
      // ignore
    }

    const code = errorData?.code || errorData?.error || null;

    // ✅ 401 due to role revoked / user disabled / invalid token => logout immediately (no refresh)
    const isRevoked =
      code === "ROLE_REVOKED" ||
      code === "USER_DISABLED" ||
      code === "INVALID_TOKEN" ||
      code === "UNAUTHENTICATED" ||
      code === "UNAUTHORIZED";

    if (isRevoked) {
      await forceLogout(code || "AUTH_REVOKED", errorData);
      return res; // will be handled by final guard
    }

    // Only refresh if token expired
    const isTokenExpired =
      code === "TOKEN_EXPIRED" ||
      errorData?.error === "Token expired" ||
      (typeof errorData?.message === "string" &&
        errorData.message.toLowerCase().includes("expired"));

    if (!isTokenExpired) {
      // Some other 401 -> logout (safer for POS)
      await forceLogout(code || "UNAUTHORIZED", errorData);
      return res;
    }

    // 2) Access token expired → auto-refresh once
    console.log("🔄 Access token expired, trying refresh...");
    try {
      await refreshAccessToken();
    } catch (e) {
      // refresh failed => logout
      await forceLogout("REFRESH_FAILED", { errorData, refreshError: String((e as any)?.message || e) });
      return res;
    }

    // Update token after refresh
    token = await getToken();

    const retryHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };

    console.log("API RETRY", method, url);

    // Retry original request once
    return fetch(url, {
      method,
      headers: retryHeaders,
      ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
    });
  };

  const res = await doFetch();

  // Final guard: if still 401 after refresh attempt → session is dead
  if (res.status === 401) {
    let errorData: any = null;
    try {
      const t = await res.clone().text();
      errorData = (() => {
        try {
          return JSON.parse(t);
        } catch {
          return { raw: t };
        }
      })();
    } catch {}

    await forceLogout("SESSION_EXPIRED", errorData);
    throw new Error("SESSION_EXPIRED");
  }

  return handleResponse(res);
}

// -------------------------
// Public API functions
// -------------------------

export async function get(path: string) {
  return apiRequest("GET", path);
}

export async function post(path: string, body: any) {
  return apiRequest("POST", path, body);
}
