import React from "react";
import {
  Modal,
  View,
  Text,
  Pressable,
  StyleSheet,
  Platform,
} from "react-native";

type Props = {
  visible: boolean;
  title: string;
  message?: string;
  tone?: "success" | "error" | "info";
  primaryText?: string;
  onPrimary?: () => void;
  secondaryText?: string;
  onSecondary?: () => void;
  onClose?: () => void;
};

export default function ModernDialog({
  visible,
  title,
  message,
  tone = "info",
  primaryText = "OK",
  onPrimary,
  secondaryText,
  onSecondary,
  onClose,
}: Props) {
  const icon = tone === "success" ? "✅" : tone === "error" ? "⛔️" : "ℹ️";

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={() => onClose?.()}
    >
      <View style={styles.overlay}>
        {/* Tap outside to close (optional) */}
        <Pressable style={StyleSheet.absoluteFill} onPress={() => onClose?.()} />

        <View style={styles.card}>
          <View style={styles.headerRow}>
            <View style={styles.iconBubble}>
              <Text style={styles.icon}>{icon}</Text>
            </View>

            <View style={{ flex: 1 }}>
              <Text style={styles.title}>{title}</Text>
              {!!message && <Text style={styles.message}>{message}</Text>}
            </View>
          </View>

          <View style={styles.actions}>
            {!!secondaryText && (
              <Pressable
                onPress={() => onSecondary?.()}
                style={({ pressed }) => [
                  styles.secondaryBtn,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.secondaryText}>{secondaryText}</Text>
              </Pressable>
            )}

            <Pressable
              onPress={() => onPrimary?.()}
              style={({ pressed }) => [
                styles.primaryBtn,
                tone === "error" && styles.primaryBtnError,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.primaryText}>{primaryText}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
    padding: 18,
  },
  card: {
    width: "100%",
    maxWidth: 520,
    borderRadius: 18,
    backgroundColor: "#0B1220",
    padding: 16,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOpacity: 0.35,
        shadowRadius: 18,
        shadowOffset: { width: 0, height: 8 },
      },
      android: { elevation: 8 },
    }),
  },
  headerRow: { flexDirection: "row", gap: 12, alignItems: "flex-start" },
  iconBubble: {
    width: 42,
    height: 42,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.08)",
    alignItems: "center",
    justifyContent: "center",
  },
  icon: { fontSize: 18 },
  title: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "800",
    letterSpacing: 0.2,
  },
  message: {
    marginTop: 6,
    color: "rgba(255,255,255,0.72)",
    fontSize: 13,
    lineHeight: 18,
  },
  actions: {
    flexDirection: "row",
    gap: 10,
    justifyContent: "flex-end",
    marginTop: 14,
  },
  primaryBtn: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: "#FFFFFF",
    minWidth: 92,
    alignItems: "center",
  },
  primaryBtnError: { backgroundColor: "#FF4D4F" },
  primaryText: { color: "#0B1220", fontWeight: "800" },
  secondaryBtn: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    minWidth: 92,
    alignItems: "center",
  },
  secondaryText: { color: "#FFFFFF", fontWeight: "700" },
  pressed: { transform: [{ scale: 0.99 }], opacity: 0.92 },
});
