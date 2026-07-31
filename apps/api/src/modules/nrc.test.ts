/**
 * NRC normalisation, and what it means for subject identity.
 *
 * The NRC hash IS the subject key. Two employers entering the same person have
 * to produce the same bytes or the platform quietly holds two people, and the
 * cross-company history it exists to surface splits in half.
 *
 * The second test is the one that protects the existing database: normalisation
 * must be a no-op on anything that is not a well-formed NRC, so identifiers
 * already stored keep their hash and nothing needs re-keying.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { formatNrc, normalizeNrc, parseNrc, isKnownTownship } from "@hyper/shared";

let app: Express;
let pool: typeof import("../db/pool").pool;
let redis: typeof import("../lib/redis").redis;
let helpers: typeof import("../test/helpers");
let closeQueues: typeof import("../jobs/queues").closeQueues;
let hashNationalId: typeof import("../lib/crypto").hashNationalId;

beforeAll(async () => {
  app = (await import("../app")).createApp();
  ({ pool } = await import("../db/pool"));
  ({ redis } = await import("../lib/redis"));
  helpers = await import("../test/helpers");
  ({ closeQueues } = await import("../jobs/queues"));
  ({ hashNationalId } = await import("../lib/crypto"));
});

afterAll(async () => {
  await Promise.allSettled([closeQueues(), pool.end(), redis.quit()]);
});

const PDF = Buffer.from("%PDF-1.4 doc");

async function loginPlatform(user: { email: string; password: string; totp: () => string }) {
  const res = await request(app)
    .post("/auth/login")
    .send({ email: user.email, password: user.password, mfaCode: user.totp() });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

async function provisionCompany(adminToken: string) {
  const reg = await request(app).post("/companies").send(helpers.companyRegistrationPayload());
  expect(reg.status).toBe(201);
  const companyId: string = reg.body.company.id;
  const token: string = reg.body.accessToken;
  for (const [docType, filename, contentType] of [
    ["dica_certificate", "dica.pdf", "application/pdf"],
    ["nrc", "nrc.png", "image/png"],
  ] as const) {
    await request(app)
      .post(`/companies/${companyId}/documents`)
      .set("Authorization", `Bearer ${token}`)
      .field("docType", docType)
      .attach("file", PDF, { filename, contentType })
      .expect(201);
  }
  await helpers.approveCompanyDocuments(app, companyId, adminToken);
  await request(app)
    .post(`/companies/${companyId}/verify`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({})
    .expect(200);
  return { companyId, token };
}

describe("NRC normalisation", () => {
  it("parses the ways people actually type an NRC into one canonical form", () => {
    const canonical = "12/OUKAMA(N)123456";
    for (const variant of [
      "12/OUKAMA(N)123456",
      "12/oukama(n)123456",
      "12 / OuKaMa (N) 123456",
      "  12/OUKAMA(N)123456  ",
      "12/OUKAMA[N]123456",
      "12/OUKAMA{N}123456",
      // Burmese numerals, which is how a card is often copied out.
      "၁၂/OUKAMA(N)၁၂၃၄၅၆",
    ]) {
      expect(normalizeNrc(variant), variant).toBe(canonical);
      expect(hashNationalId(variant), variant).toBe(hashNationalId(canonical));
    }
  });

  it("leaves anything that is not an NRC exactly as it was", () => {
    // The guarantee that lets this ship without re-keying the subjects table:
    // a value already stored keeps its hash unless it was a well-formed NRC
    // typed non-canonically, which is precisely the case that was already
    // creating duplicate subjects.
    for (const notAnNrc of [
      "12/RPT(N)-1785490292270-22",
      "PASSPORT-A1234567",
      "12/OUKAMA(N)12345", // five digits
      "99/OUKAMA(N)123456", // no such state
      "",
    ]) {
      expect(normalizeNrc(notAnNrc)).toBe(notAnNrc.trim());
      expect(parseNrc(notAnNrc)).toBeNull();
    }
  });

  it("round-trips parts through format and back", () => {
    const parts = { state: 9, township: "MAHTALA", type: "N", number: "004321" };
    expect(formatNrc(parts)).toBe("9/MAHTALA(N)004321");
    expect(parseNrc(formatNrc(parts))).toEqual(parts);
    // Leading zeros survive: they are part of the identifier, not arithmetic.
    expect(parseNrc("9/MAHTALA(N)004321")!.number).toBe("004321");
  });

  it("knows real township codes and does not pretend to know invented ones", () => {
    expect(isKnownTownship(12, "OUKAMA")).toBe(true);
    expect(isKnownTownship(12, "oukama")).toBe(true); // case is not the user's problem
    expect(isKnownTownship(9, "MAHTALA")).toBe(true);
    expect(isKnownTownship(12, "NOTAREALCODE")).toBe(false);
    // Right code, wrong state — the codes are scoped per state.
    expect(isKnownTownship(1, "OUKAMA")).toBe(false);
  });

  it("requires the authorised person's NRC at registration and stores it canonically", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());

    // Missing entirely: refused. The reviewer needs a number to check the
    // uploaded NRC scan against, so it is not optional. (0024)
    const payload = helpers.companyRegistrationPayload();
    const { nationalId, ...adminWithout } = payload.admin;
    void nationalId;
    const missing = await request(app)
      .post("/companies")
      .send({ ...payload, admin: adminWithout });
    expect(missing.status).toBe(400);

    // Typed loosely: accepted, and stored in canonical form.
    const sloppy = helpers.companyRegistrationPayload();
    const reg = await request(app)
      .post("/companies")
      .send({ ...sloppy, admin: { ...sloppy.admin, nationalId: "9 / mahtala (n) 004321" } });
    expect(reg.status).toBe(201);

    const detail = await request(app)
      .get(`/companies/${reg.body.company.id}/detail`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);
    expect(detail.body.users[0].nationalId).toBe("9/MAHTALA(N)004321");

    // The person sees their own, and cannot edit it.
    const profile = await request(app)
      .get("/profile")
      .set("Authorization", `Bearer ${reg.body.accessToken}`)
      .expect(200);
    expect(profile.body.me.nationalId).toBe("9/MAHTALA(N)004321");
    expect(profile.body.lockedFields).toContain("nationalId");

    await request(app)
      .patch("/profile/me")
      .set("Authorization", `Bearer ${reg.body.accessToken}`)
      .send({ nationalId: "1/AHGAYA(N)999999" })
      .expect(400);
  });

  it("resolves two spellings of one person to a single subject", async () => {
    const adminToken = await loginPlatform(await helpers.createSuperAdmin());
    const a = await provisionCompany(adminToken);
    const b = await provisionCompany(adminToken);

    // Same person, entered by two employers who type differently. Before
    // normalisation these produced two subjects and neither company could see
    // the other's check.
    const first = await request(app)
      .post("/verifications")
      .set("Authorization", `Bearer ${a.token}`)
      .send({ subject: { fullName: "Daw Mya Mya", nationalId: "12/OUKAMA(N)778899" } })
      .expect(201);

    const second = await request(app)
      .post("/verifications")
      .set("Authorization", `Bearer ${b.token}`)
      .send({ subject: { fullName: "Daw Mya Mya", nationalId: "12 / oukama (n) 778899" } })
      .expect(201);

    expect(second.body.subjectId).toBe(first.body.subjectId);

    // And the reviewer sees the canonical form, not whichever spelling arrived.
    const ctx = await request(app)
      .get(`/admin/verifications/${second.body.id}/context`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);
    expect(ctx.body.subject.nationalId).toBe("12/OUKAMA(N)778899");
    // The first company's check on the same person is now visible as history.
    expect(ctx.body.priorChecks.length).toBeGreaterThanOrEqual(1);
  });
});
