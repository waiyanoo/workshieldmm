/**
 * What a company agreed to, and when.
 *
 * `company_declarations` (0028) is an evidentiary record: its only job is to be
 * trustworthy months later about wording somebody accepted. That fails in a
 * quiet way if the version is whatever the browser said — a page left open
 * across a deployment shows the old text, submits the old version, and files a
 * record nobody can rely on.
 *
 * So: the version is checked against the server's, and the row is written from
 * the server's constant. Both halves are pinned here.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createHash } from "node:crypto";
import {
  DECLARATION_ARCHIVE,
  DECLARATION_VERSIONS,
  currentDeclarationText,
  declarationText,
  type DeclarationKind,
} from "@hyper/shared";

process.env.FEATURE_TIER_B_ENABLED = "true";

let app: Express;
let pool: typeof import("../db/pool").pool;
let withContext: typeof import("../db/pool").withContext;
let redis: typeof import("../lib/redis").redis;
let helpers: typeof import("../test/helpers");

beforeAll(async () => {
  app = (await import("../app")).createApp();
  ({ pool, withContext } = await import("../db/pool"));
  ({ redis } = await import("../lib/redis"));
  helpers = await import("../test/helpers");
});

afterAll(async () => {
  await Promise.allSettled([pool.end(), redis.quit()]);
});

/**
 * The wording of every version ever offered, pinned.
 *
 * A stored version is only meaningful if it resolves to the exact words that
 * were on screen. Nothing else stops someone tidying a sentence in place, which
 * would silently change what every existing record claims a company agreed to.
 * These digests turn that into a failing test.
 *
 * To change a declaration: add a NEW version to the archive with a new digest
 * here, and leave the old line untouched. If you find yourself editing a digest
 * that is already in this list, stop — you are rewriting history.
 */
const PINNED_TEXTS = new Map<string, string>([
  ["registration:2026-08", "91d4f37bcac21cc5"],
  ["registration:2026-08.2", "c7c6937ec974d827"],
  ["report_submission:2026-08", "a6da5cb14aaa31d6"],
  ["report_submission:2026-08.2", "efdbba866bcf6997"],
]);

function digest(en: string, my: string): string {
  return createHash("sha256").update(`${en}\u0000${my}`).digest("hex").slice(0, 16);
}

describe("declaration wording", () => {
  it("has not changed for any version already offered", () => {
    const seen: string[] = [];
    for (const kind of Object.keys(DECLARATION_ARCHIVE) as DeclarationKind[]) {
      for (const [version, text] of Object.entries(DECLARATION_ARCHIVE[kind])) {
        const key = `${kind}:${version}`;
        seen.push(key);
        expect(PINNED_TEXTS.get(key), `${key} is not pinned — add its digest`).toBe(
          digest(text.en, text.my)
        );
      }
    }
    // And nothing was removed: an archived version that disappears leaves any
    // record naming it pointing at nothing.
    for (const key of PINNED_TEXTS.keys()) {
      expect(seen, `${key} was removed from the archive`).toContain(key);
    }
  });

  it("offers a current version that exists in both languages", () => {
    for (const kind of Object.keys(DECLARATION_ARCHIVE) as DeclarationKind[]) {
      const version = DECLARATION_VERSIONS[kind];
      const entry = DECLARATION_ARCHIVE[kind][version];
      expect(entry, `${kind} has no archived text for its current version`).toBeTruthy();
      expect(entry!.en.length).toBeGreaterThan(40);
      expect(entry!.my.length).toBeGreaterThan(40);
      // Burmese must actually be Burmese. 2026-08 shipped the English text in
      // both slots because no translation existed, and a user reading a
      // fallback they cannot understand is not meaningful consent.
      expect(currentDeclarationText(kind, "my")).toMatch(/[က-႟]/);
      expect(currentDeclarationText(kind, "en")).not.toMatch(/[က-႟]/);
    }
  });

  it("resolves an old version to the words that were shown then", () => {
    // What a record naming 2026-08 must still be able to say. The English is
    // deliberately unchanged between these two versions — the meaning did not
    // move — so the difference to look for is the Burmese, which went from an
    // untranslated English fallback to an actual translation.
    expect(declarationText("registration", "2026-08", "en")).toBe(
      currentDeclarationText("registration", "en")
    );
    const oldMy = declarationText("registration", "2026-08", "my");
    expect(oldMy).toBeTruthy();
    expect(oldMy).not.toBe(currentDeclarationText("registration", "my"));
    expect(oldMy).not.toMatch(/[က-႟]/);

    // A version never offered resolves to nothing rather than to today's text.
    expect(declarationText("registration", "1999-01", "en")).toBeNull();
  });
});

describe("company declarations", () => {
  it("records the registration acceptance against the server's own version", async () => {
    const payload = helpers.companyRegistrationPayload();
    const reg = await request(app).post("/companies").send(payload).expect(201);
    const companyId: string = reg.body.company.id;

    const rows = await withContext({ userType: "platform" }, (c) =>
      c.query<{
        kind: string;
        declaration_version: string;
        company_user_id: string;
        accepted_locale: string;
      }>(
        `SELECT kind, declaration_version, company_user_id, accepted_locale
           FROM company_declarations WHERE company_id = $1`,
        [companyId]
      )
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.kind).toBe("registration");
    expect(rows.rows[0]!.declaration_version).toBe(DECLARATION_VERSIONS.registration);
    // Attributed to the person who accepted, not just to the company.
    expect(rows.rows[0]!.company_user_id).toBeTruthy();
    expect(rows.rows[0]!.accepted_locale).toBe("en");
  });

  it("records which language the declaration was read in", async () => {
    // The same version reads differently in each language, so the version alone
    // does not say what was on screen. (0033)
    const payload = {
      ...helpers.companyRegistrationPayload(),
      declaration: {
        accepted: true,
        version: DECLARATION_VERSIONS.registration,
        locale: "my",
      },
    };
    const reg = await request(app).post("/companies").send(payload).expect(201);

    const row = await withContext({ userType: "platform" }, (c) =>
      c.query<{ accepted_locale: string; declaration_version: string }>(
        `SELECT accepted_locale, declaration_version
           FROM company_declarations WHERE company_id = $1`,
        [reg.body.company.id]
      )
    );
    expect(row.rows[0]!.accepted_locale).toBe("my");

    // And that pair resolves to the words that were actually shown.
    const shown = declarationText(
      "registration",
      row.rows[0]!.declaration_version,
      row.rows[0]!.accepted_locale
    );
    expect(shown).toMatch(/[က-႟]/);
  });

  it("refuses an acceptance that does not say which language was shown", async () => {
    const noLocale = {
      ...helpers.companyRegistrationPayload(),
      declaration: { accepted: true, version: DECLARATION_VERSIONS.registration },
    };
    expect((await request(app).post("/companies").send(noLocale)).status).toBe(400);

    const badLocale = {
      ...helpers.companyRegistrationPayload(),
      declaration: { accepted: true, version: DECLARATION_VERSIONS.registration, locale: "fr" },
    };
    expect((await request(app).post("/companies").send(badLocale)).status).toBe(400);
  });

  it("refuses a registration accepting a version that is no longer on offer", async () => {
    const stale = {
      ...helpers.companyRegistrationPayload(),
      // locale supplied so this reaches the version check rather than failing
      // validation first — the point is the 409, not the 400.
      declaration: { accepted: true, version: "2019-01", locale: "en" },
    };
    const res = await request(app).post("/companies").send(stale);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("declaration_outdated");

    // Nothing was created — a refused declaration must not leave a company
    // behind with no acceptance on file.
    const found = await withContext({ userType: "platform" }, (c) =>
      c.query(`SELECT 1 FROM companies WHERE registration_number = $1`, [
        stale.company.registrationNumber,
      ])
    );
    expect(found.rowCount).toBe(0);
  });

  it("will not accept a declaration that was not accepted", async () => {
    const notAccepted = {
      ...helpers.companyRegistrationPayload(),
      declaration: {
        accepted: false,
        version: DECLARATION_VERSIONS.registration,
        locale: "en",
      },
    };
    const res = await request(app).post("/companies").send(notAccepted);
    // `accepted` is a literal true, so an unticked box cannot arrive as a value
    // the server treats as agreement.
    expect(res.status).toBe(400);
  });
});
