import { Router } from "express";
import { z } from "zod";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { setBudget, getBudgetProgress } from "../services/budgetService.js";
import { generateMonthlyRecommendations } from "../services/recommendationService.js";

export const budgetsRouter = Router();

budgetsRouter.get("/", requireAuth, async (req: AuthedRequest, res) => {
  const month = (req.query.month as string) ?? new Date().toISOString().slice(0, 8) + "01";
  const progress = await getBudgetProgress(req.userId!, month);
  res.json(progress);
});

const putSchema = z.object({ month: z.string(), amount: z.number().nonnegative() });

budgetsRouter.put("/:categoryId", requireAuth, async (req: AuthedRequest, res) => {
  const parsed = putSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  await setBudget(req.userId!, req.params.categoryId, parsed.data.month, parsed.data.amount);
  res.json({ ok: true });
});

budgetsRouter.get("/insights", requireAuth, async (req: AuthedRequest, res) => {
  const month = (req.query.month as string) ?? new Date().toISOString().slice(0, 8) + "01";
  const recs = await generateMonthlyRecommendations(req.userId!, month);
  res.json(recs);
});
