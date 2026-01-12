// src/screens/HomeScreen.tsx
import React, { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { post, get } from "../lib/api";
import { saveTokens, clearAllTokens } from "../lib/auth";
import { getDb, initDatabase } from "../database/db";

// ✅ modern popup
import ModernDialog from "../components/ModernDialog";

const PIN_LENGTH = 5;

type LocalUser = {
  id: string;
  name: string;
  email?: string | null;
  appRole?: string | null;
  roleName?: string | null;
  pin?: string | null;
  branchId?: string | null;
  isActive?: boolean;
  permissions?: string[];
};

/* -------------------- SQLITE HELPERS -------------------- */

async function ensureUsersTable() {
  await initDatabase();
  const db = getDb();

  await db.runAsync(`
    CREATE TABLE IF NOT EXISTS users_cache (
      id        TEXT PRIMARY KEY,
      name      TEXT,
      email     TEXT,
      appRole   TEXT,
      roleName  TEXT,
      pin       TEXT,
      branchId  TEXT,
      isActive  INTEGER,
      updatedAt TEXT
    );
  `);

  // add permissions column safely
  try {
    await db.runAsync(`ALTER TABLE users_cache ADD COLUMN permissions TEXT;`);
  } catch {
    // ignore if already exists
  }
}

async function saveUsersToSQLite(users: any[], branchId: string): Promise<void> {
  if (!branchId || !Array.isArray(users) || users.length === 0) return;

  await initDatabase();
  const db = getDb();
  const now = new Date().toISOString();

  await db.withTransactionAsync(async () => {
    await db.runAsync("DELETE FROM users_cache WHERE branchId = ?;", [branchId]);

    for (const u of users) {
      const id = String(u.id);
      const name = String(u.name ?? "");
      const email = u.email ?? null;
      const appRole = u.appRole ?? null;
      const roleName = u.roleName ?? null;
      const pin = u.pin ?? u.loginPin ?? null;
      const isActive = u.isActive === false ? 0 : 1;

      const permissions: string[] = Array.isArray(u.permissions) ? u.permissions : [];

      await db.runAsync(
        `INSERT OR REPLACE INTO users_cache
         (id, name, email, appRole, roleName, pin, branchId, isActive, updatedAt, permissions)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          name,
          email,
          appRole,
          roleName,
          pin,
          branchId,
          isActive,
          now,
          JSON.stringify(permissions),
        ]
      );
    }
  });
}

async function findLocalUserByPin(
  branchId: string,
  pin: string
): Promise<LocalUser | null> {
  if (!branchId || !pin) return null;

  await initDatabase();
  const db = getDb();

  try {
    const row = await db.getFirstAsync<any>(
      `SELECT * FROM users_cache
       WHERE branchId = ? AND pin = ? AND isActive = 1
       LIMIT 1`,
      [branchId, pin]
    );

    if (!row) return null;

    let permissions: string[] = [];
    try {
      permissions = row.permissions ? JSON.parse(row.permissions) : [];
    } catch {
      permissions = [];
    }

    return {
      id: row.id,
      name: row.name,
      email: row.email,
      appRole: row.appRole,
      roleName: row.roleName,
      pin: row.pin,
      branchId: row.branchId,
      isActive: !!row.isActive,
      permissions,
    };
  } catch (err) {
    console.log("SQLite findLocalUserByPin error:", err);
    return null;
  }
}

/* -------------------- COMPONENT -------------------- */

export default function HomeScreen({ navigation, online }: any) {
  const [pin, setPin] = useState("");
  const [loading, setLoading] = useState(false);

  const [branchId, setBranchId] = useState<string | null>(null);
  const [branchName, setBranchName] = useState<string | null>(null);
  const [brandName, setBrandName] = useState<string | null>(null);

  // ✅ Modern dialog state MUST be inside component
  const [syncDialog, setSyncDialog] = useState({
    visible: false,
    title: "",
    message: "",
    tone: "info" as "info" | "success" | "error",
  });

  function showDialog(
    tone: "info" | "success" | "error",
    title: string,
    message: string
  ) {
    setSyncDialog({ visible: true, tone, title, message });
  }

  //wire permission for cash access register
  function canAccessCashRegister(perms: string[]) {
    return Array.isArray(perms) && perms.includes("pos.cashRegister");
  }
  

  useEffect(() => {
    (async () => {
      try {
        await ensureUsersTable();
      } catch (e) {
        console.log("ensureUsersTable error", e);
      }
    })();
  }, []);

  // ✅ robust loader: try deviceInfo, then other common keys
  useEffect(() => {
    (async () => {
      try {
        // 1) deviceInfo (most common)
        const raw = await AsyncStorage.getItem("deviceInfo");
        if (raw) {
          const device = JSON.parse(raw);

          const bn =
            device.brand?.name ||
            device.brandName ||
            device.brand?.title ||
            device.brandTitle ||
            device.brand?.code ||
            device.brandCode ||
            null;

          const brName =
            device.branch?.name ||
            device.branchName ||
            device.branch?.title ||
            device.branchTitle ||
            null;

          const brId = device.branchId || device.branch?.id || null;

          if (bn) setBrandName(String(bn));
          if (brName) setBranchName(String(brName));
          if (brId) setBranchId(String(brId));
        }

        // 2) fallback: brand stored separately
        if (!brandName) {
          const candidates = [
            "pos_brand",
            "brandInfo",
            "brand",
            "selectedBrand",
            "currentBrand",
            "activeBrand",
            "brand_settings",
          ];

          for (const k of candidates) {
            const v = await AsyncStorage.getItem(k);
            if (!v) continue;

            try {
              const obj = JSON.parse(v);
              const bn =
                obj?.name ||
                obj?.brand?.name ||
                obj?.title ||
                obj?.code ||
                obj?.brandCode ||
                null;

              if (bn) {
                setBrandName(String(bn));
                break;
              }
            } catch {
              if (v && v.length > 0) {
                setBrandName(String(v));
                break;
              }
            }
          }
        }

        // 3) fallback: branch stored separately
        if (!branchName || !branchId) {
          const candidates = ["pos_branch", "branchInfo", "branch", "selectedBranch"];

          for (const k of candidates) {
            const v = await AsyncStorage.getItem(k);
            if (!v) continue;

            try {
              const obj = JSON.parse(v);
              const brName =
                obj?.name ||
                obj?.branch?.name ||
                obj?.title ||
                obj?.branchName ||
                null;
              const brId = obj?.id || obj?.branch?.id || obj?.branchId || null;

              if (!branchName && brName) setBranchName(String(brName));
              if (!branchId && brId) setBranchId(String(brId));

              if ((branchName || brName) && (branchId || brId)) break;
            } catch {
              // ignore
            }
          }
        }
      } catch (e) {
        console.log("Failed to load brand/branch info", e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem("deviceInfo");
        if (!raw) return;

        const device = JSON.parse(raw);

        setBranchId(device.branchId || device.branch?.id || null);
        setBranchName(device.branch?.name || device.branchName || null);

        const storedBrand = device.brand?.name || device.brandName || null;
        if (storedBrand) setBrandName(storedBrand);

        const deviceId = device.id;
        if (deviceId && !storedBrand) {
          const live: any = await get(`/devices/${deviceId}`);
          const liveBrandName = live?.branch?.brand?.name || null;
          const liveBranchName = live?.branch?.name || null;

          if (liveBrandName) setBrandName(liveBrandName);
          if (liveBranchName) setBranchName(liveBranchName);

          const merged = {
            ...device,
            branch: live?.branch ?? device.branch ?? null,
            brand: live?.branch?.brand ?? device.brand ?? null,
            brandName: liveBrandName ?? device.brandName ?? null,
            branchName: liveBranchName ?? device.branchName ?? null,
          };
          await AsyncStorage.setItem("deviceInfo", JSON.stringify(merged));
        }
      } catch (e) {
        console.log("Failed to load deviceInfo / fetch brand", e);
      }
    })();
  }, []);

  const handleChangePin = useCallback(
    (digit: string) => {
      if (loading) return;

      if (digit === "C") {
        setPin("");
        return;
      }

      if (pin.length >= PIN_LENGTH) return;

      setPin(pin + digit);
    },
    [pin, loading]
  );

  const loginWithPinOnline = useCallback(
    async (p: string) => {
      if (!branchId) {
        Alert.alert(
          "Device not activated",
          "This device is not linked to a branch. Please activate the device first."
        );
        setPin("");
        return;
      }
  
      try {
        setLoading(true);
  
        const res: any = await post("/auth/login-pin", { pin: p, branchId });
  
        setPin("");
  
        const permissions: string[] = Array.isArray(res.permissions) ? res.permissions : [];
  
        // 🔐 Access Cash Register gate (ONLINE)
        if (!canAccessCashRegister(permissions)) {
          await clearAllTokens(); // optional (recommended)
          showDialog("error", "Access denied", "You dont have access, contact your administrator");
          setPin("");
          return;
        }
  
        const accessToken =
          typeof res.accessToken === "string"
            ? res.accessToken
            : typeof res.token === "string"
            ? res.token
            : null;
  
        const refreshToken = typeof res.refreshToken === "string" ? res.refreshToken : null;
  
        if (accessToken && refreshToken) {
          await saveTokens(accessToken, refreshToken);
        }
  
        const branchObj = res.branch ?? { id: branchId, name: branchName ?? "" };
  
        const userPayload: LocalUser = {
          id: res.id,
          name: res.name,
          email: res.email,
          appRole: res.appRole,
          roleName: res.roleName,
          branchId: branchObj?.id ?? branchId,
          permissions,
        };
  
        await AsyncStorage.multiSet([
          ["pos_user", JSON.stringify(userPayload)],
          ["pos_branch", JSON.stringify(branchObj)],
        ]);
  
        try {
          await saveUsersToSQLite(
            [
              {
                id: res.id,
                name: res.name,
                email: res.email,
                appRole: res.appRole,
                roleName: res.roleName,
                pin: p,
                isActive: true,
                permissions,
              },
            ],
            branchId
          );
        } catch (cacheErr) {
          console.log("Cache single user (online login) err:", cacheErr);
        }
  
        navigation.reset({
          index: 0,
          routes: [
            {
              name: "ClockIn",
              params: {
                branchId: branchObj?.id ?? null,
                branchName: branchObj?.name ?? "",
                userName: res.name,
              },
            },
          ],
        });
      } catch (err: any) {
        console.log("LOGIN PIN ERR", err);
        setPin("");
        const msg = String(err?.message || "");
        if (msg.includes("OFFLINE_MODE")) {
          Alert.alert(
            "Offline",
            "You appear to be offline. Please connect to the internet for online login, or use offline PIN login with cached users."
          );
        } else {
          Alert.alert("Login failed", "Invalid PIN or this user is not assigned to this branch.");
        }
      } finally {
        setLoading(false);
      }
    },
    [branchId, branchName, navigation]
  );
  
  const loginWithPinOffline = useCallback(
    async (p: string) => {
      if (!branchId) {
        Alert.alert(
          "Device not activated",
          "This device is not linked to a branch. Please activate the device first."
        );
        setPin("");
        return;
      }
  
      try {
        setLoading(true);
  
        const user = await findLocalUserByPin(branchId, p);
        if (!user) {
          setPin("");
          Alert.alert(
            "Offline login failed",
            "No offline user found for this PIN. Please sync users while online."
          );
          return;
        }
  
        const permissions: string[] = Array.isArray(user.permissions) ? user.permissions : [];
  
        // 🔐 Access Cash Register gate (OFFLINE)
        if (!canAccessCashRegister(permissions)) {
          showDialog("error", "Access denied", "You dont have access, contact your administrator");
          setPin("");
          return;
        }
  
        const branchRaw = await AsyncStorage.getItem("pos_branch");
        const branchObj = branchRaw ? JSON.parse(branchRaw) : null;
  
        await AsyncStorage.setItem(
          "pos_user",
          JSON.stringify({
            id: user.id,
            name: user.name,
            email: user.email,
            appRole: user.appRole,
            roleName: user.roleName,
            branchId: user.branchId ?? branchId,
            permissions,
          } as LocalUser)
        );
  
        navigation.reset({
          index: 0,
          routes: [
            {
              name: "ClockIn",
              params: {
                branchId: branchObj?.id ?? branchId,
                branchName: branchObj?.name ?? branchName ?? "",
                userName: user.name,
              },
            },
          ],
        });
  
        setPin("");
      } catch (err) {
        console.log("OFFLINE LOGIN ERR", err);
        setPin("");
        Alert.alert("Offline login failed", "Unable to login offline. Please try again or use online login.");
      } finally {
        setLoading(false);
      }
    },
    [branchId, branchName, navigation]
  );
  

  const loginWithPin = useCallback(
    async (p: string) => {
      if (online) await loginWithPinOnline(p);
      else await loginWithPinOffline(p);
    },
    [online, loginWithPinOnline, loginWithPinOffline]
  );

  useEffect(() => {
    if (pin.length === PIN_LENGTH && !loading) {
      loginWithPin(pin);
    }
  }, [pin, loading, loginWithPin]);

  const onSyncUsers = async () => {
    if (!branchId) {
      Alert.alert(
        "Device not activated",
        "Cannot sync users because this device is not linked to any branch."
      );
      return;
    }

    if (!online) {
      showDialog("info", "Offline", "You are offline. Connect to the internet to sync users.");
      return;
    }

    try {
      setLoading(true);

      const res: any = await post("/auth/sync-users", { branchId });
      const list: any[] = Array.isArray(res) ? res : res?.users ?? [];

      if (!Array.isArray(list) || list.length === 0) {
        showDialog("info", "Sync finished", "No users returned from server.");
      } else {
        await saveUsersToSQLite(list, branchId);
        showDialog("success", "Sync finished", `Synced ${list.length} users.`);
      }
    } catch (e: any) {
      console.log("SYNC USERS ERR", e);
      const msg = String(e?.message || "");

      if (msg.includes("SESSION_EXPIRED")) {
        await clearAllTokens();
        showDialog(
          "error",
          "Session expired",
          "Online session has expired. Please login again with PIN while online. You can still use offline PIN with cached users."
        );
      } else if (msg.includes("OFFLINE_MODE")) {
        showDialog("info", "Offline", "You appear to be offline. Connect to the internet to sync users.");
      } else {
        showDialog("error", "Sync failed", "Unable to sync users. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  };

  const renderDots = () => (
    <View style={styles.dotsRow}>
      {Array.from({ length: PIN_LENGTH }).map((_, i) => (
        <View key={i} style={[styles.dot, i < pin.length ? styles.dotFilled : styles.dotEmpty]} />
      ))}
    </View>
  );

  const keypadDigits = [
    ["1", "2", "3"],
    ["4", "5", "6"],
    ["7", "8", "9"],
    ["0", "C"],
  ];

  return (
    <View style={styles.root}>
      <View style={styles.card}>
        <Text style={styles.logo}>DWF POS</Text>
        <Text style={styles.subtitle}>Login PIN</Text>

        {renderDots()}

        <View style={styles.keypad}>
          {keypadDigits.map((row, idx) => (
            <View key={idx} style={styles.keypadRow}>
              {row.map((d) => (
                <Pressable
                  key={d}
                  onPress={() => handleChangePin(d)}
                  style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
                  disabled={loading}
                >
                  <Text style={styles.keyText}>{d}</Text>
                </Pressable>
              ))}
            </View>
          ))}
        </View>

        <Pressable
          style={({ pressed }) => [styles.syncButton, pressed && styles.syncButtonPressed]}
          onPress={onSyncUsers}
          disabled={loading}
        >
          {loading ? <ActivityIndicator /> : <Text style={styles.syncText}>Sync Users</Text>}
        </Pressable>

        {/* ✅ Footer: ONLY Brand + Branch + Status */}
        <View style={styles.footer}>
          <Text style={styles.footerText}>Brand: {brandName ? brandName : "#N/A"}</Text>
          <Text style={styles.footerText}>
            {branchName ? `Branch: ${branchName}` : "Branch: Not linked (activate device)"}
          </Text>
          <Text style={styles.footerText}>Status: {online ? "Online" : "Offline"}</Text>
        </View>
      </View>

      {/* ✅ Modern stylish popup (render once, at screen root) */}
      <ModernDialog
        visible={syncDialog.visible}
        tone={syncDialog.tone}
        title={syncDialog.title}
        message={syncDialog.message}
        primaryText="Done"
        onPrimary={() => setSyncDialog((p) => ({ ...p, visible: false }))}
        onClose={() => setSyncDialog((p) => ({ ...p, visible: false }))}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#020617",
    alignItems: "center",
    justifyContent: "center",
  },
  card: {
    width: "80%",
    maxWidth: 600,
    backgroundColor: "#f9fafb",
    borderRadius: 24,
    paddingVertical: 40,
    paddingHorizontal: 32,
    alignItems: "center",
  },
  logo: {
    fontSize: 26,
    fontWeight: "700",
    letterSpacing: 2,
    color: "#111827",
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 16,
    color: "#4b5563",
    marginBottom: 24,
  },
  dotsRow: { flexDirection: "row", marginBottom: 32 },
  dot: { width: 16, height: 16, borderRadius: 8, marginHorizontal: 6 },
  dotEmpty: {
    borderWidth: 1,
    borderColor: "#cbd5f5",
    backgroundColor: "transparent",
  },
  dotFilled: { backgroundColor: "#000000" },
  keypad: { width: "100%", marginBottom: 24 },
  keypadRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 12 },
  key: {
    flex: 1,
    marginHorizontal: 6,
    paddingVertical: 18,
    borderRadius: 16,
    backgroundColor: "#e5e7eb",
    alignItems: "center",
    justifyContent: "center",
  },
  keyPressed: { backgroundColor: "#d1d5db" },
  keyText: { fontSize: 22, fontWeight: "600", color: "#111827" },
  syncButton: {
    marginTop: 4,
    width: "80%",
    paddingVertical: 14,
    borderRadius: 16,
    backgroundColor: "#111827",
    alignItems: "center",
    justifyContent: "center",
  },
  syncButtonPressed: { opacity: 0.9 },
  syncText: { color: "#f9fafb", fontSize: 16, fontWeight: "600" },
  footer: { marginTop: 24, width: "100%" },
  footerText: { fontSize: 12, color: "#6b7280" },
});
