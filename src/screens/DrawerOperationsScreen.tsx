// src/screens/DrawerOperationsScreen.tsx
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { useAuthStore } from "../store/authStore";

export default function DrawerOperationsScreen({ navigation }: any) {

  useFocusEffect(
    React.useCallback(() => {
      const ok =
        useAuthStore.getState().hasPermission("pos.drawer.operations") ||
        useAuthStore.getState().hasPermission("DRAWER_OPERATIONS");

      if (!ok) {
        navigation.goBack();
      }
    }, [navigation])
  );

  return (
    <View style={styles.root}>
      <Text style={styles.title}>Drawer Operations</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: "center", alignItems: "center" },
  title: { fontSize: 20, fontWeight: "600" },
});
