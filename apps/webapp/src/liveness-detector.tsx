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
  /**
   * @param state  Amplify's coarse `LivenessErrorState` label.
   * @param detail The underlying exception + a snapshot of what this WebView can
   *               actually do. `RUNTIME_ERROR` alone is undebuggable in the
   *               field, and Telegram's WebView is where these surface.
   */
  onError: (state: string, detail: string) => void;
}

/**
 * What the embedded browser can actually do. The detector needs `getUserMedia`,
 * a `MediaRecorder` that can encode one of a few specific codecs, and a secure
 * context — and Telegram's WebView does not always provide all three. Capturing
 * this alongside the exception turns an unreproducible field report into a
 * one-line diagnosis.
 */
function describeMediaSupport(): string {
  const parts: string[] = [];
  const rec = (globalThis as { MediaRecorder?: { isTypeSupported?: (t: string) => boolean } })
    .MediaRecorder;
  parts.push(`secureContext=${globalThis.isSecureContext}`);
  parts.push(`getUserMedia=${Boolean(navigator?.mediaDevices?.getUserMedia)}`);
  parts.push(`MediaRecorder=${Boolean(rec)}`);
  if (rec?.isTypeSupported) {
    const codecs = [
      "video/webm;codecs=vp8",
      "video/webm;codecs=vp9",
      "video/mp4;codecs=avc1.42E01E",
      "video/mp4",
    ];
    parts.push(
      `codecs=[${codecs.filter((c) => rec.isTypeSupported!(c)).join(", ") || "NONE"}]`,
    );
  }
  parts.push(`wasm=${typeof WebAssembly !== "undefined"}`);
  parts.push(`ua=${navigator?.userAgent ?? "?"}`);
  return parts.join(" | ");
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
          const state = typeof error?.state === "string" ? error.state : "liveness error";
          const inner = error?.error;
          const detail = [
            inner?.message ? `msg=${inner.message}` : "msg=(none)",
            inner?.stack ? `stack=${inner.stack.split("\n").slice(0, 4).join(" ⏎ ")}` : "",
            describeMediaSupport(),
          ]
            .filter(Boolean)
            .join(" || ");
          options.onError(state, detail);
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
