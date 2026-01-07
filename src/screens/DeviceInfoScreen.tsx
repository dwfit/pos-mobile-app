// src/screens/DeviceInfoScreen.tsx
import React, { useState, useEffect } from "react";
import {
  SafeAreaView,
  View,
  Text,
  Pressable,
  StyleSheet,
  TextInput,
  FlatList,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { MaterialIcons } from "@expo/vector-icons";

// 🔹 menu + db helpers (already used elsewhere in your app)
import { getLocalCategories } from "../database/menu";
import { getDb } from "../database/db";

const STORAGE_KEY = "pos_devices";

const PRINTER_MODELS = [
  "TM_T20",
  "TM_T20II",
  "TM_T20III",
  "TM_m30",
  "TM_m30II",
  "TM_P80",
  "TM_T88V",
  "TM_T20X",
  "TM_L100",
];

const PRINTER_TYPES = [
  "Cashier",
  "Kitchen",
  "Order info",
  "Kitchen Sticky Printer",
];

const ORDER_TYPE_OPTIONS = [
  { code: "DINE_IN", label: "Dine In" },
  { code: "TAKE_AWAY", label: "Take Away" },
  { code: "DELIVERY", label: "Delivery" },
  { code: "DRIVE_THRU", label: "Drive Thru" },
];

type DeviceInfoRouteParams = {
  mode: "create" | "edit";
  deviceType: string; // "Printer" etc.
  deviceId?: string;
};

type Props = {
  navigation: any;
  route: { params: DeviceInfoRouteParams };
};

type SubScreen =
  | "MAIN"
  | "MODEL"
  | "TYPE"
  | "ORDER_TYPES"
  | "CATEGORY_FILTER"
  | "PRODUCT_FILTER";

type StoredDevice = {
  id: string;
  kind: string; // "Printer"
  model: string | null;
  typeLabel: string | null;
  name: string;
  ip: string;
  enabledOrderTypes: string[]; // codes

  // filters stored as CSV of IDs
  categoryFilter?: string | null; // category ids
  productFilter?: string | null; // product ids
};

type LocalCategory = {
  id: string;
  name: string;
};

type LocalProduct = {
  id: string;
  name: string;
  categoryId: string | null;
};

export default function DeviceInfoScreen({ navigation, route }: Props) {
  const { mode, deviceType, deviceId } = route.params || {
    mode: "create",
    deviceType: "Printer",
  };

  const [subScreen, setSubScreen] = useState<SubScreen>("MAIN");

  const [model, setModel] = useState<string | null>(null);
  const [typeLabel, setTypeLabel] = useState<string | null>(null);
  const [name, setName] = useState<string>("");
  const [ip, setIp] = useState<string>("");

  const [enabledOrderTypes, setEnabledOrderTypes] = useState<string[]>([]);

  // 🔹 full menu data
  const [allCategories, setAllCategories] = useState<LocalCategory[]>([]);
  const [allProducts, setAllProducts] = useState<LocalProduct[]>([]);

  // 🔹 selected filters (IDs)
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<string[]>([]);
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([]);

  // ===== Load menu data (categories + products) =======================
  useEffect(() => {
    async function loadMenuData() {
      try {
        // categories from local menu helper
        const cats = await getLocalCategories();
        setAllCategories(
          (cats || []).map((c: any) => ({
            id: String(c.id),
            name: String(c.name),
          }))
        );

        // products directly from SQLite
        const db = await getDb();
        const rows = (await db.getAllAsync(
          "SELECT id, name, categoryId FROM products WHERE isActive = 1 ORDER BY name"
        )) as any[];

        setAllProducts(
          (rows || []).map((p: any) => ({
            id: String(p.id),
            name: String(p.name),
            categoryId: p.categoryId ? String(p.categoryId) : null,
          }))
        );
      } catch (e) {
        console.log("loadMenuData error", e);
      }
    }

    loadMenuData();
  }, []);

  // ===== Load existing device when editing ==========================
  useEffect(() => {
    async function loadForEdit() {
      if (mode !== "edit" || !deviceId) return;

      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        const list: StoredDevice[] = raw ? JSON.parse(raw) : [];
        const found = list.find((d) => d.id === deviceId);
        if (!found) return;

        setModel(found.model || null);
        setTypeLabel(found.typeLabel || null);
        setName(found.name || "");
        setIp(found.ip || "");
        setEnabledOrderTypes(found.enabledOrderTypes || []);

        // parse CSV -> arrays
        if (found.categoryFilter) {
          setSelectedCategoryIds(
            found.categoryFilter
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          );
        }
        if (found.productFilter) {
          setSelectedProductIds(
            found.productFilter
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          );
        }
      } catch (e) {
        console.log("loadForEdit error", e);
      }
    }

    loadForEdit();
  }, [mode, deviceId]);

  // ===== Helpers ====================================================

  function toggleOrderType(code: string) {
    setEnabledOrderTypes((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]
    );
  }

  function toggleCategory(id: string) {
    setSelectedCategoryIds((prev) =>
      prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]
    );
  }

  function toggleProduct(id: string) {
    setSelectedProductIds((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]
    );
  }

  function getEnabledTypesLabel() {
    if (!enabledOrderTypes || enabledOrderTypes.length === 0) return "Not set";

    const labels = ORDER_TYPE_OPTIONS
      .filter((o) => enabledOrderTypes.includes(o.code))
      .map((o) => o.label);

    return labels.join(", ");
  }

  function getCategoryFilterLabel() {
    if (!selectedCategoryIds.length) return "All categories";
    const names = allCategories
      .filter((c) => selectedCategoryIds.includes(c.id))
      .map((c) => c.name);
    return names.join(", ");
  }

  function getProductFilterLabel() {
    if (!selectedProductIds.length) return "All products";
    const names = allProducts
      .filter((p) => selectedProductIds.includes(p.id))
      .map((p) => p.name);
    return names.join(", ");
  }

  const headerTitle =
    subScreen === "MAIN"
      ? "Printer Info"
      : subScreen === "MODEL"
      ? "Model"
      : subScreen === "TYPE"
      ? "Type"
      : subScreen === "ORDER_TYPES"
      ? "Enabled order types"
      : subScreen === "CATEGORY_FILTER"
      ? "Category filter"
      : "Product filter";

  const showSave = subScreen === "MAIN";

  function handleBack() {
    if (subScreen === "MAIN") {
      navigation.goBack(); // App.tsx: DeviceInfo -> Devices
    } else {
      setSubScreen("MAIN");
    }
  }

  // ===== SAVE to AsyncStorage ======================================

  async function saveDevice() {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      const list: StoredDevice[] = raw ? JSON.parse(raw) : [];

      const categoryFilter =
        selectedCategoryIds.length > 0 ? selectedCategoryIds.join(",") : "";
      const productFilter =
        selectedProductIds.length > 0 ? selectedProductIds.join(",") : "";

      let nextList: StoredDevice[];

      if (mode === "edit" && deviceId) {
        const updated: StoredDevice = {
          id: deviceId,
          kind: deviceType,
          model,
          typeLabel,
          name,
          ip,
          enabledOrderTypes,
          categoryFilter,
          productFilter,
        };
        nextList = list.map((d) => (d.id === deviceId ? updated : d));
      } else {
        const id = deviceId || Date.now().toString();
        const item: StoredDevice = {
          id,
          kind: deviceType,
          model,
          typeLabel,
          name,
          ip,
          enabledOrderTypes,
          categoryFilter,
          productFilter,
        };
        nextList = [...list, item];
      }

      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(nextList));

      // back to Devices
      navigation.goBack();
    } catch (e) {
      console.log("saveDevice error", e);
      navigation.goBack();
    }
  }

  // ===== RENDER =====================================================

  return (
    <SafeAreaView style={styles.overlay}>
      <View style={styles.card}>
        {/* Header */}
        <View style={styles.header}>
          <Pressable onPress={handleBack}>
            <Text style={styles.headerLink}>Back</Text>
          </Pressable>

          <Text style={styles.headerTitle}>{headerTitle}</Text>

          <View style={{ width: 60, alignItems: "flex-end" }}>
            {showSave && (
              <Pressable onPress={saveDevice}>
                <Text style={styles.headerLink}>Save</Text>
              </Pressable>
            )}
          </View>
        </View>

        {/* MAIN SCREEN ------------------------------------------------ */}
        {subScreen === "MAIN" && (
          <View style={styles.list}>
            {/* Model row */}
            <Pressable
              style={styles.row}
              onPress={() => setSubScreen("MODEL")}
            >
              <Text style={styles.rowLabel}>Model</Text>
              <View style={styles.rowRight}>
                <Text
                  style={[
                    styles.rowValue,
                    !model && styles.placeholderText,
                  ]}
                >
                  {model || "Select model"}
                </Text>
                <MaterialIcons
                  name="chevron-right"
                  size={20}
                  color="#9ca3af"
                />
              </View>
            </Pressable>

            {/* Type row */}
            <Pressable
              style={styles.row}
              onPress={() => setSubScreen("TYPE")}
            >
              <Text style={styles.rowLabel}>Type</Text>
              <View style={styles.rowRight}>
                <Text
                  style={[
                    styles.rowValue,
                    !typeLabel && styles.placeholderText,
                  ]}
                >
                  {typeLabel || "Select type"}
                </Text>
                <MaterialIcons
                  name="chevron-right"
                  size={20}
                  color="#9ca3af"
                />
              </View>
            </Pressable>

            {/* NAME row */}
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Name</Text>
              <TextInput
                style={[
                  styles.textInput,
                  !name && styles.placeholderText,
                ]}
                value={name}
                onChangeText={setName}
                placeholder="Printer name"
                placeholderTextColor="#9ca3af"
              />
            </View>

            {/* IP row */}
            <View style={styles.row}>
              <Text style={styles.rowLabel}>IP address</Text>
              <TextInput
                style={[
                  styles.textInput,
                  !ip && styles.placeholderText,
                ]}
                value={ip}
                onChangeText={setIp}
                keyboardType="numeric"
                placeholder="0.0.0.0"
                placeholderTextColor="#9ca3af"
              />
            </View>

            {/* Category filter row */}
            <Pressable
              style={styles.row}
              onPress={() => setSubScreen("CATEGORY_FILTER")}
            >
              <Text style={styles.rowLabel}>Category filter</Text>
              <View style={styles.rowRight}>
                <Text
                  style={[
                    styles.rowValue,
                    !selectedCategoryIds.length &&
                      styles.placeholderText,
                  ]}
                  numberOfLines={1}
                >
                  {getCategoryFilterLabel()}
                </Text>
                <MaterialIcons
                  name="chevron-right"
                  size={20}
                  color="#9ca3af"
                />
              </View>
            </Pressable>

            {/* Product filter row */}
            <Pressable
              style={styles.row}
              onPress={() => setSubScreen("PRODUCT_FILTER")}
            >
              <Text style={styles.rowLabel}>Product filter</Text>
              <View style={styles.rowRight}>
                <Text
                  style={[
                    styles.rowValue,
                    !selectedProductIds.length &&
                      styles.placeholderText,
                  ]}
                  numberOfLines={1}
                >
                  {getProductFilterLabel()}
                </Text>
                <MaterialIcons
                  name="chevron-right"
                  size={20}
                  color="#9ca3af"
                />
              </View>
            </Pressable>

            {/* Enabled order types */}
            <Pressable
              style={styles.row}
              onPress={() => setSubScreen("ORDER_TYPES")}
            >
              <Text style={styles.rowLabel}>Enabled order types</Text>
              <View style={styles.rowRight}>
                <Text
                  style={[
                    styles.rowValue,
                    (!enabledOrderTypes ||
                      !enabledOrderTypes.length) &&
                      styles.placeholderText,
                  ]}
                >
                  {getEnabledTypesLabel()}
                </Text>
                <MaterialIcons
                  name="chevron-right"
                  size={20}
                  color="#9ca3af"
                />
              </View>
            </Pressable>
          </View>
        )}

        {/* MODEL LIST ------------------------------------------------- */}
        {subScreen === "MODEL" && (
          <FlatList
            data={PRINTER_MODELS}
            keyExtractor={(m) => m}
            ItemSeparatorComponent={() => <View style={styles.separator} />}
            renderItem={({ item }) => (
              <Pressable
                style={styles.row}
                onPress={() => {
                  setModel(item);
                  setSubScreen("MAIN");
                }}
              >
                <Text style={styles.rowLabel}>{item}</Text>
              </Pressable>
            )}
          />
        )}

        {/* TYPE LIST -------------------------------------------------- */}
        {subScreen === "TYPE" && (
          <FlatList
            data={PRINTER_TYPES}
            keyExtractor={(m) => m}
            ItemSeparatorComponent={() => <View style={styles.separator} />}
            renderItem={({ item }) => (
              <Pressable
                style={styles.row}
                onPress={() => {
                  setTypeLabel(item);
                  setSubScreen("MAIN");
                }}
              >
                <Text style={styles.rowLabel}>{item}</Text>
              </Pressable>
            )}
          />
        )}

        {/* ORDER TYPES ------------------------------------------------ */}
        {subScreen === "ORDER_TYPES" && (
          <View style={{ flex: 1 }}>
            <View style={styles.sectionHeaderRow}>
              <Text style={styles.sectionHeader}>ENABLED ORDER TYPES</Text>
            </View>
            <FlatList
              data={ORDER_TYPE_OPTIONS}
              keyExtractor={(m) => m.code}
              ItemSeparatorComponent={() => <View style={styles.separator} />}
              renderItem={({ item }) => {
                const active = enabledOrderTypes.includes(item.code);
                return (
                  <Pressable
                    style={styles.row}
                    onPress={() => toggleOrderType(item.code)}
                  >
                    <Text style={styles.rowLabel}>{item.label}</Text>
                    {active && (
                      <MaterialIcons
                        name="check"
                        size={20}
                        color="#10b981"
                      />
                    )}
                  </Pressable>
                );
              }}
            />
          </View>
        )}

        {/* CATEGORY FILTER -------------------------------------------- */}
        {subScreen === "CATEGORY_FILTER" && (
          <View style={{ flex: 1 }}>
            <View style={styles.sectionHeaderRow}>
              <Text style={styles.sectionHeader}>
                SELECT CATEGORIES FOR THIS PRINTER
              </Text>
            </View>
            <FlatList
              data={allCategories}
              keyExtractor={(c) => c.id}
              ItemSeparatorComponent={() => <View style={styles.separator} />}
              renderItem={({ item }) => {
                const active = selectedCategoryIds.includes(item.id);
                return (
                  <Pressable
                    style={styles.row}
                    onPress={() => toggleCategory(item.id)}
                  >
                    <Text style={styles.rowLabel}>{item.name}</Text>
                    {active && (
                      <MaterialIcons
                        name="check"
                        size={20}
                        color="#10b981"
                      />
                    )}
                  </Pressable>
                );
              }}
            />
          </View>
        )}

        {/* PRODUCT FILTER --------------------------------------------- */}
        {subScreen === "PRODUCT_FILTER" && (
          <View style={{ flex: 1 }}>
            <View style={styles.sectionHeaderRow}>
              <Text style={styles.sectionHeader}>
                SELECT PRODUCTS FOR THIS PRINTER
              </Text>
            </View>
            <FlatList
              data={allProducts}
              keyExtractor={(p) => p.id}
              ItemSeparatorComponent={() => <View style={styles.separator} />}
              renderItem={({ item }) => {
                const active = selectedProductIds.includes(item.id);
                const catName =
                  allCategories.find((c) => c.id === item.categoryId)?.name ||
                  "";
                return (
                  <Pressable
                    style={styles.row}
                    onPress={() => toggleProduct(item.id)}
                  >
                    <View>
                      <Text style={styles.rowLabel}>{item.name}</Text>
                      {!!catName && (
                        <Text
                          style={{ fontSize: 12, color: "#9ca3af" }}
                        >
                          {catName}
                        </Text>
                      )}
                    </View>
                    {active && (
                      <MaterialIcons
                        name="check"
                        size={20}
                        color="#10b981"
                      />
                    )}
                  </Pressable>
                );
              }}
            />
          </View>
        )}
      </View>
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
    paddingHorizontal: 24,
    paddingTop: 14,
    paddingBottom: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerLink: {
    color: "#000000",
    fontSize: 16,
    fontWeight: "500",
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: "600",
    color: "#111827",
  },
  list: {
    flex: 1,
  },
  row: {
    paddingHorizontal: 24,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  rowLabel: {
    fontSize: 15,
    color: "#111827",
  },
  rowRight: {
    flexDirection: "row",
    alignItems: "center",
    maxWidth: "60%",
  },
  rowValue: {
    fontSize: 14,
    color: "#111827",
    marginRight: 4,
  },
  textInput: {
    minWidth: 200,
    textAlign: "right",
    fontSize: 15,
    color: "#111827",
  },
  placeholderText: {
    color: "#9ca3af",
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: "#e5e7eb",
  },
  sectionHeaderRow: {
    paddingHorizontal: 24,
    paddingTop: 10,
    paddingBottom: 4,
  },
  sectionHeader: {
    fontSize: 12,
    fontWeight: "600",
    color: "#6b7280",
  },
});
