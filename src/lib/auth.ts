// src/lib/auth.ts
import * as SecureStore from 'expo-secure-store';

// We keep the same key you used before so old data isn't lost.
const ACCESS_KEY = 'pos_token';
const REFRESH_KEY = 'pos_refresh_token';

/* ------------------------ ACCESS TOKEN ------------------------ */

// New API
export async function setAccessToken(token: string | null) {
  if (!token) {
    await SecureStore.deleteItemAsync(ACCESS_KEY);
    return;
  }
  await SecureStore.setItemAsync(ACCESS_KEY, token);
}

export async function getAccessToken() {
  return await SecureStore.getItemAsync(ACCESS_KEY);
}

export async function clearAccessToken() {
  await SecureStore.deleteItemAsync(ACCESS_KEY);
}

/* ------------------------ REFRESH TOKEN ------------------------ */

export async function setRefreshToken(token: string | null) {
  if (!token) {
    await SecureStore.deleteItemAsync(REFRESH_KEY);
    return;
  }
  await SecureStore.setItemAsync(REFRESH_KEY, token);
}

export async function getRefreshToken() {
  return await SecureStore.getItemAsync(REFRESH_KEY);
}

export async function clearRefreshToken() {
  await SecureStore.deleteItemAsync(REFRESH_KEY);
}

/* ------------------------ COMBINED HELPERS ------------------------ */

export async function saveTokens(accessToken: string, refreshToken: string) {
  await setAccessToken(accessToken);
  await setRefreshToken(refreshToken);
}

export async function clearAllTokens() {
  await clearAccessToken();
  await clearRefreshToken();
}

/* --------- BACKWARD-COMPAT EXPORTS (for old getToken usage) --------- */
// These make existing code that imports { getToken, setToken, clearToken }
// still work, but under the hood they use the new access-token helpers.

export async function setToken(t: string) {
  await setAccessToken(t);
}

export async function getToken() {
  return getAccessToken();
}

export async function clearToken() {
  await clearAccessToken();
}
