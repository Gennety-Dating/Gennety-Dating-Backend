import { env } from "../config.js";

/** Hard timeout for the Resend REST call — Node `fetch` has none by default,
 * so a stalled provider would hang the OTP request handler forever (audit M1). */
const EMAIL_TIMEOUT_MS = 15_000;

export async function sendOtpEmail(to: string, otp: string): Promise<void> {
  // Local dev: log the code instead of calling Resend. Triggers when no key
  // is configured, or when OTP_LOG_TO_CONSOLE=true is set explicitly (handy
  // when .env shares SMTP_PASS with prod but the dev sender domain isn't
  // verified in Resend). Prod has the key set and the flag unset.
  // Printing the code is a DEVELOPMENT affordance and nothing else, so it needs
  // the explicit flag — and only the flag.
  //
  // It used to fire on `|| !env.RESEND_API_KEY` as well, which turned a missing
  // mail key into "print every registration code to stdout and send nothing".
  // Two failures wearing one face: the codes leak (access to logs becomes the
  // email gate, and that gate is a trust boundary here) and registration
  // degrades in silence. `assertIdentityTrustConfiguration` now refuses to
  // start production without the key, so reaching this branch means a
  // development runtime that did not ask for console codes — and there the
  // honest answer is to fail loudly rather than pretend a code was sent.
  if (env.OTP_LOG_TO_CONSOLE) {
    console.log(`[otp:dev] code for ${to}: ${otp}`);
    return;
  }
  if (!env.RESEND_API_KEY) {
    throw new Error(
      "sendOtpEmail: RESEND_API_KEY is empty — refusing to print the code instead of sending it",
    );
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `Gennety Dating <${env.SMTP_FROM}>`,
      to: [to],
      subject: "Your Gennety verification code",
      text: `Your verification code is: ${otp}\n\nThis code expires in 10 minutes.`,
      html: `<p>Your verification code is: <strong>${otp}</strong></p><p>This code expires in 10 minutes.</p>`,
    }),
    signal: AbortSignal.timeout(EMAIL_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend API error ${res.status}: ${body}`);
  }
}
