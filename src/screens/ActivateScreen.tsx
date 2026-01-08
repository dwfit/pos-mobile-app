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
import { syncMenu } from '../sync/menuSync';

/* ------------------------ Enterprise error mapping ------------------------ */
function friendlyActivationError(err: any) {
  const apiMessage = err?.response?.data?.message || err?.data?.message || null;
  if (apiMessage && typeof apiMessage === 'string' && apiMessage.trim()) {
    return apiMessage.trim();
  }

  const apiError = err?.response?.data?.error || err?.data?.error || '';
  const msg = String(err?.message || '');
  const raw = `${apiError} ${msg}`.toLowerCase();

  if (
    raw.includes('invalid_brand_code') ||
    raw.includes('invalid_code') ||
    raw.includes('invalid_code_or_brand_mismatch') ||
    raw.includes('brand_mismatch')
  ) {
    return 'Brand code or activation code is invalid. Please verify and try again.';
  }

  if (raw.includes('device_missing_branch')) {
    return 'This device is not assigned to a branch. Please contact the administrator.';
  }

  if (raw.includes('network') || raw.includes('fetch') || raw.includes('timeout')) {
    return 'Unable to reach the activation service. Please check your internet connection and try again.';
  }

  return 'Activation failed. Please try again.';
}

export default function ActivateScreen({ navigation }: any) {
  const [brandCode, setBrandCode] = useState('');
  const [activationCode, setActivationCode] = useState('');
  const [loading, setLoading] = useState(false);

  async function onActivate() {
    const brand = brandCode.trim().toUpperCase();
    const code = activationCode.trim();

    if (!brand) {
      Alert.alert('Activation required', 'Please enter the Brand Code.');
      return;
    }

    if (!/^\d{6}$/.test(code)) {
      Alert.alert('Activation required', 'Please enter the 6-digit activation code.');
      return;
    }

    try {
      setLoading(true);

      const payload = {
        brandCode: brand,
        code,
        platform: Platform.OS === 'android' ? 'android' : 'ios',
        appVersion: Constants?.expoConfig?.version || '0.1.0',
      };

      const r: any = await post('/devices/pos/activate', payload);
      

      // 🔐 Save device token
      if (r?.token) {
        await setToken(r.token);
      }

      // 💾 Save device info (now includes brand + branch)
      if (r?.device) {
        const deviceInfoToStore = {
          ...r.device,

          // backend will now send these (after you update devices.ts)
          brand: r?.brand ?? null,   // { id, code, name }
          branch: r?.branch ?? null, // { id, name }

          // easy fields for UI
          brandId: r?.brand?.id ?? null,
          brandCode: r?.brand?.code ?? brand ?? null,
          brandName: r?.brand?.name ?? null,

          branchId: r?.device?.branchId ?? r?.branch?.id ?? null,
          branchName: r?.branch?.name ?? null,

          updatedAt: r?.updatedAt ?? null,
        };

        await AsyncStorage.setItem('deviceInfo', JSON.stringify(deviceInfoToStore));
      }

      // ✅ Mark activated
      await AsyncStorage.setItem('deviceActivated', '1');

      // 🔄 Initial menu sync
      try {
        await syncMenu();
      } catch (err) {
        console.log('Initial menu sync failed:', err);
      }

      Alert.alert('Device activated', 'Activation completed successfully.', [
        { text: 'OK', onPress: () => navigation.replace('Home') },
      ]);
    } catch (e: any) {
      console.log('ACTIVATE ERR', e);
      Alert.alert('Activation failed', friendlyActivationError(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={styles.root}>
      <View style={styles.infoPane}>
        <Text style={styles.appTitle}>DWF POS</Text>
        <Text style={styles.appSubtitle}>Device activation</Text>

        <View style={styles.infoBox}>
          <Text style={styles.infoText}>• Enter Brand Code .</Text>
          <Text style={styles.infoText}>
            • Enter the 6-digit activation code provided by Admin.
          </Text>
          <Text style={styles.infoText}>• Brand Code and activation code must match.</Text>
          <Text style={[styles.infoText, { marginTop: 8, opacity: 0.8 }]}>
            • Internet required only for activation & syncing.
          </Text>
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Activate device</Text>
        <Text style={styles.cardSubtitle}>Enter Brand Code and activation code.</Text>

        <TextInput
          value={brandCode}
          onChangeText={setBrandCode}
          placeholder="Brand Code"
          placeholderTextColor="#64748b"
          autoCapitalize="characters"
          style={styles.input}
        />

        <TextInput
          value={activationCode}
          onChangeText={(v) => setActivationCode(v.replace(/[^\d]/g, ''))}
          placeholder="Activation Code"
          placeholderTextColor="#64748b"
          keyboardType="number-pad"
          maxLength={6}
          style={styles.input}
        />

        <Pressable
          disabled={loading || !brandCode.trim() || activationCode.trim().length !== 6}
          onPress={onActivate}
          style={({ pressed }) => [
            styles.activateButton,
            (loading || pressed) && styles.activateButtonPressed,
          ]}
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
