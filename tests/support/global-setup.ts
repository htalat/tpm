import { prepareTestDatabase } from '@durable/testkit';

export default async function setup(): Promise<void> {
  await prepareTestDatabase();
}
