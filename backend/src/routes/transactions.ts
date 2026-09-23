import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { setTransactionCategory } from "../services/categorizationService.js";

export const transactionsRouter = Router();

transactionsRouter.get("/", requireAuth, async (req: AuthedRequest, res) => {
  const month = req.query.month as string | undefined; // e.g. "2026-09-01"
  const categoryId = req.query.category as string | undefined;

  const { rows } = await pool.query(
    `SELECT t.id, t.booking_date, t.amount, t.currency, t.counterparty_name,
            t.remittance_info, t.category_id, c.name AS category_name
     FROM transactions t
     JOIN accounts a ON a.id = t.account_id
     LEFT JOIN categories c ON c.id = t.category_id
     WHERE a.user_id = $1
       AND ($2::date IS NULL OR date_trunc('month', t.booking_date) = $2::date)
       AND ($3::uuid IS NULL OR t.category_id = $3::uuid)
     ORDER BY t.booking_date DESC`,
    [req.userId, month ?? null, categoryId ?? null]
  );
  res.json(rows);
});

const patchSchema = z.object({ categoryId: z.string().uuid() });

transactionsRouter.patch("/:id", requireAuth, async (req, res) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  await setTransactionCategory(req.params.id, parsed.data.categoryId);
  res.json({ ok: true });
});
