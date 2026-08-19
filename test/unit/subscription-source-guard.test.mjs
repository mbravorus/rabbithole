import { assertNoDeletedSubscriptionMechanisms } from "../support/subscription-source-guard.mjs";

const result = await assertNoDeletedSubscriptionMechanisms();
process.stdout.write(`subscription source guard ok files=${result.files}\n`);
