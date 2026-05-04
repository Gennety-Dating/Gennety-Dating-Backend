/**
 * Gennety "AI Synergy Score" card — drop into the Expo mobile app.
 *
 * This file is NOT compiled or consumed by the backend monorepo (no
 * `react-native` / `expo-blur` deps here). It lives in the backend repo
 * only as the canonical reference the mobile project copies into its
 * own tree, next to the `SerializedMatch.synergyScore` /
 * `SerializedMatch.synergyReason` contract it renders.
 *
 * Placement:
 *   - Match Reveal screen (status `proposed`): render between the pitch
 *     and the Accept/Decline buttons.
 *   - Upcoming Date screen (status `scheduled`): render above the venue
 *     card, below the Wingman card if both are present.
 *   The component returns `null` when `score == null`, so callers don't
 *   need to wrap it in their own conditional.
 *
 * Design: glassmorphism wrapper matching `WingmanCard.tsx` (BlurView,
 * accent border, soft purple halo). The metric is a large glowing
 * number + thin animated horizontal bar — not a circular meter, to
 * keep peer deps to `react-native` + `expo-blur` only (no SVG).
 *
 * Required peer deps in the Expo app:
 *   - react-native
 *   - expo-blur (for the real-glass effect on iOS; Android degrades
 *     gracefully to the translucent background color)
 */

import React, { useEffect, useMemo, useRef } from "react";
import {
  Animated,
  Easing,
  Platform,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from "react-native";
import { BlurView } from "expo-blur";

const ACCENT = "#B69AE5";
const ACCENT_SOFT = "rgba(182, 154, 229, 0.18)";
const ACCENT_BORDER = "rgba(182, 154, 229, 0.45)";
const TRACK = "rgba(182, 154, 229, 0.22)";

/**
 * Hard product invariants — kept in sync with `SYNERGY_MIN`/`SYNERGY_MAX`
 * in `apps/bot/src/services/pitch-generator.ts`. The backend already
 * clamps before persisting; we re-clamp client-side as defense in
 * depth so a stale cache or a hand-edited row can't break the visual.
 */
const VISUAL_MIN = 70;
const VISUAL_MAX = 99;

export interface SynergyScoreCardProps {
  /**
   * Pair-level synergy score (70..99), or `null` before the backend has
   * generated one. When null, this component renders nothing — callers
   * don't need to wrap it in their own conditional.
   */
  score: number | null;
  /**
   * Positive 1–2 sentence justification in the user's language. When
   * empty/null the reason line is omitted but the score is still shown.
   */
  reason: string | null;
  /** Optional style override on the outer wrapper (margin etc.). */
  style?: ViewStyle;
}

export function SynergyScoreCard({
  score,
  reason,
  style,
}: SynergyScoreCardProps): React.JSX.Element | null {
  const fade = useRef(new Animated.Value(0)).current;
  const translate = useRef(new Animated.Value(8)).current;
  const barProgress = useRef(new Animated.Value(0)).current;

  const clamped = useMemo(() => {
    if (score == null || !Number.isFinite(score)) return null;
    return Math.max(VISUAL_MIN, Math.min(VISUAL_MAX, Math.round(score)));
  }, [score]);

  useEffect(() => {
    if (clamped == null) return;
    Animated.parallel([
      Animated.timing(fade, {
        toValue: 1,
        duration: 480,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(translate, {
        toValue: 0,
        duration: 520,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      // Bar progress can't share native driver with width; run it on JS.
      Animated.timing(barProgress, {
        toValue: clamped / 100,
        duration: 720,
        delay: 120,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: false,
      }),
    ]).start();
  }, [clamped, fade, translate, barProgress]);

  if (clamped == null) return null;

  const barWidth = barProgress.interpolate({
    inputRange: [0, 1],
    outputRange: ["0%", "100%"],
  });

  return (
    <Animated.View
      style={[
        styles.wrapper,
        style,
        { opacity: fade, transform: [{ translateY: translate }] },
      ]}
    >
      {/* Purple glow — layered behind the card. */}
      <View style={styles.glow} pointerEvents="none" />

      <BlurView
        intensity={Platform.OS === "ios" ? 30 : 0}
        tint="light"
        style={styles.card}
      >
        <View style={styles.eyebrowRow}>
          <View style={styles.sparkle} />
          <Text style={styles.eyebrow}>AI SYNERGY</Text>
        </View>

        <View style={styles.metricRow}>
          <Text style={styles.metric}>{clamped}</Text>
          <Text style={styles.metricSuffix}>%</Text>
        </View>

        <View style={styles.barTrack}>
          <Animated.View style={[styles.barFill, { width: barWidth }]} />
        </View>

        {reason ? <Text style={styles.reason}>{reason}</Text> : null}
      </BlurView>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    position: "relative",
    marginVertical: 12,
  },
  glow: {
    position: "absolute",
    top: -8,
    left: -8,
    right: -8,
    bottom: -8,
    borderRadius: 28,
    backgroundColor: ACCENT,
    opacity: 0.18,
    shadowColor: ACCENT,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.45,
    shadowRadius: 24,
    elevation: 0,
  },
  card: {
    borderRadius: 20,
    paddingHorizontal: 20,
    paddingVertical: 18,
    backgroundColor: ACCENT_SOFT,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ACCENT_BORDER,
    overflow: "hidden",
  },
  eyebrowRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 8,
  },
  sparkle: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: ACCENT,
    marginRight: 8,
    shadowColor: ACCENT,
    shadowOpacity: 0.8,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 0 },
  },
  eyebrow: {
    color: ACCENT,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1.4,
  },
  metricRow: {
    flexDirection: "row",
    alignItems: "baseline",
  },
  metric: {
    color: ACCENT,
    fontSize: 56,
    fontWeight: "700",
    letterSpacing: -1.5,
    // The glow is layered via shadow on iOS; Android still reads as a
    // crisp accent-colored numeral.
    textShadowColor: ACCENT,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 16,
  },
  metricSuffix: {
    color: ACCENT,
    fontSize: 24,
    fontWeight: "600",
    marginLeft: 4,
    opacity: 0.85,
  },
  barTrack: {
    marginTop: 10,
    height: 3,
    borderRadius: 2,
    backgroundColor: TRACK,
    overflow: "hidden",
  },
  barFill: {
    height: "100%",
    backgroundColor: ACCENT,
    borderRadius: 2,
    shadowColor: ACCENT,
    shadowOpacity: 0.7,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 0 },
  },
  reason: {
    marginTop: 12,
    color: "#6B5B8C",
    fontSize: 13,
    lineHeight: 18,
    fontStyle: "italic",
  },
});
