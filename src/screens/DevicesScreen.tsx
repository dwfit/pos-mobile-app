// src/screens/DevicesScreen.tsx
import React, { useEffect, useState } from "react";
import {
  SafeAreaView,
  View,
  Text,
  Pressable,
  StyleSheet,
  FlatList,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { MaterialIcons } from "@expo/vector-icons";

// ✅ Modern dialog
import ModernDialog from "../components/ModernDialog";

const STORAGE_KEY = "pos_devices";

const DEVICE_TYPES = [
  "Printer",
  "KDS",
  "Display",
  "Notifier",
  "Payment Terminal",
  "Sub Cashier",
  "Waiter",
];

type StoredDevice = {
  id: string;
  kind: string;
  model: string | null;
  typeLabel: string | null;
  name: string;
  ip: string;
  enabledOrderTypes: string[];
};

type Props = {
  navigation: any;
  online: boolean;
};

export default function DevicesScreen({ navigation }: Props) {
  const [menuVisible, setMenuVisible] = useState(false);
  const [devices, setDevices] = useState<StoredDevice[]>([]);
  const [loading, setLoading] = useState(false);

  // ✅ delete confirm dialog
  const [deleteDialog, setDeleteDialog] = useState<{
    visible: boolean;
    device?: StoredDevice;
  }>({
    visible: false,
  });

  // ==== LOAD DEVICES ======================================
  useEffect(() => {
    loadDevices();
  }, []);

  async function loadDevices() {
    try {
      setLoading(true);
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      const list: StoredDevice[] = raw ? JSON.parse(raw) : [];
      setDevices(Array.isArray(list) ? list : []);
    } catch (e) {
      console.log("loadDevices error", e);
    } finally {
      setLoading(false);
    }
  }

  // ==== ADD NEW DEVICE ====================================
  function handleSelectType(label: string) {
    setMenuVisible(false);

    if (label === "Printer") {
      navigation.navigate("DeviceInfo", {
        mode: "create",
        deviceType: "Printer",
      });
      return;
    }

    console.log("Selected device type:", label);
  }

  // ==== EDIT DEVICE =======================================
  function handleEditDevice(device: StoredDevice) {
    navigation.navigate("DeviceInfo", {
      mode: "edit",
      deviceType: device.kind,
      deviceId: device.id,
    });
  }

  // ==== DELETE DEVICE (MODERN) ============================
  function askDeleteDevice(device: StoredDevice) {
    setDeleteDialog({ visible: true, device });
  }

  async function confirmDeleteDevice() {
    const device = deleteDialog.device;
    setDeleteDialog({ visible: false });

    if (!device) return;

    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      const list: StoredDevice[] = raw ? JSON.parse(raw) : [];
      const next = list.filter((d) => d.id !== device.id);
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      setDevices(next);
    } catch (e) {
      console.log("deleteDevice error", e);
    }
  }

  // ==== RENDER ROW ========================================
  function renderDeviceRow({ item }: { item: StoredDevice }) {
    const title = item.name || item.model || item.kind || "Device";
    const subtitle = [item.model, item.typeLabel, item.ip]
      .filter(Boolean)
      .join(" • ");

    return (
      <Pressable
        style={styles.deviceRow}
        onPress={() => handleEditDevice(item)}
      >
        <View>
          <Text style={styles.deviceTitle}>{title}</Text>
          {!!subtitle && (
            <Text style={styles.deviceSubtitle}>{subtitle}</Text>
          )}
        </View>

        <Pressable
          onPress={() => askDeleteDevice(item)}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <MaterialIcons name="delete-outline" size={22} color="#ef4444" />
        </Pressable>
      </Pressable>
    );
  }

  // ==== MAIN ==============================================
  return (
    <SafeAreaView style={styles.overlay}>
      <View style={styles.card}>
        {/* Header */}
        <View style={styles.header}>
          <Pressable onPress={() => navigation.goBack()}>
            <Text style={styles.headerLink}>Close</Text>
          </Pressable>

          <Text style={styles.headerTitle}>Devices</Text>

          <View style={styles.headerRight}>
            <Pressable onPress={loadDevices}>
              <MaterialIcons
                name="refresh"
                size={20}
                color="#9ca3af"
                style={{ marginRight: 12 }}
              />
            </Pressable>

            <Pressable onPress={() => setMenuVisible((v) => !v)}>
              <Text style={styles.plus}>＋</Text>
            </Pressable>
          </View>
        </View>

        {/* Body */}
        <View style={styles.body}>
          {loading ? (
            <Text style={styles.emptyText}>Loading devices…</Text>
          ) : devices.length === 0 ? (
            <View style={styles.emptyState}>
              <Text style={styles.emptyTitle}>No devices configured</Text>
              <Text style={styles.emptyText}>
                Tap ＋ and choose Printer to add a new device.
              </Text>
            </View>
          ) : (
            <FlatList
              data={devices}
              keyExtractor={(item) => item.id}
              renderItem={renderDeviceRow}
              ItemSeparatorComponent={() => (
                <View style={styles.separator} />
              )}
              contentContainerStyle={{ paddingVertical: 4 }}
            />
          )}
        </View>

        {/* + menu */}
        {menuVisible && (
          <View style={styles.menuCard}>
            {DEVICE_TYPES.map((label) => (
              <Pressable
                key={label}
                style={styles.menuItem}
                onPress={() => handleSelectType(label)}
              >
                <Text style={styles.menuItemText}>{label}</Text>
              </Pressable>
            ))}
          </View>
        )}
      </View>

      {/* ✅ Modern delete confirm */}
      <ModernDialog
        visible={deleteDialog.visible}
        tone="error"
        title="Delete device"
        message={`Remove "${deleteDialog.device?.name ||
          deleteDialog.device?.model ||
          deleteDialog.device?.kind
          }"?`}
        secondaryText="Cancel"
        onSecondary={() => setDeleteDialog({ visible: false })}
        primaryText="Delete"
        onPrimary={confirmDeleteDevice}
        onClose={() => setDeleteDialog({ visible: false })}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.25)",
    justifyContent: "center",
    alignItems: "center",
  },
  card: {
    width: "94%",
    height: "90%",
    backgroundColor: "#ffffff",
    borderRadius: 28,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowOffset: { width: 0, height: 8 },
    shadowRadius: 18,
    elevation: 10,
  },
  header: {
    paddingHorizontal: 16,
    paddingTop: 30,
    paddingBottom: 14,
    minHeight: 64,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#f3f4f6",
  },
  headerLink: { color: "#000000", fontSize: 16, fontWeight: "500" },
  headerTitle: { fontSize: 18, fontWeight: "600", color: "#111827" },
  headerRight: { flexDirection: "row", alignItems: "center" },
  plus: { fontSize: 24, color: "#111827", paddingHorizontal: 4 },
  body: {
    flex: 1,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#e5e7eb",
    backgroundColor: "#f9fafb",
    paddingHorizontal: 24,
    paddingTop: 4,
  },
  menuCard: {
    position: "absolute",
    top: 52,
    right: 24,
    backgroundColor: "#ffffff",
    borderRadius: 18,
    paddingVertical: 6,
    shadowColor: "#000",
    shadowOpacity: 0.22,
    shadowOffset: { width: 0, height: 6 },
    shadowRadius: 16,
    elevation: 12,
    minWidth: 240,
  },
  menuItem: { paddingHorizontal: 18, paddingVertical: 10 },
  menuItemText: { fontSize: 14, color: "#111827" },
  emptyState: { flex: 1, alignItems: "center", justifyContent: "center" },
  emptyTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: "#111827",
    marginBottom: 4,
  },
  emptyText: { fontSize: 13, color: "#6b7280", textAlign: "center" },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: "#e5e7eb" },
  deviceRow: {
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  deviceTitle: { fontSize: 15, fontWeight: "500", color: "#111827" },
  deviceSubtitle: { fontSize: 12, color: "#6b7280", marginTop: 2 },
});
