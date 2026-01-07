import React, { useState } from "react";
import {
 View, Text, TextInput, Pressable, ScrollView
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import uuid from "react-native-uuid";

const STORAGE_KEY = "pos_devices";

export default function NewDevice({ route, navigation }: any) {
  const { type } = route.params;

  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [ip, setIp] = useState("");
  const [role, setRole] = useState("CASHIER");

  async function save() {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    const list = raw ? JSON.parse(raw) : [];

    list.push({
      id: uuid.v4(),
      type,
      name,
      model,
      ip,
      printerRole: role,
    });

    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    navigation.goBack();
  }

  return (
    <ScrollView style={{ padding: 16 }}>
      <Text>Device Type: {type}</Text>

      <Text>Name</Text>
      <TextInput value={name} onChangeText={setName} style={{borderWidth:1}} />

      {type === "PRINTER" && (
        <>
          <Text>Model</Text>
          <TextInput value={model} onChangeText={setModel} style={{borderWidth:1}} />

          <Text>IP Address</Text>
          <TextInput value={ip} onChangeText={setIp} style={{borderWidth:1}} />

          <Text>Role</Text>
          <Pressable onPress={() => setRole("CASHIER")}><Text>Cashier</Text></Pressable>
          <Pressable onPress={() => setRole("KITCHEN")}><Text>Kitchen</Text></Pressable>
          <Pressable onPress={() => setRole("ORDER_INFO")}><Text>Order Info</Text></Pressable>
        </>
      )}

      <Pressable
        onPress={save}
        style={{backgroundColor:"black",padding:14,marginTop:20}}
      >
        <Text style={{color:"white",textAlign:"center"}}>Save</Text>
      </Pressable>
    </ScrollView>
  );
}
