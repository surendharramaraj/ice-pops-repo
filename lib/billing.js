"use strict";
// Subscriptions: trial, plan limits, and payment through Razorpay.
//
// BILLING_MODE=test      Choosing a plan activates it for a month without payment.
//                        The default when no Razorpay keys are set. Never use it live.
// BILLING_MODE=razorpay  Real payments. Needs RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET,
//                        RAZORPAY_WEBHOOK_SECRET, and razorpay_plan_id set on each plan.

const crypto = require("crypto");

const TRIAL_DAYS = 14;
const GRACE_DAYS = 3; // keep selling for a few days after a failed renewal
const DAY = 86400000;

const RZP = {
  keyId: process.env.RAZORPAY_KEY_ID || "",
  secret: process.env.RAZORPAY_KEY_SECRET || "",
  webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || ""
};
const MODE = process.env.BILLING_MODE || (RZP.keyId ? "razorpay" : "test");

function checkConfig() {
  if (MODE !== "test" && MODE !== "razorpay") throw new Error(`BILLING_MODE must be "test" or "razorpay", not "${MODE}".`);
  if (MODE === "razorpay" && (!RZP.keyId || !RZP.secret || !RZP.webhookSecret)) {
    throw new Error("BILLING_MODE=razorpay needs RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET.");
  }
}

// Whether the business may sell and change stock right now, and what to tell them.
function accessState(sub, now = new Date()) {
  if (!sub || !sub.status) return { ok: false, state: "none", message: "Choose a plan on the Account page to start billing." };
  const t = now.getTime();
  if (sub.status === "trialing") {
    const end = new Date(sub.trial_ends_at).getTime();
    if (end > t) return { ok: true, state: "trial", daysLeft: Math.ceil((end - t) / DAY), endsAt: sub.trial_ends_at };
    return { ok: false, state: "trial_ended", message: "Your free trial has ended. Choose a plan on the Account page to keep billing." };
  }
  const end = sub.current_period_end ? new Date(sub.current_period_end).getTime() : 0;
  const grace = sub.status === "cancelled" || sub.cancel_at_period_end ? 0 : GRACE_DAYS * DAY;
  if (end + grace > t) {
    return { ok: true, state: sub.status, endsAt: sub.current_period_end, inGrace: end <= t, cancelling: !!sub.cancel_at_period_end };
  }
  return {
    ok: false,
    state: "expired",
    message: sub.status === "past_due"
      ? "Your last payment didn't go through. Pay on the Account page to keep billing."
      : "Your subscription has ended. Choose a plan on the Account page to keep billing."
  };
}

// ---------- Razorpay ----------

async function razorpay(method, path, body) {
  const res = await fetch(`https://api.razorpay.com/v1${path}`, {
    method,
    headers: {
      Authorization: "Basic " + Buffer.from(`${RZP.keyId}:${RZP.secret}`).toString("base64"),
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(`Razorpay refused the request: ${(data.error && data.error.description) || res.status}`);
    e.status = 502;
    throw e;
  }
  return data;
}

const hmac = (secret, text) => crypto.createHmac("sha256", secret).update(text).digest("hex");
function safeEqual(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Signature Razorpay Checkout returns after the first payment.
function checkoutSignatureValid({ razorpay_payment_id, razorpay_subscription_id, razorpay_signature }) {
  return safeEqual(hmac(RZP.secret, `${razorpay_payment_id}|${razorpay_subscription_id}`), razorpay_signature);
}

// Signature on webhook calls, over the raw request body.
function webhookSignatureValid(rawBody, signature) {
  return !!RZP.webhookSecret && safeEqual(hmac(RZP.webhookSecret, rawBody), signature);
}

module.exports = {
  MODE, RZP, TRIAL_DAYS, GRACE_DAYS, checkConfig, accessState, razorpay,
  checkoutSignatureValid, webhookSignatureValid
};
