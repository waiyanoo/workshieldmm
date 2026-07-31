/**
 * Platform statistics for Super Admins.
 *
 * Three questions, one period: how many companies came on board, how many
 * credits were consumed, and how much money came in for how many credits sold.
 *
 * TIMEZONE. "Today" in Yangon is not today in UTC — the offset is +6:30, so a
 * naive UTC day would put six and a half hours of Myanmar evening into the
 * wrong bucket every single day. The client computes the period boundaries in
 * the viewer's own timezone and sends instants; the day/month buckets for the
 * chart are shifted by the same offset. Nothing here guesses at a timezone.
 *
 * MONEY. Revenue counts CONFIRMED payments only, dated by `decided_at` — the
 * moment a human matched it against the wallet statement. Dating by
 * `created_at` would book revenue for intents nobody ever paid, which is the
 * kind of number that quietly becomes a board slide.
 */
import { withContext, type AppContext } from "../../db/pool";
import { badRequest } from "../../lib/errors";
import type { AuthUser } from "../../types/auth";

function ctxForUser(user: AuthUser): AppContext {
  return { userType: user.userType, userId: user.id, companyId: user.companyId };
}

export interface StatsQuery {
  from: Date;
  to: Date;
  /**
   * Minutes to add to UTC to reach the viewer's local time (Yangon = +390).
   * Used only for bucketing the chart, never for the period bounds — those
   * arrive as absolute instants.
   */
  tzOffsetMinutes: number;
}

/** Day buckets up to a quarter, then months. A 365-bar chart reads as noise. */
function bucketUnit(from: Date, to: Date): "day" | "month" {
  const days = (to.getTime() - from.getTime()) / 86_400_000;
  return days > 92 ? "month" : "day";
}

export async function getPlatformStats(admin: AuthUser, q: StatsQuery) {
  if (!(q.from instanceof Date) || Number.isNaN(q.from.getTime())) throw badRequest("Invalid from date");
  if (!(q.to instanceof Date) || Number.isNaN(q.to.getTime())) throw badRequest("Invalid to date");
  if (q.from >= q.to) throw badRequest("The start of the period must be before the end");

  const unit = bucketUnit(q.from, q.to);
  const p = [q.from, q.to, q.tzOffsetMinutes] as const;

  return withContext(ctxForUser(admin), async (client) => {
    // --- 1. Onboarding -------------------------------------------------------
    const onboarding = await client.query<{
      registered: number;
      verified: number;
      first_check: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM companies
           WHERE created_at >= $1 AND created_at < $2) AS registered,
         (SELECT count(*)::int FROM companies
           WHERE registration_verified_at >= $1 AND registration_verified_at < $2) AS verified,
         -- Companies whose very first check fell in this period: onboarding is
         -- only real once somebody actually uses the thing.
         (SELECT count(*)::int FROM (
            SELECT company_id, min(created_at) AS first_at
              FROM verification_requests GROUP BY company_id
          ) f WHERE f.first_at >= $1 AND f.first_at < $2) AS first_check`,
      [p[0], p[1]]
    );

    // Standing totals, not period-scoped — "how many companies do we have" is
    // a different question from "how many joined this week", and an operator
    // opening this page wants both.
    const totals = await client.query<{ status: string; n: number }>(
      `SELECT status, count(*)::int AS n FROM companies GROUP BY status`
    );
    const byStatus: Record<string, number> = { pending: 0, verified: 0, suspended: 0 };
    for (const row of totals.rows) byStatus[row.status] = row.n;

    // --- 2. Credits consumed -------------------------------------------------
    // Not every negative ledger entry is consumption. Credits also leave a
    // balance by lapsing (`expire.*`) and by being clawed back when a report is
    // withdrawn (`reverse.*`). Folding those into "credits used" would inflate
    // the headline with credits nobody ever spent — on the sample data, by more
    // than half. They are counted, just not as usage.
    const spend = await client.query<{ action: string; credits: number; events: number }>(
      `SELECT action, sum(-delta)::int AS credits, count(*)::int AS events
         FROM credit_ledger
        WHERE delta < 0 AND created_at >= $1 AND created_at < $2
          AND action NOT LIKE 'expire.%' AND action NOT LIKE 'reverse.%'
        GROUP BY action
        ORDER BY sum(-delta) DESC`,
      [p[0], p[1]]
    );

    const leakage = await client.query<{ expired: number; reversed: number }>(
      `SELECT COALESCE(sum(-delta) FILTER (WHERE action LIKE 'expire.%'), 0)::int AS expired,
              COALESCE(sum(-delta) FILTER (WHERE action LIKE 'reverse.%'), 0)::int AS reversed
         FROM credit_ledger
        WHERE delta < 0 AND created_at >= $1 AND created_at < $2`,
      [p[0], p[1]]
    );

    const grants = await client.query<{ reason: string; credits: number; lots: number }>(
      `SELECT reason, sum(amount)::int AS credits, count(*)::int AS lots
         FROM credit_lots
        WHERE granted_at >= $1 AND granted_at < $2
        GROUP BY reason
        ORDER BY sum(amount) DESC`,
      [p[0], p[1]]
    );

    // What is sitting unspent right now, and what will lapse in the next 30
    // days — an unearned liability and a customer-service problem respectively.
    const outstanding = await client.query<{ live: number; expiring_30d: number }>(
      `SELECT COALESCE(sum(remaining), 0)::int AS live,
              COALESCE(sum(remaining) FILTER (
                WHERE expires_at < now() + interval '30 days'), 0)::int AS expiring_30d
         FROM credit_lots WHERE remaining > 0 AND expires_at > now()`
    );

    const spendingCompanies = await client.query<{ n: number }>(
      `SELECT count(DISTINCT company_id)::int AS n FROM credit_ledger
        WHERE delta < 0 AND created_at >= $1 AND created_at < $2
          AND action NOT LIKE 'expire.%' AND action NOT LIKE 'reverse.%'`,
      [p[0], p[1]]
    );

    // --- 3. Purchases and revenue -------------------------------------------
    const revenue = await client.query<{
      kind: string;
      payments: number;
      amount_mmk: string;
      credits: number;
    }>(
      `SELECT COALESCE(kind, 'credit_pack') AS kind,
              count(*)::int AS payments,
              COALESCE(sum(amount_mmk), 0)::bigint AS amount_mmk,
              COALESCE(sum(credits), 0)::int AS credits
         FROM payment_intents
        WHERE status = 'confirmed' AND decided_at >= $1 AND decided_at < $2
        GROUP BY COALESCE(kind, 'credit_pack')`,
      [p[0], p[1]]
    );

    const byProvider = await client.query<{ provider: string; payments: number; amount_mmk: string }>(
      `SELECT provider, count(*)::int AS payments,
              COALESCE(sum(amount_mmk), 0)::bigint AS amount_mmk
         FROM payment_intents
        WHERE status = 'confirmed' AND decided_at >= $1 AND decided_at < $2
        GROUP BY provider
        ORDER BY sum(amount_mmk) DESC`,
      [p[0], p[1]]
    );

    // Money that has been declared paid but not yet reconciled, and payments we
    // turned away. Both are operational: one is a queue, the other a warning.
    const pipeline = await client.query<{
      awaiting_review: number;
      awaiting_review_mmk: string;
      rejected: number;
    }>(
      `SELECT count(*) FILTER (WHERE status = 'submitted')::int AS awaiting_review,
              COALESCE(sum(amount_mmk) FILTER (WHERE status = 'submitted'), 0)::bigint
                AS awaiting_review_mmk,
              count(*) FILTER (
                WHERE status = 'rejected' AND decided_at >= $1 AND decided_at < $2
              )::int AS rejected
         FROM payment_intents`,
      [p[0], p[1]]
    );

    // --- 4. Conduct report review -------------------------------------------
    // Tier B is the part of the platform that makes claims about people, so the
    // numbers that matter are not volume but the shape of the decisions: what
    // share of submissions the evidence actually supported, and how long
    // somebody waited to find out.
    const reports = await client.query<{
      submitted: number;
      accepted: number;
      rejected: number;
      withdrawn: number;
      expired: number;
      drafted: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM conduct_reports
           WHERE submitted_at >= $1 AND submitted_at < $2) AS submitted,
         (SELECT count(*)::int FROM conduct_reports
           WHERE created_at >= $1 AND created_at < $2) AS drafted,
         -- Decisions are dated from review_cases, which records one row per
         -- decision with the reviewer and the timestamp. Counting by the
         -- report's CURRENT status instead would move a decision's date every
         -- time the report later changed state.
         (SELECT count(*)::int FROM review_cases
           WHERE decision = 'evidence_sufficient'
             AND decided_at >= $1 AND decided_at < $2) AS accepted,
         (SELECT count(*)::int FROM review_cases
           WHERE decision = 'evidence_insufficient'
             AND decided_at >= $1 AND decided_at < $2) AS rejected,
         -- No decision row exists for these two: a withdrawal is the employer's
         -- act and expiry is the retention sweep's, so both are dated by the
         -- state change on the report itself.
         (SELECT count(*)::int FROM conduct_reports
           WHERE status = 'withdrawn' AND updated_at >= $1 AND updated_at < $2) AS withdrawn,
         (SELECT count(*)::int FROM conduct_reports
           WHERE status = 'expired' AND updated_at >= $1 AND updated_at < $2) AS expired`,
      [p[0], p[1]]
    );

    const reportQueue = await client.query<{
      pending: number;
      oldest_hours: number | null;
      published: number;
    }>(
      `SELECT count(*) FILTER (WHERE status = 'pending_review')::int AS pending,
              EXTRACT(EPOCH FROM (now() - min(submitted_at)
                FILTER (WHERE status = 'pending_review'))) / 3600 AS oldest_hours,
              count(*) FILTER (WHERE status = 'approved')::int AS published
         FROM conduct_reports`
    );

    // Turnaround from SUBMISSION, not from when the draft was opened — the
    // drafting time belongs to the employer. (0022)
    const reportTurnaround = await client.query<{
      decided: number;
      avg_hours: number | null;
      median_hours: number | null;
      p90_hours: number | null;
    }>(
      `SELECT count(*)::int AS decided,
              AVG(EXTRACT(EPOCH FROM (rc.decided_at - r.submitted_at)) / 3600) AS avg_hours,
              PERCENTILE_CONT(0.5) WITHIN GROUP (
                ORDER BY EXTRACT(EPOCH FROM (rc.decided_at - r.submitted_at)) / 3600
              ) AS median_hours,
              PERCENTILE_CONT(0.9) WITHIN GROUP (
                ORDER BY EXTRACT(EPOCH FROM (rc.decided_at - r.submitted_at)) / 3600
              ) AS p90_hours
         FROM review_cases rc
         JOIN conduct_reports r ON r.id = rc.report_id
        WHERE rc.decided_at >= $1 AND rc.decided_at < $2
          AND r.submitted_at IS NOT NULL
          AND rc.decided_at >= r.submitted_at`,
      [p[0], p[1]]
    );

    const byCategory = await client.query<{
      name: string;
      submitted: number;
      accepted: number;
      rejected: number;
    }>(
      `SELECT rc_cat.name,
              count(*) FILTER (
                WHERE r.submitted_at >= $1 AND r.submitted_at < $2)::int AS submitted,
              count(*) FILTER (
                WHERE rc.decision = 'evidence_sufficient'
                  AND rc.decided_at >= $1 AND rc.decided_at < $2)::int AS accepted,
              count(*) FILTER (
                WHERE rc.decision = 'evidence_insufficient'
                  AND rc.decided_at >= $1 AND rc.decided_at < $2)::int AS rejected
         FROM conduct_reports r
         JOIN report_categories rc_cat ON rc_cat.id = r.category_id
         LEFT JOIN review_cases rc ON rc.report_id = r.id
        GROUP BY rc_cat.name
       HAVING count(*) FILTER (WHERE r.submitted_at >= $1 AND r.submitted_at < $2) > 0
           OR count(*) FILTER (WHERE rc.decided_at >= $1 AND rc.decided_at < $2) > 0
        ORDER BY 2 DESC, 1`,
      [p[0], p[1]]
    );

    // Who decided what. Not a leaderboard — it is here so a single reviewer
    // accepting everything, or rejecting everything, is visible rather than
    // averaged away across the team.
    const byReviewer = await client.query<{
      reviewer: string;
      accepted: number;
      rejected: number;
    }>(
      `SELECT COALESCE(pu.full_name, 'Unknown') AS reviewer,
              count(*) FILTER (WHERE rc.decision = 'evidence_sufficient')::int AS accepted,
              count(*) FILTER (WHERE rc.decision = 'evidence_insufficient')::int AS rejected
         FROM review_cases rc
         LEFT JOIN platform_users pu ON pu.id = rc.reviewer_id
        WHERE rc.decided_at >= $1 AND rc.decided_at < $2
        GROUP BY COALESCE(pu.full_name, 'Unknown')
        ORDER BY count(*) DESC`,
      [p[0], p[1]]
    );

    // Cross-company access to a published report is the audited read that Tier B
    // exists to control, so its volume belongs next to the review numbers.
    const access = await client.query<{
      requested: number;
      approved: number;
      denied: number;
      open: number;
    }>(
      `SELECT count(*) FILTER (
                WHERE requested_at >= $1 AND requested_at < $2)::int AS requested,
              count(*) FILTER (
                WHERE status = 'approved' AND decided_at >= $1 AND decided_at < $2)::int AS approved,
              count(*) FILTER (
                WHERE status = 'denied' AND decided_at >= $1 AND decided_at < $2)::int AS denied,
              count(*) FILTER (WHERE status = 'requested')::int AS open
         FROM access_requests`,
      [p[0], p[1]]
    );

    // --- 5. Series for the chart --------------------------------------------
    // One row per bucket even where nothing happened, so the chart has no
    // silent gaps and the client does not have to fill them in.
    const series = await client.query<{
      bucket: string;
      registered: number;
      verified: number;
      credits_used: number;
      credits_sold: number;
      revenue_mmk: string;
    }>(
      // Everything below runs on `timestamp` (no zone), never `timestamptz`.
      // date_trunc() and to_char() both resolve a timestamptz against the
      // SERVER's TimeZone setting, so on a server that is not UTC the buckets
      // would silently shift. `AT TIME ZONE 'UTC'` pins the instant to a plain
      // wall-clock value first, the offset moves it to the viewer's local
      // clock, and from there the arithmetic has no timezone left to get wrong.
      `WITH bounds AS (
         SELECT ($1::timestamptz AT TIME ZONE 'UTC') + make_interval(mins => $3::int) AS lo,
                ($2::timestamptz AT TIME ZONE 'UTC') + make_interval(mins => $3::int) AS hi
       ),
       buckets AS (
         SELECT generate_series(
           date_trunc($4, (SELECT lo FROM bounds)),
           -- One millisecond back so a period ending exactly on midnight does
           -- not produce a trailing empty bucket for the next day.
           date_trunc($4, (SELECT hi FROM bounds) - interval '1 millisecond'),
           ('1 ' || $4)::interval
         ) AS bucket
       )
       SELECT to_char(b.bucket, 'YYYY-MM-DD') AS bucket,
         (SELECT count(*) FROM companies c
           WHERE c.created_at >= $1 AND c.created_at < $2
             AND date_trunc($4, (c.created_at AT TIME ZONE 'UTC')
                                + make_interval(mins => $3::int)) = b.bucket
         )::int AS registered,
         (SELECT count(*) FROM companies c
           WHERE c.registration_verified_at >= $1 AND c.registration_verified_at < $2
             AND date_trunc($4, (c.registration_verified_at AT TIME ZONE 'UTC')
                                + make_interval(mins => $3::int)) = b.bucket
         )::int AS verified,
         (SELECT COALESCE(sum(-l.delta), 0) FROM credit_ledger l
           WHERE l.delta < 0 AND l.created_at >= $1 AND l.created_at < $2
             AND l.action NOT LIKE 'expire.%' AND l.action NOT LIKE 'reverse.%'
             AND date_trunc($4, (l.created_at AT TIME ZONE 'UTC')
                                + make_interval(mins => $3::int)) = b.bucket
         )::int AS credits_used,
         (SELECT COALESCE(sum(pi.credits), 0) FROM payment_intents pi
           WHERE pi.status = 'confirmed' AND pi.decided_at >= $1 AND pi.decided_at < $2
             AND date_trunc($4, (pi.decided_at AT TIME ZONE 'UTC')
                                + make_interval(mins => $3::int)) = b.bucket
         )::int AS credits_sold,
         (SELECT COALESCE(sum(pi.amount_mmk), 0) FROM payment_intents pi
           WHERE pi.status = 'confirmed' AND pi.decided_at >= $1 AND pi.decided_at < $2
             AND date_trunc($4, (pi.decided_at AT TIME ZONE 'UTC')
                                + make_interval(mins => $3::int)) = b.bucket
         )::bigint AS revenue_mmk
       FROM buckets b ORDER BY b.bucket`,
      [p[0], p[1], p[2], unit]
    );

    const rep = reports.rows[0]!;
    const rt = reportTurnaround.rows[0]!;
    const decided = rep.accepted + rep.rejected;
    /** Hours to one decimal, or null when there is nothing to average. */
    const round1 = (v: number | null) => (v === null ? null : Math.round(Number(v) * 10) / 10);

    const kindRow = (kind: string) => revenue.rows.find((r) => r.kind === kind);
    const packs = kindRow("credit_pack");
    const subs = kindRow("subscription");
    const totalRevenue = revenue.rows.reduce((sum, r) => sum + Number(r.amount_mmk), 0);

    return {
      period: { from: q.from.toISOString(), to: q.to.toISOString(), bucket: unit },
      onboarding: {
        registered: onboarding.rows[0]!.registered,
        verified: onboarding.rows[0]!.verified,
        firstCheck: onboarding.rows[0]!.first_check,
        // Standing counts, all time.
        totals: {
          pending: byStatus.pending ?? 0,
          verified: byStatus.verified ?? 0,
          suspended: byStatus.suspended ?? 0,
          all: Object.values(byStatus).reduce((a, b) => a + b, 0),
        },
      },
      credits: {
        used: spend.rows.reduce((sum, r) => sum + r.credits, 0),
        usedBy: spend.rows.map((r) => ({
          action: r.action,
          credits: r.credits,
          events: r.events,
        })),
        granted: grants.rows.reduce((sum, r) => sum + r.credits, 0),
        grantedBy: grants.rows.map((r) => ({
          reason: r.reason,
          credits: r.credits,
          lots: r.lots,
        })),
        // Left the balance without being spent. Expiry is the term customers
        // notice; a rising number here is a pricing conversation.
        expired: leakage.rows[0]!.expired,
        reversed: leakage.rows[0]!.reversed,
        spendingCompanies: spendingCompanies.rows[0]!.n,
        outstanding: outstanding.rows[0]!.live,
        expiringNext30Days: outstanding.rows[0]!.expiring_30d,
      },
      purchases: {
        creditsSold: packs?.credits ?? 0,
        creditPackPayments: packs?.payments ?? 0,
        creditPackMmk: Number(packs?.amount_mmk ?? 0),
        subscriptionPayments: subs?.payments ?? 0,
        subscriptionMmk: Number(subs?.amount_mmk ?? 0),
        totalMmk: totalRevenue,
        byProvider: byProvider.rows.map((r) => ({
          provider: r.provider,
          payments: r.payments,
          amountMmk: Number(r.amount_mmk),
        })),
        awaitingReview: pipeline.rows[0]!.awaiting_review,
        awaitingReviewMmk: Number(pipeline.rows[0]!.awaiting_review_mmk),
        rejected: pipeline.rows[0]!.rejected,
      },
      reports: {
        drafted: rep.drafted,
        submitted: rep.submitted,
        accepted: rep.accepted,
        rejected: rep.rejected,
        withdrawn: rep.withdrawn,
        expired: rep.expired,
        decided,
        // The share of decided reports the evidence actually supported. Null
        // rather than 0 when nothing was decided — "0% accepted" and "nothing
        // to accept" are different statements and only one of them is alarming.
        acceptanceRate: decided > 0 ? Math.round((rep.accepted / decided) * 1000) / 10 : null,
        pending: reportQueue.rows[0]!.pending,
        oldestPendingHours:
          reportQueue.rows[0]!.oldest_hours === null
            ? null
            : Math.round(Number(reportQueue.rows[0]!.oldest_hours) * 10) / 10,
        published: reportQueue.rows[0]!.published,
        turnaround: {
          decided: rt.decided,
          avgHours: round1(rt.avg_hours),
          medianHours: round1(rt.median_hours),
          p90Hours: round1(rt.p90_hours),
        },
        byCategory: byCategory.rows.map((c) => ({
          name: c.name,
          submitted: c.submitted,
          accepted: c.accepted,
          rejected: c.rejected,
        })),
        byReviewer: byReviewer.rows.map((r) => ({
          reviewer: r.reviewer,
          accepted: r.accepted,
          rejected: r.rejected,
        })),
        access: {
          requested: access.rows[0]!.requested,
          approved: access.rows[0]!.approved,
          denied: access.rows[0]!.denied,
          open: access.rows[0]!.open,
        },
      },
      series: series.rows.map((r) => ({
        bucket: r.bucket,
        registered: r.registered,
        verified: r.verified,
        creditsUsed: r.credits_used,
        creditsSold: r.credits_sold,
        revenueMmk: Number(r.revenue_mmk),
      })),
    };
  });
}
