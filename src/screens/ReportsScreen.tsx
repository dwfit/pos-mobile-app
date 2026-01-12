// src/screens/ReportsScreen.tsx
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { useAuthStore } from "../store/authStore";

export default function ReportsScreen({ navigation }: any) {

  useFocusEffect(
    React.useCallback(() => {
      const ok =
        useAuthStore.getState().hasPermission("pos.reports.view") ||
        useAuthStore.getState().hasPermission("pos.reports.access") ||
        useAuthStore.getState().hasPermission("ACCESS_REPORTS");

      if (!ok) {
        navigation.goBack();
      }
    }, [navigation])
  );

  return (
    <View style={styles.root}>
      <Text style={styles.title}>Reports</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: "center", alignItems: "center" },
  title: { fontSize: 20, fontWeight: "600" },
});
