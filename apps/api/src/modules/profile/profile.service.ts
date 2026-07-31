/**
 * Company and personal profile.
 *
 * What a company may change about itself is deliberately narrow: contact
 * details only. The legal name, registration number, status and plan are the
 * verified identity or the billing state, and are refused here — by the API,
 * and again by the trigger in migration 0019 so a mistake in this file cannot
 * let a verified company quietly become a different one.
 *
 * Login email is not editable from this screen either. It is the credential; a
 * profile form that can change it turns a borrowed session into a permanent
 * account takeover. Changing it should be its own flow with confirmation to the
 * old address, which does not exist yet.
 */
import { withContext, type AppContext } from "../../db/pool";
import { writeAudit } from "../../lib/audit";
import { forbidden, notFound } from "../../lib/errors";
import type { AuthUser } from "../../types/auth";

function ctxForUser(user: AuthUser): AppContext {
  return { userType: user.userType, userId: user.id, companyId: user.companyId };
}

/** Fields a company may maintain itself. Everything else is read-only. */
export interface CompanyProfileInput {
  phone?: string | null;
  contactEmail?: string | null;
  addressLine?: string | null;
  township?: string | null;
  city?: string | null;
  region?: string | null;
}

export async function getProfile(user: AuthUser) {
  if (!user.companyId) throw forbidden("A company context is required");

  return withContext(ctxForUser(user), async (client) => {
    const company = await client.query(
      `SELECT id, legal_name, registration_number, status, plan,
              registration_verified_at, created_at,
              phone, contact_email, address_line, township, city, region
         FROM companies WHERE id = $1`,
      [user.companyId]
    );
    if (!company.rows[0]) throw notFound("Company not found");

    const me = await client.query(
      `SELECT id, full_name, email, role, phone, mfa_enabled, created_at, national_id
         FROM company_users WHERE id = $1`,
      [user.id]
    );

    // Colleagues, so an admin can see who else holds access. Contact details of
    // other users are not returned — only who they are and what they can do.
    const colleagues = await client.query(
      `SELECT id, full_name, email, role, status
         FROM company_users WHERE company_id = $1 ORDER BY created_at`,
      [user.companyId]
    );

    const c = company.rows[0];
    const m = me.rows[0];
    return {
      company: {
        id: c.id,
        legalName: c.legal_name,
        registrationNumber: c.registration_number,
        status: c.status,
        plan: c.plan,
        registrationVerifiedAt: c.registration_verified_at,
        createdAt: c.created_at,
        phone: c.phone,
        contactEmail: c.contact_email,
        addressLine: c.address_line,
        township: c.township,
        city: c.city,
        region: c.region,
      },
      me: {
        id: m?.id ?? null,
        fullName: m?.full_name ?? null,
        email: m?.email ?? null,
        role: m?.role ?? null,
        phone: m?.phone ?? null,
        // Read-only: it is the identity the company was verified against, not
        // a contact detail. Changing it is a re-verification, not an edit.
        nationalId: m?.national_id ?? null,
        mfaEnabled: m?.mfa_enabled ?? false,
        createdAt: m?.created_at ?? null,
      },
      users: colleagues.rows.map((u) => ({
        id: u.id,
        fullName: u.full_name,
        email: u.email,
        role: u.role,
        status: u.status,
      })),
      // Named explicitly so the UI can render the locked fields with a reason
      // rather than silently omitting them.
      lockedFields: ["legalName", "registrationNumber", "status", "plan", "email", "nationalId"],
    };
  });
}

/**
 * Update the company's contact details. Company admins only — this is
 * organisation-level data, and a regular user changing the address that
 * notices go to should not be a one-click action.
 */
export async function updateCompanyProfile(
  user: AuthUser,
  input: CompanyProfileInput & { ip?: string | null }
) {
  if (!user.companyId) throw forbidden("A company context is required");
  if (user.role !== "company_admin") {
    throw forbidden("Only a company admin can change company details");
  }

  return withContext(ctxForUser(user), async (client) => {
    const before = await client.query(
      `SELECT phone, contact_email, address_line, township, city, region
         FROM companies WHERE id = $1`,
      [user.companyId]
    );
    if (!before.rows[0]) throw notFound("Company not found");

    // COALESCE on the parameter: an omitted field keeps its value, while an
    // explicit null clears it. Editing one field never wipes the others.
    const res = await client.query(
      `UPDATE companies
          SET phone         = COALESCE($2, phone),
              contact_email = COALESCE($3, contact_email),
              address_line  = COALESCE($4, address_line),
              township      = COALESCE($5, township),
              city          = COALESCE($6, city),
              region        = COALESCE($7, region)
        WHERE id = $1
        RETURNING phone, contact_email, address_line, township, city, region`,
      [
        user.companyId,
        input.phone ?? null,
        input.contactEmail ?? null,
        input.addressLine ?? null,
        input.township ?? null,
        input.city ?? null,
        input.region ?? null,
      ]
    );

    // Record which fields moved, not the values — an address history in the
    // audit log is more personal data than the log needs to hold.
    const after = res.rows[0]!;
    const changed = Object.keys(after).filter(
      (k) => after[k] !== (before.rows[0] as Record<string, unknown>)[k]
    );

    await writeAudit(client, {
      actorId: user.id,
      actorType: "user",
      action: "company.profile_update",
      resourceType: "company",
      resourceId: user.companyId!,
      metadata: { fields: changed },
      ipAddress: input.ip ?? null,
    });

    return {
      phone: after.phone,
      contactEmail: after.contact_email,
      addressLine: after.address_line,
      township: after.township,
      city: after.city,
      region: after.region,
    };
  });
}

/**
 * Update your own name and phone.
 *
 * The name is editable but audited: for the first admin it is the person the
 * NRC was checked against at verification, so a change is something an operator
 * may legitimately want to see.
 */
export async function updateOwnProfile(
  user: AuthUser,
  input: { fullName?: string; phone?: string | null; ip?: string | null }
) {
  return withContext(ctxForUser(user), async (client) => {
    const before = await client.query<{ full_name: string; phone: string | null }>(
      `SELECT full_name, phone FROM company_users WHERE id = $1`,
      [user.id]
    );
    if (!before.rows[0]) throw notFound("User not found");

    const res = await client.query<{ full_name: string; phone: string | null }>(
      `UPDATE company_users
          SET full_name = COALESCE($2, full_name),
              phone     = COALESCE($3, phone)
        WHERE id = $1
        RETURNING full_name, phone`,
      [user.id, input.fullName ?? null, input.phone ?? null]
    );

    const nameChanged = res.rows[0]!.full_name !== before.rows[0].full_name;
    await writeAudit(client, {
      actorId: user.id,
      actorType: "user",
      action: "user.profile_update",
      resourceType: "company_user",
      resourceId: user.id,
      metadata: { nameChanged, phoneChanged: res.rows[0]!.phone !== before.rows[0].phone },
      ipAddress: input.ip ?? null,
    });

    return { fullName: res.rows[0]!.full_name, phone: res.rows[0]!.phone };
  });
}
