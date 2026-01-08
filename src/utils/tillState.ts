import AsyncStorage from "@react-native-async-storage/async-storage";
import { getLocalTillSession } from "../database/clockLocal";

export async function resolveTillOpen(): Promise<boolean> {
  try {
    const session = await getLocalTillSession();

    // ✅ No session = till closed (normal)
    if (!session) {
      await AsyncStorage.setItem("pos_till_opened", "0");
      return false;
    }

    // adapt to your schema
    const open = !session.closedAt;

    await AsyncStorage.setItem("pos_till_opened", open ? "1" : "0");
    return open;
  } catch {
    // ❌ DO NOT log here
    // safest fallback = closed
    return false;
  }
}
