// src/navigation/RootNavigator.tsx (example)
import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import HomeScreen from '../screens/HomeScreen';
import OrdersScreen from '../screens/OrdersScreen';
import { useCallcenterOrders } from '../context/CallcenterOrdersContext';
import { MaterialIcons } from '@expo/vector-icons';

const Tab = createBottomTabNavigator();

export default function RootNavigator() {
  const { badgeCount } = useCallcenterOrders();

  return (
    <Tab.Navigator>
      <Tab.Screen
        name="Home"
        component={HomeScreen}
        options={{
          tabBarIcon: ({ color, size }) => (
            <MaterialIcons name="home" size={size} color={color} />
          ),
        }}
      />
      <Tab.Screen
        name="Orders"
        component={OrdersScreen}
        options={{
          tabBarIcon: ({ color, size }) => (
            <MaterialIcons name="receipt-long" size={size} color={color} />
          ),
          // 🔴 bubble count
          tabBarBadge: badgeCount > 0 ? badgeCount : undefined,
        }}
      />
    </Tab.Navigator>
  );
}
