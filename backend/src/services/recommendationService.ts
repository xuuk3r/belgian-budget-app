/**
 * Generates simple, explainable spending insights by comparing this month's
 * spend per category to the trailing 3-month average. Rule-based on purpose —
 * predictable and auditable beats a black-box model for financial advice.
 */
import { pool } from "../db/pool.js";

export async function generateMonthlyRecommendations(userId: string, month: string) {
  const { rows } = await pool.query<{
    category_id: string;
    category_name: string;
    current_month_spend: string;
    trailing_avg: string;
  }>(
    `WITH monthly AS (
       SELECT
         c.id AS category_id,
         c.name AS category_name,
         date_trunc('month', t.booking_date) AS month,
         SUM(ABS(t.amount)) AS spend
       FROM transactions t
       JOIN categories c ON c.id = t.category_id
       WHERE t.account_id IN (SELECT id FROM accounts WHERE user_id = $1)
         AND t.amount < 0
         AND t.booking_date >= ($2::date - INTERVAL '3 months')
         AND t.booking_date < ($2::date + INTERVAL '1 month')
       GROUP BY c.id, c.name, date_trunc('month', t.booking_date)
     )
     SELECT
       category_id,
       category_name,
       COALESCE(MAX(spend) FILTER (WHERE month = $2::date), 0) AS current_month_spend,
       COALESCE(AVG(spend) FILTER (WHERE month < $2::date), 0) AS trailing_avg
     FROM monthly
     GROUP BY category_id, category_name`,
    [userId, month]
  );

  const recommendations: { categoryId: string; message: string; severity: "info" | "warning" }[] = [];

  for (const row of rows) {
    const current = Number(row.current_month_spend);
    const avg = Number(row.trailing_avg);
    if (avg <= 0 || current <= 0) continue;

    const pctChange = ((current - avg) / avg) * 100;
    if (pctChange >= 20) {
      recommendations.push({
        categoryId: row.category_id,
        severity: "warning",
        message: `You spent ${Math.round(pctChange)}% more on ${row.category_name} this month (€${current.toFixed(2)}) than your 3-month average (€${avg.toFixed(2)}).`,
      });
    } else if (pctChange <= -20) {
      recommendations.push({
        categoryId: row.category_id,
        severity: "info",
        message: `Nice — ${row.category_name} spend is down ${Math.round(Math.abs(pctChange))}% versus your 3-month average.`,
      });
    }
  }

  for (const rec of recommendations) {
    await pool.query(
      `INSERT INTO recommendations (user_id, category_id, month, message, severity)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, rec.categoryId, month, rec.message, rec.severity]
    );
  }

  return recommendations;
}
