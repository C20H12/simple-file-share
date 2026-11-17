import { Client } from 'minio';
import { config } from './config.js';

const { bucket, ...clientOptions } = config.minio;

export const storage = new Client(clientOptions);
export { bucket };

// Creates the bucket on first start so uploads have somewhere to go.
export async function ensureBucket() {
  if (!(await storage.bucketExists(bucket))) await storage.makeBucket(bucket);
}
