/**
 * RootLayout Component
 *
 * App-wide navigation shell:
 * - ThemeProvider: light/dark system color scheme synchronization
 * - Stack Navigator: headerless screen transitions
 * - StatusBar: dark icons on clean white surface
 */

import { ChatExportProvider } from "@/context/ChatExportContext";
import { ToastProvider } from "@/context/ToastContext";
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useColorScheme } from "react-native";
import { KeyboardProvider } from "react-native-keyboard-controller";

export default function RootLayout() {
  const colorScheme = useColorScheme();

  return (
    <KeyboardProvider statusBarTranslucent navigationBarTranslucent>
      <ThemeProvider value={colorScheme === "dark" ? DarkTheme : DefaultTheme}>
        <ToastProvider>
          <ChatExportProvider>
            <Stack screenOptions={{ headerShown: false, animation: "fade" }}>
              <Stack.Screen name="index" options={{ headerShown: false }} />
              <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
              <Stack.Screen name="home" options={{ headerShown: false }} />
            </Stack>
            <StatusBar style="dark" />
          </ChatExportProvider>
        </ToastProvider>
      </ThemeProvider>
    </KeyboardProvider>
  );
}
