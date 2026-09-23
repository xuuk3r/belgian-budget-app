/**
 * Budget tracking: set a monthly budget per category and compute progress
 * against actual spend from transactions.
 */
import { pool } from "../db/pool.js";

export interface BudgetProgress {
  categoryId: string;
  categoryName: string;
  budgeted: number;
  spent: number;
  remaining: number;
  percentUsed: number; // 0-100+, can exceed 100 if over budget
}

/** month should be a Date/ISO string set to the 1st of the month, e.g. "2026-09-01" */
export async function setBudget(userId: string, categoryId: string, month: string, amount: number) {
  await pool.query(
    `INSERT INTO budgets (user_id, category_id, month, amount)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, category_id, month) DO UPDATE SET amount = EXCLUDED.amount`,
    [userId, categoryId, month, amount]
  );
}

export async function getBudgetProgress(userId: string, month: string): Promise<BudgetProgress[]> {
  const { rows } = await pool.query<{
    category_id: string;
    category_name: string;
    budgeted: string | null;
    spent: string | null;
  }>(
    `SELECT
       c.id AS category_id,
       c.name AS category_name,
       b.amount AS budgeted,
       COALESCE(SUM(ABS(t.amount)) FILTER (WHERE t.amount < 0), 0) AS spent
     FROM categories c
     LEFT JOIN budgets b
       ON b.category_id = c.id AND b.user_id = $1 AND b.month = $2::date
     LEFT JOIN transactions t
       ON t.category_id = c.id
       AND date_trunc('month', t.booking_date) = $2::date
       AND t.account_id IN (SELECT id FROM accounts WHERE user_id = $1)
     WHERE (c.user_id = $1 OR c.user_id IS NULL) AND c.kind = 'expense'
     GROUP BY c.id, c.name, b.amount
     ORDER BY c.name`,
    [userId, month]
  );

  return rows
    .filter((r) => r.budgeted !== null) // only categories the user has actually budgeted
    .map((r) => {
      const budgeted = Number(r.budgeted);
      const spent = Number(r.spent ?? 0);
      return {
        categoryId: r.category_id,
        categoryName: r.category_name,
        budgeted,
        spent,
        remaining: budgeted - spent,
        percentUsed: budgeted > 0 ? Math.round((spent / budgeted) * 100) : 0,
      };
    });
}
