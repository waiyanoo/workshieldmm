import { withContext, type AppContext } from "../../db/pool";
import { writeAudit } from "../../lib/audit";
import { conflict, notFound } from "../../lib/errors";
import type { AuthUser } from "../../types/auth";

interface CategoryRow {
  id: string;
  key: string;
  name: string;
  description: string;
  evidence_requirements: string;
  eligible: boolean;
  created_at: string;
  updated_at: string;
}

function ctxForUser(user: AuthUser): AppContext {
  return { userType: user.userType, userId: user.id, companyId: user.companyId };
}

function publicCategory(row: CategoryRow) {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    evidenceRequirements: row.evidence_requirements,
    eligible: row.eligible,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listAllReportCategories(admin: AuthUser) {
  return withContext(ctxForUser(admin), async (client) => {
    const result = await client.query<CategoryRow>(
      `SELECT id, key, name, description, evidence_requirements, eligible, created_at, updated_at
         FROM report_categories
        ORDER BY eligible DESC, name`
    );
    return result.rows.map(publicCategory);
  });
}

export async function createReportCategory(
  admin: AuthUser,
  input: {
    key: string;
    name: string;
    description: string;
    evidenceRequirements: string;
    eligible: boolean;
    reason: string;
    ip?: string | null;
  }
) {
  return withContext(ctxForUser(admin), async (client) => {
    let created: CategoryRow;
    try {
      const result = await client.query<CategoryRow>(
        `INSERT INTO report_categories (key, name, description, evidence_requirements, eligible)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, key, name, description, evidence_requirements, eligible, created_at, updated_at`,
        [input.key, input.name, input.description, input.evidenceRequirements, input.eligible]
      );
      created = result.rows[0]!;
    } catch (error: unknown) {
      if ((error as { code?: string }).code === "23505") {
        throw conflict("A report category with this key already exists");
      }
      throw error;
    }

    await writeAudit(client, {
      actorId: admin.id,
      actorType: "admin",
      action: "report_category.create",
      resourceType: "report_category",
      resourceId: created.id,
      metadata: { key: created.key, eligible: created.eligible, reason: input.reason },
      ipAddress: input.ip ?? null,
    });
    return publicCategory(created);
  });
}

export async function updateReportCategory(
  admin: AuthUser,
  id: string,
  input: {
    name?: string;
    description?: string;
    evidenceRequirements?: string;
    eligible?: boolean;
    reason: string;
    ip?: string | null;
  }
) {
  return withContext(ctxForUser(admin), async (client) => {
    const before = await client.query<CategoryRow>(
      `SELECT id, key, name, description, evidence_requirements, eligible, created_at, updated_at
         FROM report_categories WHERE id = $1`,
      [id]
    );
    if (!before.rows[0]) throw notFound("Report category not found");

    const current = before.rows[0];
    const result = await client.query<CategoryRow>(
      `UPDATE report_categories
          SET name = $2, description = $3, evidence_requirements = $4, eligible = $5
        WHERE id = $1
        RETURNING id, key, name, description, evidence_requirements, eligible, created_at, updated_at`,
      [
        id,
        input.name ?? current.name,
        input.description ?? current.description,
        input.evidenceRequirements ?? current.evidence_requirements,
        input.eligible ?? current.eligible,
      ]
    );
    const updated = result.rows[0]!;

    await writeAudit(client, {
      actorId: admin.id,
      actorType: "admin",
      action: "report_category.update",
      resourceType: "report_category",
      resourceId: updated.id,
      metadata: {
        key: updated.key,
        before: {
          name: current.name,
          description: current.description,
          evidenceRequirements: current.evidence_requirements,
          eligible: current.eligible,
        },
        after: {
          name: updated.name,
          description: updated.description,
          evidenceRequirements: updated.evidence_requirements,
          eligible: updated.eligible,
        },
        reason: input.reason,
      },
      ipAddress: input.ip ?? null,
    });
    return publicCategory(updated);
  });
}
