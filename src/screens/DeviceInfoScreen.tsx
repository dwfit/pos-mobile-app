// src/screens/DeviceInfoScreen.tsx
import React, { useEffect, useMemo, useState } from "react";
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

// ✅ correct paths
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
  deviceType: string; // "Printer"
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
  kind: string;
  model: string | null;
  typeLabel: string | null;
  name: string;
  ip: string;
  enabledOrderTypes: string[];
  categoryFilter?: string | null;
  productFilter?: string | null;
};

type LocalCategory = { id: string; name: string };
type LocalProduct = { id: string; name: string; categoryId: string | null };

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

  const [allCategories, setAllCategories] = useState<LocalCategory[]>([]);
  const [allProducts, setAllProducts] = useState<LocalProduct[]>([]);

  const [selectedCategoryIds, setSelectedCategoryIds] = useState<string[]>([]);
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([]);

  // Load menu from local DB
  useEffect(() => {
    (async () => {
      try {
        const cats = await getLocalCategories();
        setAllCategories(cats || []);

        // minimal products load
        const db = getDb();
        const rows = await db.getAllAsync<any>(
          `SELECT id, name, categoryId FROM products`
        );
        const prods: LocalProduct[] = (rows || []).map((r: any) => ({
          id: String(r.id),
          name: String(r.name || ""),
          categoryId: r.categoryId ? String(r.categoryId) : null,
        }));
        setAllProducts(prods);
      } catch (e) {
        console.log("Load local menu failed", e);
      }
    })();
  }, []);

  // Load device for edit
  useEffect(() => {
    (async () => {
      if (mode !== "edit" || !deviceId) return;

      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        const list: StoredDevice[] = raw ? JSON.parse(raw) : [];
        const found = (Array.isArray(list) ? list : []).find((d) => d.id === deviceId);
        if (!found) return;

        setModel(found.model ?? null);
        setTypeLabel(found.typeLabel ?? null);
        setName(found.name ?? "");
        setIp(found.ip ?? "");
        setEnabledOrderTypes(Array.isArray(found.enabledOrderTypes) ? found.enabledOrderTypes : []);

        const catIds =
          found.categoryFilter?.split(",").filter(Boolean) ?? [];
        const prodIds =
          found.productFilter?.split(",").filter(Boolean) ?? [];

        setSelectedCategoryIds(catIds);
        setSelectedProductIds(prodIds);
      } catch (e) {
        console.log("Load device error", e);
      }
    })();
  }, [mode, deviceId]);

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
    if (!enabledOrderTypes?.length) return "Not set";
    return ORDER_TYPE_OPTIONS
      .filter((o) => enabledOrderTypes.includes(o.code))
      .map((o) => o.label)
      .join(", ");
  }

  function getCategoryFilterLabel() {
    if (!selectedCategoryIds.length) return "All categories";
    return allCategories
      .filter((c) => selectedCategoryIds.includes(c.id))
      .map((c) => c.name)
      .join(", ");
  }

  function getProductFilterLabel() {
    if (!selectedProductIds.length) return "All products";
    return allProducts
      .filter((p) => selectedProductIds.includes(p.id))
      .map((p) => p.name)
      .join(", ");
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
    if (subScreen === "MAIN") navigation.goBack();
    else setSubScreen("MAIN");
  }

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
        nextList = (Array.isArray(list) ? list : []).map((d) =>
          d.id === deviceId ? updated : d
        );
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
        nextList = [...(Array.isArray(list) ? list : []), item];
      }

      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(nextList));
      navigation.goBack();
    } catch (e) {
      console.log("saveDevice error", e);
      navigation.goBack();
    }
  }

  const filteredProducts = useMemo(() => {
    // optional: filter by selected categories to reduce list
    if (!selectedCategoryIds.length) return allProducts;
    return allProducts.filter((p) =>
      p.categoryId ? selectedCategoryIds.includes(p.categoryId) : false
    );
  }, [allProducts, selectedCategoryIds]);

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

        {/* MAIN */}
        {subScreen === "MAIN" && (
          <View style={styles.list}>
            <Pressable style={styles.row} onPress={() => setSubScreen("MODEL")}>
              <Text style={styles.rowLabel}>Model</Text>
              <View style={styles.rowRight}>
                <Text style={[styles.rowValue, !model && styles.placeholderText]}>
                  {model || "Select model"}
                </Text>
                <MaterialIcons name="chevron-right" size={20} color="#9ca3af" />
              </View>
            </Pressable>

            <Pressable style={styles.row} onPress={() => setSubScreen("TYPE")}>
              <Text style={styles.rowLabel}>Type</Text>
              <View style={styles.rowRight}>
                <Text style={[styles.rowValue, !typeLabel && styles.placeholderText]}>
                  {typeLabel || "Select type"}
                </Text>
                <MaterialIcons name="chevron-right" size={20} color="#9ca3af" />
              </View>
            </Pressable>

            <View style={styles.row}>
              <Text style={styles.rowLabel}>Name</Text>
              <TextInput
                style={styles.textInput}
                value={name}
                onChangeText={setName}
                placeholder="Printer name"
                placeholderTextColor="#9ca3af"
              />
            </View>

            <View style={styles.row}>
              <Text style={styles.rowLabel}>IP address</Text>
              <TextInput
                style={styles.textInput}
                value={ip}
                onChangeText={setIp}
                keyboardType="numeric"
                placeholder="192.168.0.10"
                placeholderTextColor="#9ca3af"
              />
            </View>

            <Pressable
              style={styles.row}
              onPress={() => setSubScreen("CATEGORY_FILTER")}
            >
              <Text style={styles.rowLabel}>Category filter</Text>
              <View style={styles.rowRight}>
                <Text style={styles.rowValue} numberOfLines={1}>
                  {getCategoryFilterLabel()}
                </Text>
                <MaterialIcons name="chevron-right" size={20} color="#9ca3af" />
              </View>
            </Pressable>

            <Pressable
              style={styles.row}
              onPress={() => setSubScreen("PRODUCT_FILTER")}
            >
              <Text style={styles.rowLabel}>Product filter</Text>
              <View style={styles.rowRight}>
                <Text style={styles.rowValue} numberOfLines={1}>
                  {getProductFilterLabel()}
                </Text>
                <MaterialIcons name="chevron-right" size={20} color="#9ca3af" />
              </View>
            </Pressable>

            <Pressable
              style={styles.row}
              onPress={() => setSubScreen("ORDER_TYPES")}
            >
              <Text style={styles.rowLabel}>Enabled order types</Text>
              <View style={styles.rowRight}>
                <Text style={styles.rowValue} numberOfLines={1}>
                  {getEnabledTypesLabel()}
                </Text>
                <MaterialIcons name="chevron-right" size={20} color="#9ca3af" />
              </View>
            </Pressable>
          </View>
        )}

        {/* MODEL */}
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

        {/* TYPE */}
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
                  ;
                }}
              >
                <Text style={styles.rowLabel}>{item}</Text>
              </Pressable>
            )}
          />
        )}

        {/* ORDER TYPES */}
        {subScreen === "ORDER_TYPES" && (
          <FlatList
            data={ORDER_TYPE_OPTIONS}
            keyExtractor={(m) => m.code}
            ItemSeparatorComponent={() => <View style={styles.separator} />}
            renderItem={({ item }) => {
              const active = enabledOrderTypes.includes(item.code);
              return (
                <Pressable style={styles.row} onPress={() => toggleOrderType(item.code)}>
                  <Text style={styles.rowLabel}>{item.label}</Text>
                  <MaterialIcons
                    name={active ? "check-circle" : "radio-button-unchecked"}
                    size={20}
                    color={active ? "#111827" : "#9ca3af"}
                  />
                </Pressable>
              );
            }}
          />
        )}

        {/* CATEGORY FILTER */}
        {subScreen === "CATEGORY_FILTER" && (
          <FlatList
            data={allCategories}
            keyExtractor={(c) => c.id}
            ItemSeparatorComponent={() => <View style={styles.separator} />}
            renderItem={({ item }) => {
              const active = selectedCategoryIds.includes(item.id);
              return (
                <Pressable style={styles.row} onPress={() => toggleCategory(item.id)}>
                  <Text style={styles.rowLabel}>{item.name}</Text>
                  <MaterialIcons
                    name={active ? "check-circle" : "radio-button-unchecked"}
                    size={20}
                    color={active ? "#111827" : "#9ca3af"}
                  />
                </Pressable>
              );
            }}
          />
        )}

        {/* PRODUCT FILTER */}
        {subScreen === "PRODUCT_FILTER" && (
          <FlatList
            data={filteredProducts}
            keyExtractor={(p) => p.id}
            ItemSeparatorComponent={() => <View style={styles.separator} />}
            renderItem={({ item }) => {
              const active = selectedProductIds.includes(item.id);
              return (
                <Pressable style={styles.row} onPress={() => toggleProduct(item.id)}>
                  <Text style={styles.rowLabel}>{item.name}</Text>
                  <MaterialIcons
                    name={active ? "check-circle" : "radio-button-unchecked"}
                    size={20}
                    color={active ? "#111827" : "#9ca3af"}
                  />
                </Pressable>
              );
            }}
          />
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: "#f3f4f6" },
  card: { flex: 1 },

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
  headerLink: {
    color: "#111827",
    fontSize: 16,
    fontWeight: "600",
    paddingTop: 2,
  },
  headerTitle: {
    color: "#111827",
    fontSize: 16,
    fontWeight: "700",
    paddingTop: 2,
  },

  list: { backgroundColor: "#ffffff" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    justifyContent: "space-between",
    backgroundColor: "#ffffff",
  },
  rowLabel: { fontSize: 14, fontWeight: "600", color: "#111827" },
  rowRight: { flexDirection: "row", alignItems: "center", gap: 8, maxWidth: "60%" },
  rowValue: { fontSize: 13, color: "#6b7280", maxWidth: "90%" },
  placeholderText: { color: "#9ca3af" },

  textInput: {
    flex: 1,
    textAlign: "right",
    color: "#111827",
    paddingVertical: 6,
    marginLeft: 12,
  },

  separator: { height: 1, backgroundColor: "#e5e7eb" },
});
