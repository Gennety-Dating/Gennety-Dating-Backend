/**
 * Gennety onboarding pre-permission screen — drop into the Expo mobile app.
 *
 * This repo does not ship the actual React Native app yet, so this file lives
 * in `mobile-handoff/` as a copy-ready reference, just like `WingmanCard.tsx`.
 *
 * Required peer deps in the Expo app:
 *   - react-native
 *   - expo-blur
 *   - expo-device
 *   - expo-notifications
 *
 * Flow:
 *   1. Mounts without triggering the OS permission prompt.
 *   2. Tapping "Включить радар" immediately requests notification permission.
 *   3. After the system sheet resolves (granted or denied), we call
 *      `onPermissionResolved` so the onboarding stack can move forward.
 *   4. Tapping "Я готов пропустить свой мэтч" skips the prompt entirely.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Easing,
  Platform,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { BlurView } from "expo-blur";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";

export type UserGender = "male" | "female";
export type PushPlatform = "ios" | "android";

export interface RegisteredPushToken {
  token: string;
  platform: PushPlatform;
}

export interface NotificationPermissionResult {
  status: Notifications.PermissionStatus;
  granted: boolean;
  canAskAgain: boolean;
  pushToken: string | null;
  registrationError: unknown | null;
}

export interface NotificationPrePermissionScreenProps {
  userGender: UserGender;
  expoProjectId?: string;
  registerPushToken?: (input: RegisteredPushToken) => Promise<void>;
  onPermissionResolved: (result: NotificationPermissionResult) => Promise<void> | void;
  onSkip: () => Promise<void> | void;
}

const COLORS = {
  background: "#050507",
  card: "rgba(255, 255, 255, 0.08)",
  cardStrong: "rgba(255, 255, 255, 0.12)",
  border: "rgba(230, 230, 250, 0.18)",
  text: "#F8F4FF",
  textMuted: "rgba(248, 244, 255, 0.68)",
  accent: "#E6E6FA",
  accentGlow: "#8A2BE2",
  secondary: "rgba(248, 244, 255, 0.1)",
};

const BENTO_ROWS = [
  "Мы нашли вам идеальную пару.",
  "Вам нужно подтвердить встречу.",
  "Напоминание и детали за час до свидания.",
] as const;

export function buildNotificationPreviewText(userGender: UserGender): string {
  if (userGender === "female") {
    return "Встреча через час в [Локация]. Ваши настройки безопасности активны. Нажмите для деталей.";
  }

  return "Найден идеальный мэтч. У вас есть 24 часа, чтобы подтвердить встречу.";
}

/**
 * Requests OS notification permission only when the primary CTA is pressed.
 * When granted, optionally fetches the Expo push token and hands it back to
 * the mobile app via `registerPushToken`.
 */
export async function requestPushPermissionFlow({
  expoProjectId,
  registerPushToken,
}: Pick<NotificationPrePermissionScreenProps, "expoProjectId" | "registerPushToken">): Promise<NotificationPermissionResult> {
  const current = await Notifications.getPermissionsAsync();

  let finalStatus = current.status;
  let canAskAgain = current.canAskAgain;

  if (finalStatus !== "granted") {
    const requested = await Notifications.requestPermissionsAsync({
      ios: {
        allowAlert: true,
        allowBadge: true,
        allowSound: true,
      },
    });

    finalStatus = requested.status;
    canAskAgain = requested.canAskAgain;
  }

  let pushToken: string | null = null;
  let registrationError: unknown | null = null;

  if (finalStatus === "granted" && registerPushToken && Device.isDevice) {
    try {
      if (Platform.OS === "android") {
        await Notifications.setNotificationChannelAsync("default", {
          name: "default",
          importance: Notifications.AndroidImportance.MAX,
          vibrationPattern: [0, 250, 150, 250],
          lightColor: COLORS.accentGlow,
        });
      }

      const tokenResponse = expoProjectId
        ? await Notifications.getExpoPushTokenAsync({ projectId: expoProjectId })
        : await Notifications.getExpoPushTokenAsync();

      pushToken = tokenResponse.data;

      await registerPushToken({
        token: tokenResponse.data,
        platform: Platform.OS === "ios" ? "ios" : "android",
      });
    } catch (error) {
      registrationError = error;
    }
  }

  return {
    status: finalStatus,
    granted: finalStatus === "granted",
    canAskAgain,
    pushToken,
    registrationError,
  };
}

export function NotificationPrePermissionScreen({
  userGender,
  expoProjectId,
  registerPushToken,
  onPermissionResolved,
  onSkip,
}: NotificationPrePermissionScreenProps): React.JSX.Element {
  const previewText = useMemo(() => buildNotificationPreviewText(userGender), [userGender]);
  const [busyAction, setBusyAction] = useState<"primary" | "secondary" | null>(null);
  const floatAnimation = useRef(new Animated.Value(0)).current;
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;

    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(floatAnimation, {
          toValue: -8,
          duration: 2400,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(floatAnimation, {
          toValue: 8,
          duration: 2400,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ]),
    );

    loop.start();

    return () => {
      isMounted.current = false;
      loop.stop();
    };
  }, [floatAnimation]);

  async function handleEnableRadar(): Promise<void> {
    if (busyAction) return;
    setBusyAction("primary");

    try {
      const result = await requestPushPermissionFlow({
        expoProjectId,
        registerPushToken,
      });
      await onPermissionResolved(result);
    } finally {
      if (isMounted.current) {
        setBusyAction(null);
      }
    }
  }

  async function handleSkip(): Promise<void> {
    if (busyAction) return;
    setBusyAction("secondary");

    try {
      await onSkip();
    } finally {
      if (isMounted.current) {
        setBusyAction(null);
      }
    }
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.screen}>
        <View style={styles.topGlow} pointerEvents="none" />
        <View style={styles.bottomGlow} pointerEvents="none" />

        <View style={styles.header}>
          <Text style={styles.eyebrow}>Gennety Radar</Text>
          <Text style={styles.title}>Никакого спама. Только суть.</Text>
          <Text style={styles.subtitle}>
            Разрешите пуши только для того, что действительно важно: мэтч, подтверждение и
            точные детали свидания.
          </Text>
        </View>

        <View style={styles.centerStage}>
          <Animated.View
            style={[styles.notificationWrapper, { transform: [{ translateY: floatAnimation }] }]}
          >
            <View style={styles.notificationGlow} pointerEvents="none" />

            <BlurView intensity={Platform.OS === "ios" ? 42 : 0} tint="dark" style={styles.notificationCard}>
              <View style={styles.notificationTopRow}>
                <View style={styles.notificationBadge}>
                  <Text style={styles.notificationBadgeText}>G</Text>
                </View>
                <View style={styles.notificationMeta}>
                  <Text style={styles.notificationApp}>Gennety</Text>
                  <Text style={styles.notificationTime}>сейчас</Text>
                </View>
              </View>

              <Text style={styles.notificationBody}>{previewText}</Text>
            </BlurView>
          </Animated.View>
        </View>

        <View style={styles.bentoGrid}>
          <BlurView intensity={Platform.OS === "ios" ? 28 : 0} tint="dark" style={[styles.bentoCard, styles.bentoHalf]}>
            <Text style={styles.bentoIndex}>01</Text>
            <Text style={styles.bentoText}>{BENTO_ROWS[0]}</Text>
          </BlurView>

          <BlurView intensity={Platform.OS === "ios" ? 28 : 0} tint="dark" style={[styles.bentoCard, styles.bentoHalf]}>
            <Text style={styles.bentoIndex}>02</Text>
            <Text style={styles.bentoText}>{BENTO_ROWS[1]}</Text>
          </BlurView>

          <BlurView intensity={Platform.OS === "ios" ? 28 : 0} tint="dark" style={[styles.bentoCard, styles.bentoWide]}>
            <Text style={styles.bentoIndex}>03</Text>
            <Text style={styles.bentoText}>{BENTO_ROWS[2]}</Text>
          </BlurView>
        </View>

        <View style={styles.footer}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Включить радар"
            disabled={busyAction !== null}
            onPress={handleEnableRadar}
            style={({ pressed }) => [
              styles.primaryButtonWrap,
              pressed && busyAction === null ? styles.primaryButtonPressed : null,
            ]}
          >
            <View style={styles.primaryGlow} pointerEvents="none" />
            <BlurView intensity={Platform.OS === "ios" ? 38 : 0} tint="light" style={styles.primaryButton}>
              {busyAction === "primary" ? (
                <ActivityIndicator color="#13061D" />
              ) : (
                <Text style={styles.primaryButtonText}>Включить радар</Text>
              )}
            </BlurView>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Я готов пропустить свой мэтч"
            disabled={busyAction !== null}
            onPress={handleSkip}
            style={({ pressed }) => [
              styles.secondaryButton,
              pressed && busyAction === null ? styles.secondaryButtonPressed : null,
            ]}
          >
            {busyAction === "secondary" ? (
              <ActivityIndicator color={COLORS.textMuted} />
            ) : (
              <Text style={styles.secondaryButtonText}>Я готов пропустить свой мэтч</Text>
            )}
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  screen: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 20,
    backgroundColor: COLORS.background,
  },
  topGlow: {
    position: "absolute",
    top: 60,
    right: -50,
    width: 180,
    height: 180,
    borderRadius: 90,
    backgroundColor: COLORS.accentGlow,
    opacity: 0.22,
  },
  bottomGlow: {
    position: "absolute",
    bottom: 140,
    left: -70,
    width: 220,
    height: 220,
    borderRadius: 110,
    backgroundColor: COLORS.accentGlow,
    opacity: 0.16,
  },
  header: {
    paddingTop: 8,
  },
  eyebrow: {
    color: COLORS.accent,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 1.4,
    textTransform: "uppercase",
    marginBottom: 14,
  },
  title: {
    color: COLORS.text,
    fontSize: 32,
    lineHeight: 36,
    fontWeight: "800",
    letterSpacing: -0.8,
  },
  subtitle: {
    marginTop: 12,
    color: COLORS.textMuted,
    fontSize: 15,
    lineHeight: 22,
    maxWidth: 320,
  },
  centerStage: {
    flex: 1,
    justifyContent: "center",
    minHeight: 240,
  },
  notificationWrapper: {
    position: "relative",
    alignSelf: "center",
    width: "100%",
    maxWidth: 340,
  },
  notificationGlow: {
    position: "absolute",
    top: 6,
    left: 18,
    right: 18,
    bottom: -8,
    borderRadius: 28,
    backgroundColor: COLORS.accentGlow,
    opacity: 0.22,
    shadowColor: COLORS.accentGlow,
    shadowOpacity: 0.55,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 10 },
    elevation: 0,
  },
  notificationCard: {
    borderRadius: 24,
    paddingHorizontal: 18,
    paddingVertical: 16,
    backgroundColor: COLORS.cardStrong,
    borderWidth: 1,
    borderColor: COLORS.border,
    overflow: "hidden",
  },
  notificationTopRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 14,
  },
  notificationBadge: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "rgba(230, 230, 250, 0.14)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(230, 230, 250, 0.22)",
  },
  notificationBadgeText: {
    color: COLORS.accent,
    fontSize: 16,
    fontWeight: "700",
  },
  notificationMeta: {
    marginLeft: 12,
    flexDirection: "row",
    flex: 1,
    justifyContent: "space-between",
    alignItems: "center",
  },
  notificationApp: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: "700",
  },
  notificationTime: {
    color: COLORS.textMuted,
    fontSize: 13,
    fontWeight: "500",
  },
  notificationBody: {
    color: COLORS.text,
    fontSize: 17,
    lineHeight: 24,
    fontWeight: "600",
  },
  bentoGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    marginBottom: 22,
  },
  bentoCard: {
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    overflow: "hidden",
    minHeight: 94,
    marginBottom: 12,
  },
  bentoHalf: {
    width: "48.4%",
  },
  bentoWide: {
    width: "100%",
  },
  bentoIndex: {
    color: COLORS.accent,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1.2,
    marginBottom: 10,
  },
  bentoText: {
    color: COLORS.text,
    fontSize: 15,
    lineHeight: 20,
    fontWeight: "600",
  },
  footer: {
    marginTop: "auto",
  },
  primaryButtonWrap: {
    position: "relative",
    marginBottom: 12,
  },
  primaryGlow: {
    position: "absolute",
    top: 6,
    left: 18,
    right: 18,
    bottom: -6,
    borderRadius: 22,
    backgroundColor: COLORS.accentGlow,
    opacity: 0.3,
    shadowColor: COLORS.accentGlow,
    shadowOpacity: 0.6,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 10 },
    elevation: 0,
  },
  primaryButton: {
    minHeight: 58,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: COLORS.accent,
    overflow: "hidden",
  },
  primaryButtonPressed: {
    opacity: 0.92,
    transform: [{ scale: 0.995 }],
  },
  primaryButtonText: {
    color: "#13061D",
    fontSize: 16,
    fontWeight: "800",
    letterSpacing: 0.2,
  },
  secondaryButton: {
    minHeight: 46,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: COLORS.secondary,
    opacity: 0.48,
  },
  secondaryButtonPressed: {
    opacity: 0.62,
  },
  secondaryButtonText: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: "600",
  },
});
