import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FaceLivenessDetectorCore } from "@aws-amplify/ui-react-liveness";
import "@aws-amplify/ui-react/styles.css";
import type { LivenessCredentials } from "./api.js";

/**
 * The one React island in the Verification Mini App.
 *
 * The detector owns the camera surface, the oval overlay, the light challenge
 * and the SigV4-signed WebSocket to Rekognition — the selfie video goes
 * device → AWS and never passes through our server. Everything around it
 * (loading/error/success screens, Telegram lifecycle) stays vanilla in
 * `verification.ts`; only this needs React, so only this pulls it in.
 *
 * Note it is `FaceLivenessDetectorCore`, not `FaceLivenessDetector`: the plain
 * component's config type deliberately omits `credentialProvider` because it
 * assumes Amplify Auth (a Cognito Identity Pool). We don't have one and don't
 * want one — our clients are already authenticated, so the server mints
 * short-lived, single-action credentials behind the Telegram initData boundary
 * and hands them over here. Core is the variant that accepts them.
 *
 * Amplify calls the provider exactly once at the start of the flow and never
 * refreshes, which is why a 15-minute TTL is ample for a 3-minute session.
 */

export interface LivenessDetectorOptions {
  sessionId: string;
  region: string;
  credentials: LivenessCredentials;
  /** Capture finished. The verdict is read server-side, not here. */
  onComplete: () => void;
  /** User backed out of the detector. */
  onCancel: () => void;
  onError: (message: string) => void;
}

let root: Root | null = null;

/**
 * Mount the detector into `container`. Idempotent: a second call replaces the
 * previous tree rather than stacking two camera surfaces (a liveness session is
 * single-use, so a stacked mount would be a guaranteed failure).
 */
export function mountLivenessDetector(
  container: HTMLElement,
  options: LivenessDetectorOptions,
): void {
  unmountLivenessDetector();
  root = createRoot(container);
  root.render(
    <StrictMode>
      <FaceLivenessDetectorCore
        sessionId={options.sessionId}
        region={options.region}
        onAnalysisComplete={async () => {
          options.onComplete();
        }}
        onUserCancel={() => options.onCancel()}
        onError={(error) => {
          options.onError(
            typeof error?.state === "string" ? error.state : "liveness error",
          );
        }}
        // The Get Ready screen is deliberately NOT disabled. It is tempting to
        // skip (the bot's CTA already explained the step), but it also carries
        // AWS's photosensitivity warning before the light challenge starts
        // flashing colours, and it puts the camera permission prompt behind an
        // explicit tap. Neither is ours to drop.
        config={{
          credentialProvider: async () => ({
            accessKeyId: options.credentials.accessKeyId,
            secretAccessKey: options.credentials.secretAccessKey,
            sessionToken: options.credentials.sessionToken,
            expiration: new Date(options.credentials.expiration),
          }),
        }}
      />
    </StrictMode>,
  );
}

export function unmountLivenessDetector(): void {
  root?.unmount();
  root = null;
}
