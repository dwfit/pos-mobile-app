// src/screens/ClockInScreen.tsx
import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  Pressable,
  SafeAreaView,
  StyleSheet,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  Modal,
} from "react-native";

import {
  createLocalShift,
  closeLocalShift,
  createLocalTill,
  closeLocalTill,
  getLocalTillSession,
} from "../database/clockLocal";

import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import { post } from "../lib/api";

// ✅ NEW: report + print
import { generateTillCloseReport } from "../reports/tillCloseReport";

// ✅ NEW: printing
import {
  printTillCloseReport,
  type TillCloseReport,
} from "../printing/printerService";

// ✅ Modern popup
import ModernDialog from "../components/ModernDialog";

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

  // ===== close-till flow =====
  const [confirmCloseVisible, setConfirmCloseVisible] = useState(false);
  const [closeAmountVisible, setCloseAmountVisible] = useState(false);
  const [printPromptVisible, setPrintPromptVisible] = useState(false);
  const [tillCloseAmount, setTillCloseAmount] = useState("");

  // ✅ hold report for printing
  const [lastReport, setLastReport] = useState<TillCloseReport | null>(null);

  // ✅ Modern dialog state
  const [dialog, setDialog] = useState({
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
    setDialog({ visible: true, tone, title, message });
  }

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

    // CLOCK IN
    if (!clockedIn) {
      if (!branchId) {
        showDialog("error", "Missing branch", "Device must be activated again.");
        return;
      }

      try {
        setLoading(true);

        const localShiftId = await createLocalShift({
          userId: userName, // keep your current idea
          branchId,
          brandId,
          deviceId,
        });

        await AsyncStorage.setItem("pos_shift_id", localShiftId);
        await AsyncStorage.setItem("pos_clocked_in", "1");
        setClockedIn(true);

        if (isOnline) {
          try {
            await post("/pos/clock-in", {
              branchId,
              brandId,
              deviceId,
              clientId: localShiftId,
            });
          } catch (e) {
            console.log("❌ clock-in sync failed", e);
          }
        }
      } catch (e: any) {
        showDialog("error", "Clock In failed", e?.message || "Try again.");
      } finally {
        setLoading(false);
      }

      return;
    }

    // CLOCK OUT
    if (tillOpened) {
      showDialog("info", "Close Till", "Close the till before clocking out.");
      return;
    }

    try {
      setLoading(true);

      const shiftId = await AsyncStorage.getItem("pos_shift_id");
      await closeLocalShift(shiftId || undefined);

      await AsyncStorage.multiRemove(["pos_clocked_in", "pos_shift_id"]);
      setClockedIn(false);

      if (isOnline) {
        try {
          await post("/pos/clock-out", { branchId, brandId, deviceId });
        } catch (e) {
          console.log("❌ clock-out sync failed", e);
        }
      }
    } catch (e: any) {
      showDialog("error", "Clock Out failed", e?.message || "Try again.");
    } finally {
      setLoading(false);
    }
  }

  /* ================= TILL ================= */

  async function actuallyCloseTill(closingCash: number) {
    const net = await NetInfo.fetch();
    const isOnline = !!net.isConnected && !!net.isInternetReachable;

    try {
      setLoading(true);

      const localTillId = await AsyncStorage.getItem("pos_till_session_id");
      if (!localTillId) throw new Error("Missing till session id");

      // ✅ 1) save till close in local DB
      await closeLocalTill(localTillId, closingCash);

      // ✅ 2) load session for report
      const session = await getLocalTillSession(localTillId);

      // ✅ 3) generate report
      const openedAt = String(session.openedAt);
      const closedAt = String(session.closedAt || new Date().toISOString());

      const report = await generateTillCloseReport({
        tillSessionId: localTillId,
        branchId,
        brandId,
        deviceId,
        branchName,
        userName,
        openingCash: Number(session.openingCash || 0),
        closingCash: Number(session.closingCash || closingCash),
        openedAt,
        closedAt,
      });

      setLastReport(report);

      // ✅ 4) clear flags
      await AsyncStorage.multiSet([
        ["pos_till_opened", "0"],
        ["pos_till_session_id", ""],
      ]);

      setTillOpened(false);
      setOpeningAmount("");
      setTillCloseAmount("");

      // ✅ 5) sync to server
      if (isOnline) {
        try {
          await post("/pos/till/close", {
            branchId,
            brandId,
            deviceId,
            clientId: localTillId,
            closingCash,
            report,
          });
        } catch (e) {
          console.log("❌ till close sync failed", e);
        }
      }

      // ✅ 6) show print prompt
      setPrintPromptVisible(true);
    } catch (e: any) {
      showDialog("error", "Till close failed", e?.message || "Try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleToggleTill() {
    if (!clockedIn) {
      showDialog("info", "Clock In required", "Please clock in first.");
      return;
    }

    // OPEN TILL
    if (!tillOpened) {
      const amount = Number(openingAmount.trim());
      if (!amount) {
        showDialog("info", "Opening cash", "Enter opening cash.");
        return;
      }

      const net = await NetInfo.fetch();
      const isOnline = !!net.isConnected && !!net.isInternetReachable;

      try {
        setLoading(true);

        const shiftLocalId = await AsyncStorage.getItem("pos_shift_id");

        const localTillId = await createLocalTill({
          shiftLocalId: shiftLocalId || null,
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
          } catch (e) {
            console.log("❌ till open sync failed", e);
          }
        }
      } finally {
        setLoading(false);
      }

      return;
    }

    // CLOSE TILL - start confirmation flow
    setConfirmCloseVisible(true);
  }

  /* ================= CONTINUE / EXIT ================= */

  function handleAccessRegister() {
    if (!clockedIn || !tillOpened) return;
    navigation.replace("Category", { branchName, userName });
  }

  async function handleExit() {
    await AsyncStorage.multiRemove([
      "pos_user",
      "token",
      "accessToken",
      "refreshToken",
      "pos_permissions",
    ]);
  
    navigation.replace("Home");
  }
  
  

  async function handlePrintTillReport(shouldPrint: boolean) {
    setPrintPromptVisible(false);
    if (!shouldPrint) return;

    try {
      if (!lastReport) {
        showDialog("info", "No report", "Till report was not generated.");
        return;
      }

      await printTillCloseReport(lastReport);
      showDialog("success", "Printed", "Till report sent to printer.");
    } catch (e: any) {
      showDialog("error", "Print failed", e?.message || "Try again");
    }
  }

  /* ================= KEYPAD HELPERS ================= */

  function handleKeypadPress(key: string) {
    if (key === "C") {
      setTillCloseAmount("");
      return;
    }
    setTillCloseAmount((prev) => (prev || "") + key);
  }

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
        {!!userName && <Text style={styles.branchText}>User: {userName}</Text>}

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

        {/* 1) Confirm Close Till */}
        <Modal
          visible={confirmCloseVisible}
          transparent
          animationType="fade"
          onRequestClose={() => setConfirmCloseVisible(false)}
        >
          <View style={styles.modalOverlay}>
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>Close Till</Text>
              <Text style={styles.modalMessage}>
                Are you sure you want to close till?
              </Text>

              <View style={styles.modalButtonsRow}>
                <Pressable
                  style={[styles.modalBtn, styles.modalBtnSecondary]}
                  onPress={() => setConfirmCloseVisible(false)}
                >
                  <Text style={styles.modalBtnTextSecondary}>No</Text>
                </Pressable>

                <Pressable
                  style={[styles.modalBtn, styles.modalBtnPrimary]}
                  onPress={() => {
                    setConfirmCloseVisible(false);
                    setTillCloseAmount("");
                    setCloseAmountVisible(true);
                  }}
                >
                  <Text style={styles.modalBtnTextPrimary}>Yes</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>

        {/* 2) Enter Till Amount */}
        <Modal
          visible={closeAmountVisible}
          transparent
          animationType="fade"
          onRequestClose={() => setCloseAmountVisible(false)}
        >
          <View style={styles.modalOverlay}>
            <View style={styles.amountCard}>
              <Text style={styles.modalTitle}>Enter Till Amount</Text>

              <View style={styles.amountDisplay}>
                <Text style={styles.amountText}>
                  {tillCloseAmount || "0.00"}
                </Text>
              </View>

              <View style={styles.keypadRow}>
                {["1", "2", "3"].map((k) => (
                  <Pressable
                    key={k}
                    style={styles.keypadKey}
                    onPress={() => handleKeypadPress(k)}
                  >
                    <Text style={styles.keypadKeyText}>{k}</Text>
                  </Pressable>
                ))}
              </View>
              <View style={styles.keypadRow}>
                {["4", "5", "6"].map((k) => (
                  <Pressable
                    key={k}
                    style={styles.keypadKey}
                    onPress={() => handleKeypadPress(k)}
                  >
                    <Text style={styles.keypadKeyText}>{k}</Text>
                  </Pressable>
                ))}
              </View>
              <View style={styles.keypadRow}>
                {["7", "8", "9"].map((k) => (
                  <Pressable
                    key={k}
                    style={styles.keypadKey}
                    onPress={() => handleKeypadPress(k)}
                  >
                    <Text style={styles.keypadKeyText}>{k}</Text>
                  </Pressable>
                ))}
              </View>
              <View style={styles.keypadRow}>
                {["C", "0"].map((k) => (
                  <Pressable
                    key={k}
                    style={styles.keypadKey}
                    onPress={() => handleKeypadPress(k)}
                  >
                    <Text style={styles.keypadKeyText}>{k}</Text>
                  </Pressable>
                ))}
              </View>

              <Pressable
                style={styles.doneButton}
                onPress={() => {
                  if (!tillCloseAmount) {
                    showDialog("info", "Till amount", "Enter till amount.");
                    return;
                  }
                  const val = Number(tillCloseAmount);
                  if (Number.isNaN(val)) {
                    showDialog("error", "Invalid amount", "Please enter a valid number.");
                    return;
                  }
                  setCloseAmountVisible(false);
                  actuallyCloseTill(val);
                }}
              >
                <Text style={styles.doneButtonText}>Done</Text>
              </Pressable>
            </View>
          </View>
        </Modal>

        {/* 3) Print prompt */}
        <Modal
          visible={printPromptVisible}
          transparent
          animationType="fade"
          onRequestClose={() => setPrintPromptVisible(false)}
        >
          <View style={styles.modalOverlay}>
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>Till Closed Successfully!</Text>
              <Text style={styles.modalMessage}>
                Till closed successfully! Would you like to print the till report?
              </Text>

              <View style={styles.modalButtonsRow}>
                <Pressable
                  style={[styles.modalBtn, styles.modalBtnPrimary]}
                  onPress={() => handlePrintTillReport(true)}
                >
                  <Text style={styles.modalBtnTextPrimary}>Yes</Text>
                </Pressable>

                <Pressable
                  style={[styles.modalBtn, styles.modalBtnSecondary]}
                  onPress={() => handlePrintTillReport(false)}
                >
                  <Text style={styles.modalBtnTextSecondary}>No</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>

        {/* ✅ Modern dialog (replaces Alert.alert look) */}
        <ModernDialog
          visible={dialog.visible}
          tone={dialog.tone}
          title={dialog.title}
          message={dialog.message}
          primaryText="Done"
          onPrimary={() => setDialog((p) => ({ ...p, visible: false }))}
          onClose={() => setDialog((p) => ({ ...p, visible: false }))}
        />
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

  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.35)",
    justifyContent: "center",
    alignItems: "center",
  },
  modalCard: {
    width: 320,
    backgroundColor: "#ffffff",
    borderRadius: 16,
    paddingHorizontal: 24,
    paddingVertical: 20,
    alignItems: "center",
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: "600",
    marginBottom: 8,
    textAlign: "center",
  },
  modalMessage: {
    fontSize: 14,
    color: "#4b5563",
    textAlign: "center",
    marginBottom: 20,
  },
  modalButtonsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    width: "100%",
  },
  modalBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: "center",
    marginHorizontal: 4,
  },
  modalBtnPrimary: { backgroundColor: "#000000" },
  modalBtnSecondary: { backgroundColor: "#e5e7eb" },
  modalBtnTextPrimary: { color: "#ffffff", fontWeight: "600", fontSize: 15 },
  modalBtnTextSecondary: { color: "#111827", fontWeight: "600", fontSize: 15 },

  amountCard: {
    width: 320,
    backgroundColor: "#ffffff",
    borderRadius: 16,
    paddingHorizontal: 24,
    paddingVertical: 20,
    alignItems: "center",
  },
  amountDisplay: {
    width: "100%",
    paddingVertical: 12,
    marginBottom: 12,
    borderRadius: 8,
    backgroundColor: "#f3f4f6",
    alignItems: "center",
  },
  amountText: { fontSize: 20, fontWeight: "600" },
  keypadRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    width: "100%",
    marginBottom: 6,
  },
  keypadKey: {
    flex: 1,
    marginHorizontal: 4,
    paddingVertical: 12,
    borderRadius: 8,
    backgroundColor: "#e5e7eb",
    alignItems: "center",
  },
  keypadKeyText: { fontSize: 18, fontWeight: "600", color: "#111827" },
  doneButton: {
    marginTop: 16,
    paddingVertical: 10,
    paddingHorizontal: 24,
    alignItems: "center",
  },
  doneButtonText: { fontSize: 18, fontWeight: "600", color: "#000" },
});
