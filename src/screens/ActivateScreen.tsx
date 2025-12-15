// src/screens/ActivateScreen.tsx
import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  Alert,
  Platform,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { post } from '../lib/api';
import { setToken } from '../lib/auth';

// initial menu sync (pulls data into SQLite)
import { syncMenu } from '../sync/menuSync';

export default function ActivateScreen({ navigation }: any) {
  const [deviceId, setDeviceId] = useState('');
  const [key, setKey] = useState('');
  const [loading, setLoading] = useState(false);

  async function onActivate() {
    // normalize: trim + uppercase (common for activation codes)
    const trimmedKey = key.trim().toUpperCase();

    if (!trimmedKey) {
      Alert.alert('Activation', 'Please enter activation key.');
      return;
    }

    try {
      setLoading(true);

      const payload: any = {
        // send BOTH so backend can choose what it wants
        key: trimmedKey,
        code: trimmedKey,
        platform: Platform.OS === 'android' ? 'android' : 'ios',
        appVersion: Constants?.expoConfig?.version || '0.1.0',
      };

      const trimmedDeviceId = deviceId.trim();
      if (trimmedDeviceId) {
        payload.deviceId = trimmedDeviceId;
      }

      // Call backend
      const r: any = await post('/devices/pos/activate', payload);

      // Save auth token if you use it
      if (r.token) {
        await setToken(r.token);
      }

      // Save device info for later use (branch, device type, etc.)
      if (r.device) {
        await AsyncStorage.setItem('deviceInfo', JSON.stringify(r.device));
      }

      // Mark device as activated (one time)
      await AsyncStorage.setItem('deviceActivated', '1');

      // Initial menu sync (optional but recommended)
      try {
        await syncMenu();
      } catch (syncErr) {
        console.log('Initial menu sync after activation failed:', syncErr);
        // don't block activation for this
      }

      Alert.alert('Activated', 'Device is now active', [
        {
          text: 'OK',
          onPress: () => navigation.replace('Home'),
        },
      ]);
    } catch (e: any) {
      console.log('ACTIVATE ERR', e);
      const msg =
        (e && e.message) || 'Unable to activate device.';
      Alert.alert('Activation failed', msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={styles.root}>
      {/* LEFT info / branding */}
      <View style={styles.infoPane}>
        <Text style={styles.appTitle}>DWF POS</Text>
        <Text style={styles.appSubtitle}>Device activation</Text>

        <View style={styles.infoBox}>
          <Text style={styles.infoText}>
            • Ask your administrator for a 6-digit activation key.
          </Text>
          <Text style={styles.infoText}>
            • This links the tablet to a specific branch and device profile.
          </Text>
          <Text style={styles.infoText}>
            • After activation, you can log in using your cashier PIN.
          </Text>
          <Text style={[styles.infoText, { marginTop: 8, opacity: 0.8 }]}>
            • Internet is required only for activation & syncing. After
            that, POS works from local data (offline).
          </Text>
        </View>
      </View>

      {/* RIGHT activation card */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Activate device</Text>
        <Text style={styles.cardSubtitle}>
          Enter the activation key provided by Admin.
        </Text>

        <TextInput
          value={deviceId}
          onChangeText={setDeviceId}
          placeholder="Device ID (optional)"
          placeholderTextColor="#64748b"
          autoCapitalize="none"
          style={styles.input}
        />

        <TextInput
          value={key}
          onChangeText={setKey}
          placeholder="Activation Key"
          placeholderTextColor="#64748b"
          autoCapitalize="characters"
          style={styles.input}
        />

        <Pressable
          disabled={loading || !key.trim()}
          onPress={onActivate}
          style={({ pressed }) => {
            const highlight = loading || !key.trim() || pressed;
            return [
              styles.activateButton,
              highlight ? styles.activateButtonPressed : null,
            ];
          }}
        >
          {loading ? (
            <ActivityIndicator color="#052e16" />
          ) : (
            <Text style={styles.activateText}>Activate</Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#020617',
    flexDirection: 'row',
    paddingHorizontal: 32,
    paddingVertical: 24,
  },
  infoPane: {
    flex: 4,
    paddingRight: 24,
    justifyContent: 'center',
  },
  appTitle: {
    fontSize: 32,
    fontWeight: '800',
    letterSpacing: 2,
    color: '#e5e7eb',
    marginBottom: 4,
  },
  appSubtitle: {
    fontSize: 15,
    color: '#9ca3af',
    marginBottom: 24,
  },
  infoBox: {
    padding: 16,
    borderRadius: 20,
    backgroundColor: '#0b1120',
    borderWidth: 1,
    borderColor: '#1f2937',
  },
  infoText: {
    fontSize: 13,
    color: '#e5e7eb',
    marginBottom: 6,
  },
  card: {
    flex: 6,
    backgroundColor: '#020617',
    borderRadius: 24,
    paddingVertical: 32,
    paddingHorizontal: 32,
    borderWidth: 1,
    borderColor: '#1f2937',
    justifyContent: 'center',
  },
  cardTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#f9fafb',
  },
  cardSubtitle: {
    fontSize: 14,
    color: '#94a3b8',
    marginTop: 4,
    marginBottom: 24,
  },
  input: {
    backgroundColor: '#111827',
    color: '#f9fafb',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#1f2937',
  },
  activateButton: {
    marginTop: 8,
    backgroundColor: '#22c55e',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  activateButtonPressed: {
    opacity: 0.8,
  },
  activateText: {
    color: '#052e16',
    fontWeight: '700',
    fontSize: 16,
  },
});
