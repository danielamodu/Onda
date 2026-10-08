import "server-only";
import { S3Client } from "@aws-sdk/client-s3";

export const NEON_UPLOADS_BUCKET = "uploads";

let client: S3Client | undefined;

export function getNeonStorageClient(): S3Client {
  if (client) return client;

  const { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_ENDPOINT_URL_S3, AWS_REGION } = process.env;
  if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY || !AWS_ENDPOINT_URL_S3 || !AWS_REGION) {
    const missing = [
      ["AWS_ACCESS_KEY_ID", AWS_ACCESS_KEY_ID],
      ["AWS_SECRET_ACCESS_KEY", AWS_SECRET_ACCESS_KEY],
      ["AWS_ENDPOINT_URL_S3", AWS_ENDPOINT_URL_S3],
      ["AWS_REGION", AWS_REGION],
    ].filter(([, value]) => !value).map(([name]) => name);
    throw new Error(`Neon Object Storage is not configured. Missing: ${missing.join(", ")}.`);
  }

  client = new S3Client({
    region: AWS_REGION,
    endpoint: AWS_ENDPOINT_URL_S3,
    forcePathStyle: true,
    credentials: {
      accessKeyId: AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_SECRET_ACCESS_KEY,
    },
  });

  return client;
}
