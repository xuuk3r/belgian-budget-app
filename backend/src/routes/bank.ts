import { Router } from "express";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import {
  listBelgianInstitutions,
  createRequisition,
  completeRequisition,
  syncAllAccountsForUser,
} from "../services/gocardlessService.js";
import { categorizeUncategorizedTransactions } from "../services/categorizationService.js";

export const bankRouter = Router();

bankRouter.get("/institutions", requireAuth, async (_req, res) => {
  const institutions = await listBelgianInstitutions();
  res.json(institutions);
});

bankRouter.post("/connect", requireAuth, async (req: AuthedRequest, res) => {
  const { institutionId } = req.body as { institutionId: string };
  const link = await createRequisition(req.userId!, institutionId);
  res.json({ redirectUrl: link });
});

// GoCardless redirects the user's browser here after SCA at the bank.
bankRouter.get("/callback", requireAuth, async (req: AuthedRequest, res) => {
  const requisitionId = req.query.ref as string;
  await completeRequisition(req.userId!, requisitionId);
  res.redirect("/dashboard?connected=1");
});

bankRouter.post("/sync", requireAuth, async (req: AuthedRequest, res) => {
  const syncResults = await syncAllAccountsForUser(req.userId!);
  const { updated } = await categorizeUncategorizedTransactions(req.userId!);
  res.json({ syncResults, categorized: updated });
});
