import { S3Client } from '@aws-sdk/client-s3';

const endpoint = process.env.S3_ENDPOINT;
if (!endpoint) throw new Error('S3_ENDPOINT not set');

export const s3 = new S3Client({
  endpoint,
  region: process.env.S3_REGION ?? 'us-east-1',
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY ?? '',
    secretAccessKey: process.env.S3_SECRET_KEY ?? '',
  },
});

export const bucket = process.env.S3_BUCKET ?? 'dam-raw';
