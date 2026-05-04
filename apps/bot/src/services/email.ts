import { env } from "../config.js";

export async function sendOtpEmail(to: string, otp: string): Promise<void> {
  // Local dev: log the code instead of calling Resend. Triggers when no key
  // is configured, or when OTP_LOG_TO_CONSOLE=true is set explicitly (handy
  // when .env shares SMTP_PASS with prod but the dev sender domain isn't
  // verified in Resend). Prod has the key set and the flag unset.
  if (env.OTP_LOG_TO_CONSOLE || !env.RESEND_API_KEY) {
    console.log(`[otp:dev] code for ${to}: ${otp}`);
    return;
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
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend API error ${res.status}: ${body}`);
  }
}
