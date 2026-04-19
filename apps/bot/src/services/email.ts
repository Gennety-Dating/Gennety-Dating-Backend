import { env } from "../config.js";

export async function sendOtpEmail(to: string, otp: string): Promise<void> {
  // Local dev: when no Resend key is configured, log the code instead of
  // throwing. Keeps `pnpm dev:bot` usable against a real DB without
  // wiring a real email provider. Prod has `RESEND_API_KEY` set.
  if (!env.RESEND_API_KEY) {
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
