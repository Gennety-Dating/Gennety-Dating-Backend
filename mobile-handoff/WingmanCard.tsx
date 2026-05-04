/**
 * Gennety "Wingman" insider-tip card — drop into the Expo mobile app.
 *
 * This file is NOT compiled or consumed by the backend monorepo (no
 * `react-native` / `expo-blur` deps here). It lives in the backend repo
 * only as the canonical reference the mobile project copies into its
 * own tree, next to the `SerializedMatch.wingmanHint` contract it
 * renders.
 *
 * Placement:
 *   On the Upcoming Date screen, render above the venue card when
 *   `match.status === "scheduled"` and `match.wingmanHint !== null`.
 *   The backend gate (T-1h from `agreedTime`) keeps `wingmanHint`
 *   null before the reveal window, so the card simply disappears
 *   until the hour ticks over.
 *
 * Design: sleek glassmorphism with #B69AE5 accents, subtle purple glow,
 * soft fade-in once `hint` flips from null → string. No tap actions and
 * no share affordance — the tip is a Zero-Chat private nudge, not
 * forwardable content.
 *
 * Required peer deps in the Expo app:
 *   - react-native
 *   - expo-blur (for the real-glass effect on iOS; Android degrades
 *     gracefully to the translucent background color)
 */

import React, { useEffect, useRef } from "react";
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

export interface WingmanCardProps {
  /**
   * The viewer's personalised hint, or `null` before the T-1h reveal.
   * When null, this component renders nothing — callers don't need to
   * wrap it in their own conditional.
   */
  hint: string | null;
  /** ISO-8601 `agreedTime` from `SerializedMatch.agreedTime`. */
  agreedTime: string;
  /** Partner's first name, for the "just between us" footer. */
  partnerFirstName: string | null;
  /** Optional style override on the outer wrapper (margin etc.). */
  style?: ViewStyle;
}

/**
 * `expo-blur` `BlurView` delivers the actual frosted-glass on iOS. On
 * Android it falls back to a semi-transparent solid, which is what we
 * want — we layer a translucent fill over a matching radius so both
 * platforms look like the same component family.
 */
export function WingmanCard({
  hint,
  agreedTime,
  partnerFirstName,
  style,
}: WingmanCardProps): React.JSX.Element | null {
  const fade = useRef(new Animated.Value(0)).current;
  const translate = useRef(new Animated.Value(8)).current;

  useEffect(() => {
    if (!hint) return;
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
    ]).start();
  }, [hint, fade, translate]);

  if (!hint) return null;

  const footerName = partnerFirstName ?? "they";
  const agreedDate = new Date(agreedTime);
  const revealedHint = Number.isNaN(agreedDate.getTime())
    ? "Revealed 1h before the date"
    : `Revealed ${formatRelativeToNow(agreedDate)}`;

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
          <Text style={styles.eyebrow}>SECRET INSIGHT</Text>
        </View>

        <Text style={styles.body}>{hint}</Text>

        <Text style={styles.footer}>
          {`Just between us — ${footerName} doesn't see this.`}
        </Text>

        <Text style={styles.timestamp}>{revealedHint}</Text>
      </BlurView>
    </Animated.View>
  );
}

function formatRelativeToNow(target: Date): string {
  const diffMs = target.getTime() - Date.now();
  const diffMin = Math.round(diffMs / 60_000);
  if (diffMin <= 0) return "now";
  if (diffMin < 60) return `${diffMin} min before the date`;
  const hours = Math.round(diffMin / 60);
  return `${hours}h before the date`;
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
    // iOS renders the soft purple halo from this shadow; Android keeps
    // the flat translucent fill, which still reads as a gentle glow.
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
    marginBottom: 10,
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
  body: {
    color: "#1B1333",
    fontSize: 17,
    lineHeight: 24,
    fontWeight: "500",
  },
  footer: {
    marginTop: 12,
    color: "#6B5B8C",
    fontSize: 12,
    lineHeight: 16,
  },
  timestamp: {
    marginTop: 4,
    color: "#8A7AAE",
    fontSize: 11,
    letterSpacing: 0.3,
  },
});
