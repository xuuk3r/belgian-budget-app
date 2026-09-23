/**
 * GoCardless Bank Account Data integration (PSD2 AISP).
 * Docs: https://developer.gocardless.com/bank-account-data/
 *
 * Handles: access-token management, requisition creation (bank connect flow),
 * account discovery, and transaction sync with idempotent upserts.
 */
import crypto from "node:crypto";
import { env } from "../config/env.js";
import { pool } from "../db/pool.js";

const GC_BASE = env.gocardless.baseUrl;

// ---------- App-level access token (separate from the per-user bank consent) ----------

let cachedAppToken: { token: string; expiresAt: number } | null = null;

async function getAppAccessToken(): Promise<string> {
  if (cachedAppToken && cachedAppToken.expiresAt > Date.now()) {
    return cachedAppToken.token;
  }
  const res = await fetch(`${GC_BASE}/token/new/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      secret_id: env.gocardless.secretId,
      secret_key: env.gocardless.secretKey,
    }),
  });
  if (!res.ok) throw new Error(`GoCardless auth failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { access: string; access_expires: number };
  cachedAppToken = { token: data.access, expiresAt: Date.now() + (data.access_expires - 60) * 1000 };
  return cachedAppToken.token;
}

async function gcFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await getAppAccessToken();
  const res = await fetch(`${GC_BASE}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) throw new Error(`GoCardless API error on ${path}: ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

// ---------- Token encryption at rest ----------

function encrypt(plainText: string): string {
  const key = Buffer.from(env.tokenEncryptionKey, "hex");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function decrypt(payload: string): string {
  const key = Buffer.from(env.tokenEncryptionKey, "hex");
  const raw = Buffer.from(payload, "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

// ---------- Connect flow ----------

/**
 * Step 1: list institutions available for Belgium, so the frontend can show a bank picker.
 */
export async function listBelgianInstitutions() {
  return gcFetch<Array<{ id: string; name: string; logo: string }>>(
    "/institutions/?country=be"
  );
}

/**
 * Step 2: create a requisition (a consent request) for the chosen bank, and return the
 * link the user must be redirected to for Strong Customer Authentication (SCA).
 */
export async function createRequisition(userId: string, institutionId: string) {
  const requisition = await gcFetch<{ id: string; link: string }>("/requisitions/", {
    method: "POST",
    body: JSON.stringify({
      redirect: env.gocardless.redirectUri,
      institution_id: institutionId,
      reference: `${userId}-${Date.now()}`,
      user_language: "EN",
    }),
  });

  await pool.query(
    `INSERT INTO bank_connections (user_id, institution_id, requisition_id, status)
     VALUES ($1, $2, $3, 'pending')`,
    [userId, institutionId, requisition.id]
  );

  return requisition.link;
}

/**
 * Step 3: after the bank redirects back (SCA complete), fetch the linked accounts
 * and persist them. Call this from the /api/bank/callback route.
 */
export async function completeRequisition(userId: string, requisitionId: string) {
  const requisition = await gcFetch<{ accounts: string[]; status: string }>(
    `/requisitions/${requisitionId}/`
  );

  await pool.query(
    `UPDATE bank_connections SET status = $1 WHERE requisition_id = $2 AND user_id = $3`,
    [requisition.status === "LN" ? "linked" : requisition.status.toLowerCase(), requisitionId, userId]
  );

  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM bank_connections WHERE requisition_id = $1 AND user_id = $2`,
    [requisitionId, userId]
  );
  const bankConnectionId = rows[0]?.id;
  if (!bankConnectionId) throw new Error("bank_connection not found for requisition");

  for (const gcAccountId of requisition.accounts) {
    const details = await gcFetch<{ account: { iban?: string; currency?: string; name?: string } }>(
      `/accounts/${gcAccountId}/details/`
    );
    await pool.query(
      `INSERT INTO accounts (user_id, bank_connection_id, gocardless_account_id, iban, account_name, currency)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (gocardless_account_id) DO NOTHING`,
      [
        userId,
        bankConnectionId,
        gcAccountId,
        details.account.iban ?? null,
        details.account.name ?? "Bank account",
        details.account.currency ?? "EUR",
      ]
    );
  }
}

// ---------- Transaction sync ----------

interface GcTransaction {
  transactionId: string;
  bookingDate: string;
  transactionAmount: { amount: string; currency: string };
  remittanceInformationUnstructured?: string;
  creditorName?: string;
  debtorName?: string;
}

/**
 * Pull transactions for one account and upsert them (idempotent on gocardless_tx_id).
 * Note: GoCardless free tier rate-limits per account (historically ~4 calls/day),
 * so this should run on a schedule, not on every dashboard load.
 */
export async function syncAccountTransactions(accountId: string) {
  const { rows } = await pool.query<{ id: string; gocardless_account_id: string }>(
    `SELECT id, gocardless_account_id FROM accounts WHERE id = $1`,
    [accountId]
  );
  const account = rows[0];
  if (!account) throw new Error("account not found");

  const data = await gcFetch<{ transactions: { booked: GcTransaction[] } }>(
    `/accounts/${account.gocardless_account_id}/transactions/`
  );

  let inserted = 0;
  for (const tx of data.transactions.booked) {
    const amount = Number(tx.transactionAmount.amount);
    const counterparty = amount < 0 ? tx.creditorName : tx.debtorName;
    const result = await pool.query(
      `INSERT INTO transactions
         (account_id, gocardless_tx_id, booking_date, amount, currency, counterparty_name, remittance_info)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (account_id, gocardless_tx_id) DO NOTHING`,
      [
        account.id,
        tx.transactionId,
        tx.bookingDate,
        amount,
        tx.transactionAmount.currency,
        counterparty ?? null,
        tx.remittanceInformationUnstructured ?? null,
      ]
    );
    inserted += result.rowCount ?? 0;
  }
  return { inserted };
}

export async function syncAllAccountsForUser(userId: string) {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM accounts WHERE user_id = $1`,
    [userId]
  );
  const results = [];
  for (const { id } of rows) {
    results.push({ accountId: id, ...(await syncAccountTransactions(id)) });
  }
  return results;
}

export const _internal = { encrypt, decrypt }; // exported for tests / token storage callers
