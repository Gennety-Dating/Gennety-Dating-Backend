/**
 * Example integration for the pre-permission notifications screen.
 *
 * Insert `NotificationsPrePermission` into the onboarding stack right after
 * the final profile-review screen and right before the next mandatory
 * onboarding step.
 *
 * This example uses React Navigation's native stack and keeps logging / token
 * registration injectable so the real Expo app can wire its own analytics and
 * API client without rewriting the screen component.
 */

import React from "react";
import { createNativeStackNavigator, type NativeStackScreenProps } from "@react-navigation/native-stack";
import { Text, View } from "react-native";
import {
  NotificationPrePermissionScreen,
  type NotificationPermissionResult,
  type RegisteredPushToken,
  type UserGender,
} from "./NotificationPrePermissionScreen";

export type OnboardingStackParamList = {
  ProfileReview: { userGender: UserGender };
  NotificationsPrePermission: { userGender: UserGender };
  VerificationIntro: undefined;
};

interface OnboardingNavigatorProps {
  expoProjectId?: string;
  registerPushToken?: (input: RegisteredPushToken) => Promise<void>;
  logEvent?: (name: string, params?: Record<string, unknown>) => Promise<void> | void;
}

const Stack = createNativeStackNavigator<OnboardingStackParamList>();

export function OnboardingNavigator({
  expoProjectId,
  registerPushToken,
  logEvent,
}: OnboardingNavigatorProps): React.JSX.Element {
  return (
    <Stack.Navigator
      initialRouteName="ProfileReview"
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: "#050507" },
      }}
    >
      <Stack.Screen name="ProfileReview" component={ProfileReviewScreen} />

      <Stack.Screen name="NotificationsPrePermission">
        {(props) => (
          <NotificationsPrePermissionRoute
            {...props}
            expoProjectId={expoProjectId}
            registerPushToken={registerPushToken}
            logEvent={logEvent}
          />
        )}
      </Stack.Screen>

      <Stack.Screen name="VerificationIntro" component={VerificationIntroScreen} />
    </Stack.Navigator>
  );
}

interface NotificationsPrePermissionRouteExtraProps {
  expoProjectId?: string;
  registerPushToken?: (input: RegisteredPushToken) => Promise<void>;
  logEvent?: (name: string, params?: Record<string, unknown>) => Promise<void> | void;
}

function NotificationsPrePermissionRoute({
  navigation,
  route,
  expoProjectId,
  registerPushToken,
  logEvent,
}: NativeStackScreenProps<OnboardingStackParamList, "NotificationsPrePermission"> &
  NotificationsPrePermissionRouteExtraProps): React.JSX.Element {
  async function handlePermissionResolved(result: NotificationPermissionResult): Promise<void> {
    await logEvent?.("onboarding_notifications_permission_resolved", {
      userGender: route.params.userGender,
      status: result.status,
      granted: result.granted,
      canAskAgain: result.canAskAgain,
      tokenRegistered: Boolean(result.pushToken),
      tokenRegistrationFailed: Boolean(result.registrationError),
    });

    navigation.replace("VerificationIntro");
  }

  async function handleSkip(): Promise<void> {
    await logEvent?.("onboarding_notifications_permission_skipped", {
      userGender: route.params.userGender,
    });

    navigation.replace("VerificationIntro");
  }

  return (
    <NotificationPrePermissionScreen
      userGender={route.params.userGender}
      expoProjectId={expoProjectId}
      registerPushToken={registerPushToken}
      onPermissionResolved={handlePermissionResolved}
      onSkip={handleSkip}
    />
  );
}

/**
 * Replace this screen with your real post-review step. The important part is
 * the navigation call that inserts the pre-permission screen into the linear
 * onboarding flow.
 */
function ProfileReviewScreen({
  navigation,
  route,
}: NativeStackScreenProps<OnboardingStackParamList, "ProfileReview">): React.JSX.Element {
  React.useEffect(() => {
    navigation.replace("NotificationsPrePermission", {
      userGender: route.params.userGender,
    });
  }, [navigation, route.params.userGender]);

  return (
    <View style={styles.placeholder}>
      <Text style={styles.placeholderText}>Profile review placeholder</Text>
    </View>
  );
}

function VerificationIntroScreen(): React.JSX.Element {
  return (
    <View style={styles.placeholder}>
      <Text style={styles.placeholderText}>Next onboarding screen placeholder</Text>
    </View>
  );
}

const styles = {
  placeholder: {
    flex: 1,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    backgroundColor: "#050507",
  },
  placeholderText: {
    color: "#F8F4FF",
    fontSize: 18,
    fontWeight: "600" as const,
  },
};
