// src/screens/ClockInScreen.tsx
import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  Pressable,
  SafeAreaView,
  StyleSheet,
  TextInput,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from "react-native";

import {
  createLocalShift,
  closeLocalShift,
  createLocalTill,
  closeLocalTill,
} from "../database/clockLocal";

import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import { post } from "../lib/api";

type Props = {
  navigation: any;
  route: { params?: { branchName?: string; userName?: string } };
};

export default function ClockInScreen({ navigation, route }: Props) {
  const branchName = route?.params?.branchName || "";
  const userName = route?.params?.userName || "";

  const [loading, setLoading] = useState(false);
  const [openingAmount, setOpeningAmount] = useState("");
  const [clockedIn, setClockedIn] = useState(false);
  const [tillOpened, setTillOpened] = useState(false);

  const [branchId, setBranchId] = useState<string | null>(null);
  const [brandId, setBrandId] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);

  // Restore flags
  useEffect(() => {
    (async () => {
      const c = await AsyncStorage.getItem("pos_clocked_in");
      const t = await AsyncStorage.getItem("pos_till_opened");
      setClockedIn(c === "1");
      setTillOpened(t === "1");
    })();
  }, []);

  // Load device + brand + branch
  useEffect(() => {
    (async () => {
      try {
        const dev = await AsyncStorage.getItem("deviceInfo");
        const br = await AsyncStorage.getItem("pos_brand");
        const bch = await AsyncStorage.getItem("pos_branch");

        if (dev) {
          const d = JSON.parse(dev);
          if (d?.id) setDeviceId(String(d.id));
          if (!branchId && d?.branchId) setBranchId(String(d.branchId));
          if (!brandId && d?.brandId) setBrandId(String(d.brandId));
        }

        if (bch) {
          const bb = JSON.parse(bch);
          if (bb?.id) setBranchId(String(bb.id));
        }

        if (br) {
          const rr = JSON.parse(br);
          if (rr?.id) setBrandId(String(rr.id));
        }
      } catch {}
    })();
  }, [branchId, brandId]);

  /* ================= CLOCK IN / OUT ================= */

  async function handleToggleClock() {
    if (loading) return;

    const net = await NetInfo.fetch();
    const isOnline = !!net.isConnected && !!net.isInternetReachable;

    // ========== CLOCK IN ==========
    if (!clockedIn) {
      if (!branchId) {
        Alert.alert("Missing branch", "Device must be activated again.");
        return;
      }

      try {
        setLoading(true);

        // 1️⃣ ALWAYS create local shift first
        const localShiftId = await createLocalShift({
          userName,
          branchId,
          brandId,
          deviceId,
        });

        await AsyncStorage.setItem("pos_shift_id", localShiftId);
        await AsyncStorage.setItem("pos_clocked_in", "1");
        setClockedIn(true);

        // 2️⃣ Try sync (optional if online)
        if (isOnline) {
          try {
            const res: any = await post("/pos/clock-in", {
              branchId,
              brandId,
              deviceId,
              clientId: localShiftId,
            });

            // Mark synced in DB
            await closeLocalShift(localShiftId, { syncOnly: true, serverId: res?.shiftId });
          } catch {}
        }
      } catch (e: any) {
        Alert.alert("Clock In failed", e?.message || "Try again.");
      } finally {
        setLoading(false);
      }

      return;
    }

    // ========== CLOCK OUT ==========
    if (tillOpened) {
      Alert.alert("Close Till", "Close the till before clocking out.");
      return;
    }

    try {
      setLoading(true);

      const shiftId = await AsyncStorage.getItem("pos_shift_id");

      // local update always succeeds
      await closeLocalShift(shiftId || undefined);

      await AsyncStorage.multiRemove(["pos_clocked_in", "pos_shift_id"]);
      setClockedIn(false);

      if (isOnline) {
        try {
          await post("/pos/clock-out", { branchId, brandId, deviceId });
        } catch {}
      }
    } catch (e: any) {
      Alert.alert("Clock Out failed", e?.message || "Try again.");
    } finally {
      setLoading(false);
    }
  }

  /* ================= TILL ================= */

  async function handleToggleTill() {
    if (!clockedIn) {
      Alert.alert("Clock In required");
      return;
    }

    const net = await NetInfo.fetch();
    const isOnline = !!net.isConnected && !!net.isInternetReachable;

    // ====== OPEN TILL ======
    if (!tillOpened) {
      const amount = Number(openingAmount.trim());
      if (!amount) return Alert.alert("Enter opening cash");

      try {
        setLoading(true);

        const localTillId = await createLocalTill({
          branchId,
          brandId,
          deviceId,
          openingCash: amount,
        });

        await AsyncStorage.setItem("pos_till_session_id", localTillId);
        await AsyncStorage.setItem("pos_till_opened", "1");
        setTillOpened(true);

        if (isOnline) {
          try {
            await post("/pos/till/open", {
              openingCash: amount,
              branchId,
              brandId,
              deviceId,
              clientId: localTillId,
            });
          } catch {}
        }
      } finally {
        setLoading(false);
      }

      return;
    }

    // ====== CLOSE TILL ======
    try {
      setLoading(true);

      const t = await AsyncStorage.getItem("pos_till_session_id");
      await closeLocalTill(t || undefined);

      await AsyncStorage.multiSet([
        ["pos_till_opened", "0"],
        ["pos_till_session_id", ""],
      ]);
      setTillOpened(false);
      setOpeningAmount("");

      if (isOnline) {
        try {
          await post("/pos/till/close", { branchId, brandId, deviceId });
        } catch {}
      }
    } finally {
      setLoading(false);
    }
  }

  /* ================= CONTINUE ================= */

  function handleAccessRegister() {
    if (!clockedIn || !tillOpened) return;
    navigation.replace("Category", { branchName, userName });
  }

  function handleExit() {
    AsyncStorage.multiRemove([
      "pos_clocked_in",
      "pos_till_opened",
      "pos_shift_id",
      "pos_till_session_id",
    ]).finally(() => navigation.replace("Home"));
  }

  /* ------------- RENDER ------------- */

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.inner}
      >
        <Text style={styles.logo}>DWF POS</Text>

        {!!branchName && (
          <Text style={styles.branchText}>Branch: {branchName}</Text>
        )}
        {!!userName && (
          <Text style={styles.branchText}>User: {userName}</Text>
        )}

        <Text style={styles.welcome}>Welcome, Cashier!</Text>
        <Text style={styles.subText}>
          {clockedIn ? "Clocked in" : "Not clocked in"}
        </Text>

        {/* Clock In / Clock Out */}
        <Pressable
          style={[
            styles.button,
            !clockedIn && styles.buttonSuccess,
            clockedIn && styles.buttonWarning,
            loading && styles.buttonDisabled,
          ]}
          onPress={handleToggleClock}
          disabled={loading}
        >
          <Text style={styles.buttonText}>
            {clockedIn ? "Clock Out" : "Clock In"}
          </Text>
        </Pressable>

        {/* Open / Close Till */}
        <View style={styles.tillBlock}>
          {clockedIn && !tillOpened && (
            <>
              <Text style={styles.label}>Opening Cash</Text>

              <TextInput
                style={styles.input}
                keyboardType="numeric"
                value={openingAmount}
                onChangeText={setOpeningAmount}
                placeholder="0.00"
              />
            </>
          )}

          <Pressable
            style={[
              styles.button,
              tillOpened && styles.buttonDanger,
              clockedIn && !tillOpened && styles.buttonSuccess,
              (!clockedIn || loading) && styles.buttonDisabled,
            ]}
            onPress={handleToggleTill}
            disabled={!clockedIn || loading}
          >
            <Text style={styles.buttonText}>
              {tillOpened ? "Till Close" : "Open Till"}
            </Text>
          </Pressable>
        </View>

        {/* Access Register */}
        <Pressable
          style={[
            styles.button,
            (!clockedIn || !tillOpened) && styles.buttonDisabled,
          ]}
          onPress={handleAccessRegister}
          disabled={!clockedIn || !tillOpened}
        >
          <Text style={styles.buttonText}>Access Register</Text>
        </Pressable>

        {/* Exit */}
        <Pressable
          style={[styles.button, styles.exitButton]}
          onPress={handleExit}
        >
          <Text style={styles.exitText}>Exit</Text>
        </Pressable>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f3f4f6" },
  inner: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 40,
  },
  logo: { fontSize: 32, fontWeight: "700", marginBottom: 24 },
  branchText: { fontSize: 14, color: "#4b5563" },
  welcome: { fontSize: 20, fontWeight: "600", marginTop: 12, marginBottom: 4 },
  subText: { fontSize: 14, color: "#6b7280", marginBottom: 24 },
  button: {
    width: 260,
    paddingVertical: 14,
    borderRadius: 8,
    backgroundColor: "#111827",
    alignItems: "center",
    marginBottom: 12,
  },
  buttonDisabled: { backgroundColor: "#9ca3af" },
  buttonText: { color: "#ffffff", fontSize: 16, fontWeight: "600" },
  tillBlock: { width: 260, marginVertical: 16 },
  label: { fontSize: 13, color: "#374151", marginBottom: 4 },
  input: {
    backgroundColor: "#ffffff",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: "#d1d5db",
    marginBottom: 8,
  },
  exitButton: {
    backgroundColor: "#FF0000",
    borderWidth: 1,
    borderColor: "#d1d5db",
    marginTop: 8,
  },
  exitText: { color: "#ffff", fontSize: 16, fontWeight: "600" },
  buttonSuccess: { backgroundColor: "#059669" },
  buttonDanger: { backgroundColor: "#DC2626" },
  buttonWarning: { backgroundColor: "#DC2626" },
});
