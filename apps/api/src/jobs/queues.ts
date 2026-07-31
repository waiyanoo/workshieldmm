/**
 * BullMQ queues. (§2 Background jobs: retention purges)
 *
 * - `lifecycle`: repeatable sweep that expires/anonymizes reports past their
 *   retention date.
 */
import { Queue } from "bullmq";
import { env } from "../config/env";

const connection = { url: env.REDIS_URL };

let lifecycleQueue: Queue | null = null;

export function getLifecycleQueue(): Queue {
  lifecycleQueue ??= new Queue("lifecycle", { connection });
  return lifecycleQueue;
}

export async function closeQueues(): Promise<void> {
  await lifecycleQueue?.close();
  lifecycleQueue = null;
}
