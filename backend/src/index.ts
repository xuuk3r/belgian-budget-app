import express from "express";
import cron from "node-cron";
import { env } from "./config/env.js";
import { pool } from "./db/pool.js";
import { bankRouter } from "./routes/bank.js";
import { transactionsRouter } from "./routes/transactions.js";
import { budgetsRouter } from "./routes/budgets.js";
import { syncAllAccountsForUser } from "./services/gocardlessService.js";
import { categorizeUncategorizedTransactions } from "./services/categorizationService.js";

const app = express();
app.use(express.json());

app.use("/api/bank", bankRouter);
app.use("/api/transactions", transactionsRouter);
app.use("/api/budgets", budgetsRouter);

app.get("/health", (_req, res) => res.json({ ok: true }));

// Scheduled sync — respects GoCardless's per-account daily call cap.
// Runs once a day at 06:00; swap for a queue (BullMQ) once you have more than a few users.
cron.schedule("0 6 * * *", async () => {
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM users`);
  for (const { id: userId } of rows) {
    try {
      await syncAllAccountsForUser(userId);
      await categorizeUncategorizedTransactions(userId);
    } catch (err) {
      console.error(`Scheduled sync failed for user ${userId}:`, err);
    }
  }
});

app.listen(env.port, () => {
  console.log(`Budget app API listening on :${env.port}`);
});
