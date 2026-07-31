/**
 * S3-compatible object storage (MinIO locally). Evidence and verification
 * documents live here — encrypted at rest, never inlined in the database.
 * Reads are served via short-lived presigned URLs so bytes don't flow through
 * the API, and every access is audited by the caller. (§2, §5)
 */
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../config/env";

export const s3 = new S3Client({
  region: env.S3_REGION,
  endpoint: env.S3_ENDPOINT,
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY,
    secretAccessKey: env.S3_SECRET_KEY,
  },
});

export async function putObject(key: string, body: Buffer, contentType?: string): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
      // Encryption at rest for evidence and identity documents (§5). Off only
      // in local dev, where MinIO has no KMS; env.ts refuses to boot a
      // production node with S3_SSE=none. The per-file keys §5 also calls for
      // are a KMS key-scoping decision that is still open (§8).
      ...(env.S3_SSE === "none" ? {} : { ServerSideEncryption: env.S3_SSE }),
      ...(env.S3_SSE === "aws:kms" ? { SSEKMSKeyId: env.S3_SSE_KMS_KEY_ID } : {}),
    })
  );
}

/** Short-lived presigned GET URL for reviewer/owner access. */
export async function presignGet(key: string, expiresInSeconds = 300): Promise<string> {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }), {
    expiresIn: expiresInSeconds,
  });
}
