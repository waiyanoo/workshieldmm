/**
 * Companies: employer onboarding and DICA verification.
 *
 * Registration (public) creates the company in `pending`, its first
 * company_admin, and a default Tier A subscription — all in one transaction
 * with an audit entry. A Super Admin later confirms the business registration
 * against the DICA record, moving the company to `verified`. (§4)
 */
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  companyDocsSatisfyVerification,
  currentDeclarationVersion,
  missingRequiredDocs,
  normalizeNrc,
} from "@hyper/shared";
import { withContext, type AppContext } from "../../db/pool";
import { writeAudit } from "../../lib/audit";
import { badRequest, conflict, declarationOutdated, notFound } from "../../lib/errors";
import { isUniqueViolation } from "../../lib/dbErrors";
import type { AuthUser } from "../../types/auth";
import { hashPassword } from "../auth/password";
import { issueTokens } from "../auth/auth.service";
import { WELCOME_CREDITS, getBalance } from "../credits/credits.service";
import { grantWelcomeCredits } from "../credits/plans.service";
import { notify } from "../notifications/notifications.service";

const SYSTEM_CTX: AppContext = { userType: "system" };

interface CompanyRow {
  id: string;
  legal_name: string;
  registration_number: string;
  registration_verified_at: string | null;
  status: string;
  plan: string;
  monthly_credit_override: number | null;
  created_at: string;
}

function publicCompany(c: CompanyRow) {
  return {
    id: c.id,
    legalName: c.legal_name,
    registrationNumber: c.registration_number,
    status: c.status,
    plan: c.plan,
    monthlyCreditOverride: c.monthly_credit_override,
    registrationVerifiedAt: c.registration_verified_at,
    createdAt: c.created_at,
  };
}

function ctxForUser(user: AuthUser): AppContext {
  return { userType: user.userType, userId: user.id, companyId: user.companyId };
}

export interface RegisterCompanyInput {
  company: { legalName: string; registrationNumber: string };
  admin: { fullName: string; email: string; password: string; nationalId: string };
  declaration: { accepted: true; version: string };
  ip?: string | null;
  userAgent?: string | null;
}

export async function registerCompany(input: RegisterCompanyInput) {
  // Refuse a version other than the one in force. A page left open across a
  // deployment would otherwise file agreement to wording its reader never saw,
  // and this table exists precisely to be trusted on that point.
  if (input.declaration.version !== currentDeclarationVersion("registration")) {
    throw declarationOutdated();
  }
  const passwordHash = await hashPassword(input.admin.password);

  // Generate the id up front and pin the RLS context to it, so the new
  // company (and the users/subscription under it) are visible to their own
  // INSERT ... RETURNING and satisfy the company-scoped WITH CHECK policies.
  const companyId = randomUUID();

  return withContext(SYSTEM_CTX, async (client: PoolClient) => {
    await client.query("SELECT set_config('app.company_id', $1, true)", [companyId]);

    // 1. Company (starts pending).
    let company: CompanyRow;
    try {
      const res = await client.query<CompanyRow>(
        `INSERT INTO companies (id, legal_name, registration_number)
         VALUES ($1, $2, $3) RETURNING *`,
        [companyId, input.company.legalName, input.company.registrationNumber]
      );
      company = res.rows[0]!;
    } catch (err) {
      if (isUniqueViolation(err))
        throw conflict("A company with that registration number already exists");
      throw err;
    }

    // 2. First company_admin.
    let userId: string;
    try {
      const res = await client.query<{ id: string }>(
        `INSERT INTO company_users
           (company_id, full_name, email, role, password_hash, national_id)
         VALUES ($1, $2, $3, 'company_admin', $4, $5) RETURNING id`,
        [
          company.id,
          input.admin.fullName,
          input.admin.email,
          passwordHash,
          // Canonical form, same as everywhere else the platform holds an NRC,
          // so a reviewer comparing it to a subject record sees one format.
          normalizeNrc(input.admin.nationalId),
        ]
      );
      userId = res.rows[0]!.id;
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict("That email is already registered");
      throw err;
    }

    // 3. Default Tier A subscription. Retained for billing history only —
    //    feature access no longer depends on it, since every registered company
    //    can use every feature and plans differ only in bundled credits
    //    (Pricing Plan §1).
    await client.query(
      `INSERT INTO subscriptions (company_id, tier, status) VALUES ($1, 'A', 'active')`,
      [company.id]
    );

    // The first administrator accepts the platform registration declaration
    // for this company. The row is deliberately immutable rather than a flag
    // on the company, so the acceptance stays independently auditable.
    await client.query(
      `INSERT INTO company_declarations
         (company_id, company_user_id, kind, declaration_version)
       VALUES ($1, $2, 'registration', $3)`,
      // The server's own version, never the client's. They are equal by this
      // point — the check above rejects anything else — but writing the
      // constant means a future caller that forgets to send one cannot file a
      // record claiming agreement to nothing in particular.
      [company.id, userId, currentDeclarationVersion("registration")]
    );

    // Welcome credits are NOT granted here. A company that has only filled in a
    // registration form cannot run a check yet, so a balance on the dashboard
    // is an offer it cannot take up — and it starts the one-month expiry clock
    // (0018) running while the account is still waiting on us. They are granted
    // on verification instead. (Pricing Plan §3; see verifyCompany)

    // 4. Session + audit.
    const tokens = await issueTokens(
      client,
      { id: userId, user_type: "company", role: "company_admin", company_id: company.id },
      input.ip,
      input.userAgent
    );
    await writeAudit(client, {
      actorId: userId,
      actorType: "user",
      action: "company.register",
      resourceType: "company",
      resourceId: company.id,
      metadata: { registrationDeclarationVersion: input.declaration.version },
      ipAddress: input.ip ?? null,
    });

    return {
      company: publicCompany(company),
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
  });
}

export async function verifyCompany(
  companyId: string,
  admin: AuthUser,
  opts: { notes?: string; ip?: string | null }
) {
  return withContext(ctxForUser(admin), async (client) => {
    // Structural rule: the required documents must be APPROVED before a company
    // can be verified — a DICA certificate OR shop license, AND an NRC copy.
    // Approved, not merely present: before 0020 this only checked existence, so
    // an unopened or rejected file satisfied the gate.
    const docs = await client.query<{ doc_type: string }>(
      `SELECT doc_type FROM company_documents
        WHERE company_id = $1 AND review_status = 'approved'`,
      [companyId]
    );
    if (!companyDocsSatisfyVerification(docs.rows.map((r) => r.doc_type))) {
      const outstanding = missingRequiredDocs(docs.rows.map((r) => r.doc_type));
      // Tell the company which requirement is unmet rather than leaving them to
      // guess, and record it so it shows on their dashboard.
      await notify(client, {
        companyId,
        kind: "documents.missing",
        params: { missing: outstanding },
        severity: "warning",
        link: "/",
      });
      throw badRequest(
        `Cannot verify: these documents are not approved yet — ${outstanding.join(", ")}`
      );
    }

    const res = await client.query<CompanyRow>(
      `UPDATE companies
          SET status = 'verified', registration_verified_at = now()
        WHERE id = $1 RETURNING *`,
      [companyId]
    );
    if (!res.rows[0]) throw notFound("Company not found");

    // Welcome credits land now, not at registration: this is the moment the
    // account can actually spend them, and the moment their one-month life
    // should start. Skipped on re-verification (a suspended company coming
    // back) so the grant cannot be farmed by toggling status.
    const alreadyWelcomed = await client.query(
      `SELECT 1 FROM credit_lots WHERE company_id = $1 AND reason = 'welcome' LIMIT 1`,
      [companyId]
    );
    if (alreadyWelcomed.rowCount === 0) {
      await grantWelcomeCredits(client, companyId, WELCOME_CREDITS);
    }

    await notify(client, {
      companyId,
      kind: "company.verified",
      params: { credits: alreadyWelcomed.rowCount === 0 ? WELCOME_CREDITS : 0 },
      severity: "success",
      link: "/",
    });

    await writeAudit(client, {
      actorId: admin.id,
      actorType: "admin",
      action: "company.verify",
      resourceType: "company",
      resourceId: companyId,
      metadata: opts.notes ? { notes: opts.notes } : {},
      ipAddress: opts.ip ?? null,
    });
    return publicCompany(res.rows[0]);
  });
}

/**
 * Suspend or reactivate a company. Suspension is the operational off-switch:
 * `requireTierBCompany` and the Tier A gate both demand status 'verified', so a
 * suspended employer immediately loses the ability to submit checks or reports
 * and to request access to anyone's record.
 *
 * Reactivation returns the company to 'verified' rather than 'pending', because
 * its registration was already confirmed — suspension is not un-verification.
 * A company that was never verified cannot be reactivated into 'verified'; it
 * goes back to 'pending' and through the documents check like any other.
 */
export async function setCompanyStatus(
  companyId: string,
  admin: AuthUser,
  input: { status: "verified" | "suspended"; reason: string; ip?: string | null }
) {
  return withContext(ctxForUser(admin), async (client) => {
    const current = await client.query<CompanyRow>(
      `SELECT * FROM companies WHERE id = $1`,
      [companyId]
    );
    if (!current.rows[0]) throw notFound("Company not found");
    if (current.rows[0].status === input.status) {
      throw conflict(`Company is already ${input.status}`);
    }
    if (input.status === "verified" && current.rows[0].registration_verified_at === null) {
      throw badRequest(
        "This company has never been verified — verify it against the DICA record instead"
      );
    }

    const res = await client.query<CompanyRow>(
      `UPDATE companies SET status = $2 WHERE id = $1 RETURNING *`,
      [companyId, input.status]
    );

    await notify(client, {
      companyId,
      kind: input.status === "suspended" ? "company.suspended" : "company.verified",
      params: { reason: input.reason },
      severity: input.status === "suspended" ? "error" : "success",
      link: "/",
    });

    await writeAudit(client, {
      actorId: admin.id,
      actorType: "admin",
      action: input.status === "suspended" ? "company.suspend" : "company.reactivate",
      resourceType: "company",
      resourceId: companyId,
      metadata: { from: current.rows[0].status, to: input.status, reason: input.reason },
      ipAddress: input.ip ?? null,
    });
    return publicCompany(res.rows[0]!);
  });
}

/**
 * Everything a Super Admin needs to judge one company on a single screen: the
 * registration record, its user accounts, its subscriptions, and what documents
 * are on file. Document *contents* are not included — those stay behind the
 * per-file audited download.
 */
export async function getCompanyDetail(companyId: string, admin: AuthUser) {
  return withContext(ctxForUser(admin), async (client) => {
    const company = await client.query<CompanyRow>(`SELECT * FROM companies WHERE id = $1`, [
      companyId,
    ]);
    if (!company.rows[0]) throw notFound("Company not found");

    const users = await client.query(
      `SELECT id, full_name, email, role, status, created_at, national_id
         FROM company_users WHERE company_id = $1 ORDER BY created_at`,
      [companyId]
    );
    const subs = await client.query(
      `SELECT tier, status, billing_cycle, start_date, end_date
         FROM subscriptions WHERE company_id = $1 ORDER BY tier`,
      [companyId]
    );
    const docs = await client.query(
      `SELECT doc_type, uploaded_at, review_status, review_reason, reviewed_at
         FROM company_documents
        WHERE company_id = $1 ORDER BY uploaded_at`,
      [companyId]
    );
    const activity = await client.query<{ verifications: string; reports: string }>(
      `SELECT (SELECT count(*) FROM verification_requests WHERE company_id = $1) AS verifications,
              (SELECT count(*) FROM conduct_reports WHERE submitted_by_company_id = $1) AS reports`,
      [companyId]
    );

    const approvedDocTypes = docs.rows
      .filter((d) => d.review_status === "approved")
      .map((d) => d.doc_type as string);

    return {
      ...publicCompany(company.rows[0]),
      creditBalance: await getBalance(client, companyId),
      users: users.rows.map((u) => ({
        id: u.id,
        fullName: u.full_name,
        email: u.email,
        role: u.role,
        status: u.status,
        createdAt: u.created_at,
        // Shown to the reviewer so the uploaded NRC scan can be checked against
        // a number, not just against a name. (0024)
        nationalId: u.national_id,
      })),
      subscriptions: subs.rows.map((s) => ({
        tier: s.tier,
        status: s.status,
        billingCycle: s.billing_cycle,
        startDate: s.start_date,
        endDate: s.end_date,
      })),
      documents: docs.rows.map((d) => ({
        docType: d.doc_type,
        uploadedAt: d.uploaded_at,
        reviewStatus: d.review_status,
        reviewReason: d.review_reason,
        reviewedAt: d.reviewed_at,
      })),
      // The same rule verifyCompany enforces, evaluated here so the admin
      // screen can disable the button and name what is outstanding instead of
      // offering an action that is going to fail.
      verification: {
        ready: companyDocsSatisfyVerification(approvedDocTypes),
        missing: missingRequiredDocs(approvedDocTypes),
      },
      counts: {
        verifications: Number(activity.rows[0]!.verifications),
        reports: Number(activity.rows[0]!.reports),
      },
    };
  });
}

export async function listCompanies(
  ctx: AppContext,
  query: { status?: string; q?: string; limit?: number; offset?: number } | string = {}
) {
  return withContext(ctx, async (client) => {
    const options = typeof query === "string" ? { status: query } : query;
    const status = options.status ?? null;
    const search = options.q?.trim() ?? "";
    const limit = options.limit ?? 25;
    const offset = options.offset ?? 0;
    const where = `WHERE ($1::text IS NULL OR status = $1)
      AND ($2 = '' OR legal_name ILIKE '%' || $2 || '%'
        OR registration_number ILIKE '%' || $2 || '%')`;
    const res = await client.query<CompanyRow>(
      `SELECT * FROM companies ${where} ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
      [status, search, limit, offset]
    );
    const count = await client.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM companies ${where}`,
      [status, search]
    );
    return {
      items: res.rows.map(publicCompany),
      total: Number(count.rows[0]?.total ?? 0),
      limit,
      offset,
    };
  });
}

export async function getCompany(companyId: string, ctx: AppContext) {
  return withContext(ctx, async (client) => {
    const res = await client.query<CompanyRow>(`SELECT * FROM companies WHERE id = $1`, [
      companyId,
    ]);
    // RLS already restricts visibility; a hidden row simply isn't returned.
    if (!res.rows[0]) throw notFound("Company not found");
    return publicCompany(res.rows[0]);
  });
}
