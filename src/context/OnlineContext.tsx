import React, { createContext, useContext, useEffect, useState } from 'react';
import NetInfo from '@react-native-community/netinfo';

const OnlineContext = createContext<boolean>(true);

export const OnlineProvider = ({ children }: { children: React.ReactNode }) => {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    const sub = NetInfo.addEventListener(state => {
      const isOnline = !!state.isConnected && !!state.isInternetReachable;
      setOnline(isOnline);
    });
    return () => sub();
  }, []);

  return (
    <OnlineContext.Provider value={online}>
      {children}
    </OnlineContext.Provider>
  );
};

export function useOnline() {
  return useContext(OnlineContext);
}
