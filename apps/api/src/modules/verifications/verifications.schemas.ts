import { z } from "zod";

export const createVerificationSchema = z.object({
  subject: z.object({
    fullName: z.string().min(1).max(200),
    // Raw national ID is used only to compute the peppered hash; never stored.
    nationalId: z.string().min(3).max(50),
    dateOfBirth: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "dateOfBirth must be YYYY-MM-DD")
      .optional(),
  }),
  authorization: z.object({
    // A check cannot be created simply by entering an NRC: the requester must
    // explicitly confirm that the applicant has given consent.
    confirmed: z.literal(true),
  }),
});
