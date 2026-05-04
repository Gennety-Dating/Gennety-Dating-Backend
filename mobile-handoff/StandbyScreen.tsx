/**
 * Gennety "Standby Mode" screen — drop into the Expo mobile app.
 *
 * This repo does not ship the actual React Native app yet, so this file lives
 * in `mobile-handoff/` as a copy-ready reference for the mobile codebase.
 *
 * Expected backend contract:
 *   1. `GET /v1/matches/current` returns `null`
 *   2. `GET /v1/countdown` returns:
 *        {
 *          weeklyStatus: "standby",
 *          standbyCount: number,
 *          priorityBoosted: true,
 *          nextDropAt: string
 *        }
 *
 * Route the user here only when both conditions are true. If there is an
 * active match, the match flow wins over standby.
 *
 * Required peer deps in the Expo app:
 *   - react-native
 *   - nativewind
 *   - react-native-reanimated
 *   - expo-linear-gradient
 */

import React, { useEffect } from "react";
import { Pressable, SafeAreaView, Text, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";

const ACCENT = "#B69AE5";

export interface StandbyScreenProps {
  nextDropLabel: string;
  standbyCount: number;
  onContinue?: () => void;
}

export function StandbyScreen({
  nextDropLabel,
  standbyCount,
  onContinue,
}: StandbyScreenProps): React.JSX.Element {
  const scale = useSharedValue(1);
  const glow = useSharedValue(0.72);
  const shimmer = useSharedValue(-12);

  useEffect(() => {
    scale.value = withRepeat(
      withSequence(
        withTiming(1.06, {
          duration: 4000,
          easing: Easing.inOut(Easing.sin),
        }),
        withTiming(1, {
          duration: 4000,
          easing: Easing.inOut(Easing.sin),
        }),
      ),
      -1,
      false,
    );

    glow.value = withRepeat(
      withSequence(
        withTiming(0.95, {
          duration: 4000,
          easing: Easing.inOut(Easing.quad),
        }),
        withTiming(0.72, {
          duration: 4000,
          easing: Easing.inOut(Easing.quad),
        }),
      ),
      -1,
      false,
    );

    shimmer.value = withRepeat(
      withSequence(
        withTiming(12, {
          duration: 4000,
          easing: Easing.inOut(Easing.sin),
        }),
        withTiming(-12, {
          duration: 4000,
          easing: Easing.inOut(Easing.sin),
        }),
      ),
      -1,
      false,
    );
  }, [glow, scale, shimmer]);

  const orbStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const outerGlowStyle = useAnimatedStyle(() => ({
    opacity: glow.value,
    transform: [{ scale: 0.96 + glow.value * 0.08 }],
  }));

  const shimmerStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: shimmer.value },
      { rotate: "18deg" },
    ],
  }));

  return (
    <SafeAreaView className="flex-1 bg-black">
      <LinearGradient
        colors={["#0a0f1d", "#05060d", "#000000"]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        className="flex-1"
      >
        <View className="flex-1 px-6 pb-8 pt-6">
          <View className="items-center pt-6">
            <Text
              className="text-[12px] font-semibold uppercase tracking-[3.2px]"
              style={{ color: "rgba(182, 154, 229, 0.88)" }}
            >
              Gennety Orbit
            </Text>
            <Text className="mt-4 text-center text-[34px] font-semibold leading-[40px] text-white">
              STATUS: STANDBY
            </Text>
            <Text className="mt-4 max-w-[320px] text-center text-[16px] leading-[24px] text-[#c8d0e6]">
              We do not compromise on quality. This week did not clear our
              synergy bar, so your priority has been boosted for the next drop.
            </Text>
          </View>

          <View className="flex-1 items-center justify-center">
            <View className="items-center justify-center">
              <Animated.View
                className="absolute h-[270px] w-[270px] rounded-full"
                style={[
                  {
                    backgroundColor: "rgba(182, 154, 229, 0.22)",
                    shadowColor: ACCENT,
                    shadowOpacity: 0.55,
                    shadowRadius: 40,
                    shadowOffset: { width: 0, height: 0 },
                  },
                  outerGlowStyle,
                ]}
              />

              <Animated.View
                className="h-[208px] w-[208px] items-center justify-center overflow-hidden rounded-full border"
                style={[
                  {
                    borderColor: "rgba(255,255,255,0.18)",
                    backgroundColor: "rgba(255,255,255,0.08)",
                  },
                  orbStyle,
                ]}
              >
                <LinearGradient
                  colors={[
                    "rgba(255,255,255,0.28)",
                    "rgba(182,154,229,0.32)",
                    "rgba(92,120,255,0.14)",
                    "rgba(255,255,255,0.06)",
                  ]}
                  start={{ x: 0.18, y: 0.08 }}
                  end={{ x: 0.8, y: 1 }}
                  className="absolute inset-0"
                />

                <Animated.View
                  className="absolute top-6 h-20 w-24 rounded-full"
                  style={[
                    {
                      backgroundColor: "rgba(255,255,255,0.18)",
                    },
                    shimmerStyle,
                  ]}
                />

                <View
                  className="h-[132px] w-[132px] rounded-full border"
                  style={{
                    borderColor: "rgba(255,255,255,0.22)",
                    backgroundColor: "rgba(12,15,28,0.2)",
                  }}
                />
              </Animated.View>
            </View>
          </View>

          <View
            className="rounded-[28px] border px-5 py-5"
            style={{
              borderColor: "rgba(182, 154, 229, 0.24)",
              backgroundColor: "rgba(255,255,255,0.05)",
            }}
          >
            <View className="flex-row items-end justify-between">
              <View className="flex-1 pr-4">
                <Text className="text-[12px] uppercase tracking-[2.8px] text-[#9d88c6]">
                  Priority Boost
                </Text>
                <Text className="mt-2 text-[24px] font-semibold text-white">
                  Week +{standbyCount}
                </Text>
              </View>

              <View className="items-end">
                <Text className="text-[12px] uppercase tracking-[2.8px] text-[#9d88c6]">
                  Next Drop
                </Text>
                <Text className="mt-2 text-right text-[15px] leading-[21px] text-[#e8defc]">
                  {nextDropLabel}
                </Text>
              </View>
            </View>

            <View
              className="mt-4 rounded-[20px] px-4 py-4"
              style={{ backgroundColor: "rgba(182, 154, 229, 0.1)" }}
            >
              <Text className="text-[15px] leading-[22px] text-[#efe8ff]">
                Quality over compromise. We would rather hold the line than send
                you into a weak match.
              </Text>
            </View>
          </View>

          {onContinue ? (
            <Pressable
              onPress={onContinue}
              className="mt-5 items-center rounded-[22px] px-5 py-4"
              style={{ backgroundColor: ACCENT }}
            >
              <Text className="text-[15px] font-semibold text-[#100a19]">
                Stay in orbit
              </Text>
            </Pressable>
          ) : null}
        </View>
      </LinearGradient>
    </SafeAreaView>
  );
}
