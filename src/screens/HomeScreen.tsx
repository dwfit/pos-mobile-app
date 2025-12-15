// src/screens/HomeScreen.tsx
import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { post } from '../lib/api';

// ✅ token helpers (access + refresh) – new
import { saveTokens, clearAllTokens } from '../lib/auth';

// ✅ Expo SQLite helpers
import { getDb, initDatabase } from '../database/db';

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
  // 🔹 cached permissions for offline login
  permissions?: string[];
};

/* -------------------- SQLITE HELPERS -------------------- */

async function ensureUsersTable() {
  // Make sure DB is ready (safe even if already init)
  await initDatabase();
  const db = getDb();

  // original definition (without permissions column)
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

  // 🔹 try to add permissions column (idempotent)
  try {
    await db.runAsync(
      `ALTER TABLE users_cache ADD COLUMN permissions TEXT;`,
    );
  } catch (e) {
    // will fail if column already exists – ignore
    // console.log('users_cache.permissions already exists or alter failed:', e);
  }
}

async function saveUsersToSQLite(users: any[], branchId: string): Promise<void> {
  if (!branchId || !Array.isArray(users) || users.length === 0) {
    return;
  }

  await initDatabase();
  const db = getDb();

  const now = new Date().toISOString();

  await db.withTransactionAsync(async () => {
    // delete old users for that branch
    await db.runAsync('DELETE FROM users_cache WHERE branchId = ?;', [branchId]);

    for (const u of users) {
      const id = String(u.id);
      const name = String(u.name ?? '');
      const email = u.email ?? null;
      const appRole = u.appRole ?? null;
      const roleName = u.roleName ?? null;
      const pin = u.pin ?? u.loginPin ?? null;
      const isActive = u.isActive === false ? 0 : 1;

      // 🔹 normalize permissions array
      const permissions: string[] = Array.isArray(u.permissions)
        ? u.permissions
        : [];

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
        ],
      );
    }
  });
}

async function findLocalUserByPin(
  branchId: string,
  pin: string,
): Promise<LocalUser | null> {
  if (!branchId || !pin) {
    return null;
  }

  await initDatabase();
  const db = getDb();

  try {
    const row = await db.getFirstAsync<any>(
      `SELECT * FROM users_cache
       WHERE branchId = ? AND pin = ? AND isActive = 1
       LIMIT 1`,
      [branchId, pin],
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
      // 🔹 return permissions from cache
      permissions,
    };
  } catch (err) {
    console.log('SQLite findLocalUserByPin error:', err);
    return null;
  }
}

/* -------------------- COMPONENT -------------------- */

export default function HomeScreen({ navigation, online }: any) {
  const [pin, setPin] = useState('');
  const [loading, setLoading] = useState(false);

  const [branchId, setBranchId] = useState<string | null>(null);
  const [branchName, setBranchName] = useState<string | null>(null);
  const [deviceRef, setDeviceRef] = useState<string | null>(null);

  useEffect(() => {
    // ensure users table exists (fire-and-forget)
    (async () => {
      try {
        await ensureUsersTable();
      } catch (e) {
        console.log('ensureUsersTable error', e);
      }
    })();
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem('deviceInfo');
        if (raw) {
          const device = JSON.parse(raw);
          setBranchId(device.branchId || device.branch?.id || null);
          setBranchName(device.branch?.name || null);
          setDeviceRef(device.reference || device.code || device.id || null);
        } else {
          console.log('No deviceInfo found in AsyncStorage');
        }
      } catch (e) {
        console.log('Failed to load deviceInfo', e);
      }
    })();
  }, []);

  const handleChangePin = useCallback(
    (digit: string) => {
      if (loading) return;

      if (digit === 'C') {
        setPin('');
        return;
      }

      if (pin.length >= PIN_LENGTH) return;

      const next = pin + digit;
      setPin(next);
    },
    [pin, loading],
  );

  const loginWithPinOnline = useCallback(
    async (p: string) => {
      if (!branchId) {
        Alert.alert(
          'Device not activated',
          'This device is not linked to a branch. Please activate the device first.',
        );
        setPin('');
        return;
      }

      try {
        setLoading(true);

        console.log('🔐 PIN login (ONLINE) with branchId:', branchId);
        const res: any = await post('/auth/login-pin', { pin: p, branchId });

        console.log('✅ PIN login success:', res);
        setPin('');

        // 🔹 capture permissions from backend
        const permissions: string[] = Array.isArray(res.permissions)
          ? res.permissions
          : [];

        // 🔹 capture tokens from backend for API calls (access + refresh)
        const accessToken =
          typeof res.accessToken === 'string'
            ? res.accessToken
            : typeof res.token === 'string'
            ? res.token
            : null;
        const refreshToken =
          typeof res.refreshToken === 'string' ? res.refreshToken : null;

        if (accessToken && refreshToken) {
          await saveTokens(accessToken, refreshToken);
        }

        const branchObj = res.branch ?? {
          id: branchId,
          name: branchName ?? '',
        };

        const userPayload: LocalUser = {
          id: res.id,
          name: res.name,
          email: res.email,
          appRole: res.appRole,
          roleName: res.roleName,
          branchId: branchObj?.id ?? branchId,
          permissions, // 🔹 store permissions in pos_user
        };

        await AsyncStorage.multiSet([
          ['pos_user', JSON.stringify(userPayload)],
          ['pos_branch', JSON.stringify(branchObj)],
        ]);

        // also cache user locally for offline login later
        try {
          await saveUsersToSQLite(
            [
              {
                id: res.id,
                name: res.name,
                email: res.email,
                appRole: res.appRole,
                roleName: res.roleName,
                pin: p, // we used this PIN
                isActive: true,
                permissions, // 🔹 cache permissions for offline
              },
            ],
            branchId,
          );
        } catch (cacheErr) {
          console.log('Cache single user (online login) err:', cacheErr);
        }

        navigation.reset({
          index: 0,
          routes: [
            {
              name: 'Category',
              params: {
                branchId: branchObj?.id ?? null,
                branchName: branchObj?.name ?? '',
                userName: res.name,
              },
            },
          ],
        });
      } catch (err: any) {
        console.log('LOGIN PIN ERR', err);
        setPin('');

        // handle offline / session errors nicely if they ever bubble here
        const msg = String(err?.message || '');
        if (msg.includes('OFFLINE_MODE')) {
          Alert.alert(
            'Offline',
            'You appear to be offline. Please connect to the internet for online login, or use offline PIN login with cached users.',
          );
        } else {
          Alert.alert(
            'Login failed',
            'Invalid PIN or this user is not assigned to this branch.',
          );
        }
      } finally {
        setLoading(false);
      }
    },
    [branchId, branchName, navigation],
  );

  const loginWithPinOffline = useCallback(
    async (p: string) => {
      if (!branchId) {
        Alert.alert(
          'Device not activated',
          'This device is not linked to a branch. Please activate the device first.',
        );
        setPin('');
        return;
      }

      try {
        setLoading(true);
        console.log('🔐 PIN login (OFFLINE) with branchId:', branchId);

        const user = await findLocalUserByPin(branchId, p);
        if (!user) {
          setPin('');
          Alert.alert(
            'Offline login failed',
            'No offline user found for this PIN. Please sync users while online.',
          );
          return;
        }

        const branchRaw = await AsyncStorage.getItem('pos_branch');
        const branchObj = branchRaw ? JSON.parse(branchRaw) : null;

        // 🔹 include permissions from SQLite cache (if any)
        await AsyncStorage.setItem(
          'pos_user',
          JSON.stringify({
            id: user.id,
            name: user.name,
            email: user.email,
            appRole: user.appRole,
            roleName: user.roleName,
            branchId: user.branchId ?? branchId,
            permissions: user.permissions ?? [],
          } as LocalUser),
        );

        navigation.reset({
          index: 0,
          routes: [
            {
              name: 'Category',
              params: {
                branchId: branchObj?.id ?? branchId,
                branchName: branchObj?.name ?? branchName ?? '',
                userName: user.name,
              },
            },
          ],
        });
        setPin('');
      } catch (err) {
        console.log('OFFLINE LOGIN ERR', err);
        setPin('');
        Alert.alert(
          'Offline login failed',
          'Unable to login offline. Please try again or use online login.',
        );
      } finally {
        setLoading(false);
      }
    },
    [branchId, branchName, navigation],
  );

  const loginWithPin = useCallback(
    async (p: string) => {
      if (online) {
        await loginWithPinOnline(p);
      } else {
        await loginWithPinOffline(p);
      }
    },
    [online, loginWithPinOnline, loginWithPinOffline],
  );

  useEffect(() => {
    if (pin.length === PIN_LENGTH && !loading) {
      loginWithPin(pin);
    }
  }, [pin, loading, loginWithPin]);

  const onSyncUsers = async () => {
    if (!branchId) {
      Alert.alert(
        'Device not activated',
        'Cannot sync users because this device is not linked to any branch.',
      );
      return;
    }

    if (!online) {
      Alert.alert(
        'Offline',
        'You are offline. Connect to the internet to sync users.',
      );
      return;
    }

    try {
      setLoading(true);
      console.log('🔄 Sync users for branchId:', branchId);

      // Expecting backend to return: either an array of users or { users: [...] }
      const res: any = await post('/auth/sync-users', { branchId });
      const list: any[] = Array.isArray(res) ? res : res?.users ?? [];

      if (!Array.isArray(list) || list.length === 0) {
        Alert.alert('Sync finished', 'No users returned from server.');
      } else {
        // 🔹 list[i].permissions will be saved if backend sends it
        await saveUsersToSQLite(list, branchId);
        Alert.alert('Sync finished', `Synced ${list.length} users.`);
      }
    } catch (e: any) {
      console.log('SYNC USERS ERR', e);
      const msg = String(e?.message || '');

      if (msg.includes('SESSION_EXPIRED')) {
        // online session is dead – clear tokens and ask for re-login
        await clearAllTokens();
        Alert.alert(
          'Session expired',
          'Online session has expired. Please login again with PIN while online. You can still use offline PIN with cached users.',
        );
      } else if (msg.includes('OFFLINE_MODE')) {
        Alert.alert(
          'Offline',
          'You appear to be offline. Connect to the internet to sync users.',
        );
      } else {
        Alert.alert(
          'Sync failed',
          'Unable to sync users. Please try again.',
        );
      }
    } finally {
      setLoading(false);
    }
  };

  const renderDots = () => (
    <View style={styles.dotsRow}>
      {Array.from({ length: PIN_LENGTH }).map((_, i) => (
        <View
          key={i}
          style={[
            styles.dot,
            i < pin.length ? styles.dotFilled : styles.dotEmpty,
          ]}
        />
      ))}
    </View>
  );

  const keypadDigits = [
    ['1', '2', '3'],
    ['4', '5', '6'],
    ['7', '8', '9'],
    ['0', 'C'],
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
                  style={({ pressed }) => [
                    styles.key,
                    pressed && styles.keyPressed,
                  ]}
                  disabled={loading}
                >
                  <Text style={styles.keyText}>{d}</Text>
                </Pressable>
              ))}
            </View>
          ))}
        </View>

        <Pressable
          style={({ pressed }) => [
            styles.syncButton,
            pressed && styles.syncButtonPressed,
          ]}
          onPress={onSyncUsers}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator />
          ) : (
            <Text style={styles.syncText}>Sync Users</Text>
          )}
        </Pressable>

        <View style={styles.footer}>
          <Text style={styles.footerText}>
            Device: {deviceRef ? deviceRef : '#N/A'}
          </Text>
          <Text style={styles.footerText}>
            {branchName
              ? `Branch: ${branchName}`
              : 'Branch: Not linked (activate device)'}
          </Text>
          <Text style={styles.footerText}>
            Status: {online ? 'Online' : 'Offline (offline PIN uses cached users)'}
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#020617',
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    width: '80%',
    maxWidth: 600,
    backgroundColor: '#f9fafb',
    borderRadius: 24,
    paddingVertical: 40,
    paddingHorizontal: 32,
    alignItems: 'center',
  },
  logo: {
    fontSize: 26,
    fontWeight: '700',
    letterSpacing: 2,
    color: '#111827',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 16,
    color: '#4b5563',
    marginBottom: 24,
  },
  dotsRow: {
    flexDirection: 'row',
    marginBottom: 32,
  },
  dot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    marginHorizontal: 6,
  },
  dotEmpty: {
    borderWidth: 1,
    borderColor: '#cbd5f5',
    backgroundColor: 'transparent',
  },
  dotFilled: {
    backgroundColor: '#000000',
  },
  keypad: {
    width: '100%',
    marginBottom: 24,
  },
  keypadRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  key: {
    flex: 1,
    marginHorizontal: 6,
    paddingVertical: 18,
    borderRadius: 16,
    backgroundColor: '#e5e7eb',
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyPressed: {
    backgroundColor: '#d1d5db',
  },
  keyText: {
    fontSize: 22,
    fontWeight: '600',
    color: '#111827',
  },
  syncButton: {
    marginTop: 4,
    width: '80%',
    paddingVertical: 14,
    borderRadius: 16,
    backgroundColor: '#111827',
    alignItems: 'center',
    justifyContent: 'center',
  },
  syncButtonPressed: {
    opacity: 0.9,
  },
  syncText: {
    color: '#f9fafb',
    fontSize: 16,
    fontWeight: '600',
  },
  footer: {
    marginTop: 24,
    width: '100%',
  },
  footerText: {
    fontSize: 12,
    color: '#6b7280',
  },
});
