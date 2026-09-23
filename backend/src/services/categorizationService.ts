/**
 * Rule-based transaction categorization.
 *
 * Starts simple (keyword/merchant matching against the raw SEPA remittance text,
 * which is what Belgian banks return) with a hook to layer in a smarter model later
 * (e.g. an LLM call or a trained classifier) without changing the call sites.
 */
import { pool } from "../db/pool.js";

interface CategoryRule {
  categoryName: string;
  patterns: RegExp[];
}

// Starter ruleset tuned to common Belgian merchant/counterparty strings.
// Extend this list, or move it into a `category_rules` table so users can edit it.
const RULES: CategoryRule[] = [
  { categoryName: "Home costs", patterns: [/engie|luminus|eneco|fluvius|vivaqua|proximus|telenet|orange belgium/i] },
  { categoryName: "Transportation", patterns: [/nmbs|sncb|de lijn|stib|mivb|shell|total energies|q8|esso|cambio/i] },
  { categoryName: "Health", patterns: [/apotheek|pharmacie|mutualit|ziekenfonds|dokter|médecin/i] },
  { categoryName: "Daily living", patterns: [/colruyt|delhaize|carrefour|aldi|lidl|okay|spar/i] },
  { categoryName: "Entertainment", patterns: [/netflix|spotify|pathe|kinepolis|steam|proximus pickx/i] },
  { categoryName: "Obligations", patterns: [/rsz|onss|bedrijfsvoorheffing|belastingen|impôts|verzekering|assurance/i] },
  { categoryName: "Wages", patterns: [/loon|salaire|salary|payroll/i] },
];

let categoryIdCache: Map<string, string> | null = null;

async function getCategoryIdMap(userId: string): Promise<Map<string, string>> {
  if (categoryIdCache) return categoryIdCache;
  const { rows } = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM categories WHERE user_id IS NULL OR user_id = $1`,
    [userId]
  );
  categoryIdCache = new Map(rows.map((r) => [r.name, r.id]));
  return categoryIdCache;
}

function matchCategoryName(text: string, amount: number): string {
  const haystack = text.toLowerCase();
  for (const rule of RULES) {
    if (rule.patterns.some((p) => p.test(haystack))) return rule.categoryName;
  }
  return amount > 0 ? "Other income" : "Uncategorized";
}

/**
 * Categorize all transactions for a user that don't have a category yet
 * (or were auto-categorized before and haven't been manually overridden).
 */
export async function categorizeUncategorizedTransactions(userId: string) {
  const categoryIds = await getCategoryIdMap(userId);

  const { rows } = await pool.query<{
    id: string;
    remittance_info: string | null;
    counterparty_name: string | null;
    amount: string;
  }>(
    `SELECT t.id, t.remittance_info, t.counterparty_name, t.amount
     FROM transactions t
     JOIN accounts a ON a.id = t.account_id
     WHERE a.user_id = $1 AND t.category_source = 'auto' AND t.category_id IS NULL`,
    [userId]
  );

  let updated = 0;
  for (const tx of rows) {
    const text = `${tx.counterparty_name ?? ""} ${tx.remittance_info ?? ""}`;
    const categoryName = matchCategoryName(text, Number(tx.amount));
    const categoryId = categoryIds.get(categoryName) ?? categoryIds.get("Uncategorized");
    if (!categoryId) continue;

    await pool.query(
      `UPDATE transactions SET category_id = $1 WHERE id = $2`,
      [categoryId, tx.id]
    );
    updated += 1;
  }
  return { updated };
}

/**
 * User-driven override. Once a user manually re-categorizes a transaction,
 * category_source flips to 'manual' so future auto-categorization runs skip it.
 */
export async function setTransactionCategory(transactionId: string, categoryId: string) {
  await pool.query(
    `UPDATE transactions SET category_id = $1, category_source = 'manual' WHERE id = $2`,
    [categoryId, transactionId]
  );
}
