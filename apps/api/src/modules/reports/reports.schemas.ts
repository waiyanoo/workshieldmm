import { z } from "zod";
import { DECLARATION_LOCALES } from "@hyper/shared";

export const createReportSchema = z.object({
  subject: z.object({
    fullName: z.string().min(1).max(200),
    nationalId: z.string().min(3).max(50), // hashed only; never stored raw
    dateOfBirth: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "dateOfBirth must be YYYY-MM-DD")
      .optional(),
  }),
  categoryKey: z.string().min(1).max(100),
  // Short and factual — there is deliberately no freeform allegations field.
  // (§5 Data minimization)
  narrativeSummary: z.string().min(1).max(500),
});

export const reportDecisionSchema = z.object({
  decision: z.enum(["evidence_sufficient", "evidence_insufficient"]),
  notes: z.string().max(1000).optional(),
});

export const submitReportSchema = z.object({
  declaration: z.object({
    accepted: z.literal(true),
    version: z.string().trim().min(1).max(50),
    // Which of the two paragraphs was on screen. Required, not defaulted: a
    // record that guesses the language is the thing this column exists to
    // prevent, and only the client knows what it rendered.
    locale: z.enum(DECLARATION_LOCALES),
  }),
});

export const withdrawSchema = z.object({
  reason: z.string().min(1).max(500),
});

export const correctSchema = z.object({
  narrativeSummary: z.string().min(1).max(500),
  reason: z.string().min(1).max(500),
});

export const accessRequestSchema = z.object({
  subject: z.object({
    nationalId: z.string().min(3).max(50),
  }),
});

export const accessDecisionSchema = z.object({
  status: z.enum(["approved", "denied"]),
});
