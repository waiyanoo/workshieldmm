import { z } from "zod";

export const registerCompanySchema = z.object({
  company: z.object({
    legalName: z.string().min(1).max(200),
    registrationNumber: z.string().min(1).max(100), // DICA business registration
  }),
  admin: z.object({
    fullName: z.string().min(1).max(200),
    email: z.string().email(),
    password: z.string().min(8).max(200),
    // The person whose NRC scan the company uploads for verification. Required
    // so the reviewer has a number to check the scan against rather than
    // reading one off an image. (0024)
    nationalId: z.string().min(3).max(50),
  }),
  declaration: z.object({
    accepted: z.literal(true),
    version: z.string().trim().min(1).max(50),
  }),
});

export const verifyCompanySchema = z.object({
  notes: z.string().max(500).optional(),
});

// Suspend / reactivate. The reason is mandatory: cutting off an employer's
// access is a consequential act and the audit entry has to say why.
export const companyStatusSchema = z.object({
  status: z.enum(["verified", "suspended"]),
  reason: z.string().min(1).max(500),
});

// Per-document decision. The reason is required for a rejection and enforced
// again in the service and by a CHECK constraint in migration 0020.
export const reviewDocumentSchema = z
  .object({
    decision: z.enum(["approved", "rejected"]),
    reason: z.string().trim().max(500).optional(),
  })
  .refine((v) => v.decision !== "rejected" || (v.reason?.length ?? 0) > 0, {
    message: "A rejection must say what is wrong with the document",
    path: ["reason"],
  });
