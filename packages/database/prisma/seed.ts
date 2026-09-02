/**
 * Development seed.
 *
 * Idempotent: safe to run repeatedly against the same database. Every credential here is a
 * throwaway development value and must never appear in any other environment — the production
 * bootstrap path is a separate command that reads real values from the environment.
 */
import 'dotenv/config';
import { hash } from '@node-rs/argon2';
import { PrismaClient } from '@prisma/client';
import { v7 as uuidv7 } from 'uuid';
import { ID_PREFIX, isPublicId } from '../src/ids.js';

const prisma = new PrismaClient();

const ARGON2 = { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1, outputLen: 32 };

const DEMO_PASSWORD = 'Demo!Passw0rd';

/**
 * A fixed public id for the demo property, so the test site's installation snippet can be baked in
 * at build time.
 *
 * It must be valid Crockford base32 - no I, L, O or U. An earlier value spelled out
 * "DEMO TEST SITE", which contains both O and I, and the widget loader correctly refused to load
 * for it. The assertion below turns that from a silent, confusing failure into a failed seed.
 */
const DEMO_PROPERTY_PUBLIC_ID = 'prp_DEMKTESTSTE00001';

if (!isPublicId(DEMO_PROPERTY_PUBLIC_ID, ID_PREFIX.property)) {
  throw new Error(
    `Seed misconfigured: "${DEMO_PROPERTY_PUBLIC_ID}" is not a valid public id. ` +
      'Public ids use Crockford base32, which excludes I, L, O and U.',
  );
}

const PLANS = [
  {
    code: 'free',
    name: 'Free',
    tagline: 'Everything you need to answer your first thousand questions.',
    priceMonthlyCents: 0,
    // Free is free either way. Stored rather than special-cased, so the pricing page can render
    // every plan with one code path.
    priceYearlyCents: 0,
    isContactSales: false,
    sortOrder: 1,
    features: {
      max_properties: 1,
      max_agents: 2,
      max_monthly_conversations: 500,
      max_storage_bytes: 1_073_741_824,
      max_kb_articles: 25,
      max_webhooks: 1,
      max_triggers: 3,
      max_shortcuts: 10,
      max_api_requests_per_day: 1_000,
      max_conversation_history_days: 90,
    },
    flags: {
      feature_knowledge_base: true,
      feature_tickets: false,
      feature_triggers: true,
      feature_webhooks: false,
      feature_public_api: false,
      feature_remove_branding: false,
      feature_custom_roles: false,
      feature_file_attachments: true,
    },
  },
  {
    code: 'starter',
    name: 'Starter',
    tagline: 'For a growing team that has outgrown one shared inbox.',
    priceMonthlyCents: 2900,
    // Twelve months for the price of ten. The discount is stored, not computed, so changing it is
    // a commercial decision somebody makes rather than a constant somebody finds.
    priceYearlyCents: 29_000,
    isContactSales: false,
    sortOrder: 2,
    features: {
      max_properties: 5,
      max_agents: 10,
      max_monthly_conversations: 10_000,
      max_storage_bytes: 21_474_836_480,
      max_kb_articles: 500,
      max_webhooks: 10,
      max_triggers: 50,
      max_shortcuts: 200,
      max_api_requests_per_day: 50_000,
      max_conversation_history_days: 365,
    },
    flags: {
      feature_knowledge_base: true,
      feature_tickets: true,
      feature_triggers: true,
      feature_webhooks: true,
      feature_public_api: true,
      feature_remove_branding: true,
      feature_custom_roles: true,
      feature_file_attachments: true,
    },
  },
  {
    code: 'pro',
    name: 'Pro',
    tagline: 'Unlimited conversations, and the whole product switched on.',
    priceMonthlyCents: 9900,
    priceYearlyCents: 99_000,
    isContactSales: false,
    sortOrder: 3,
    features: {
      max_properties: 50,
      max_agents: 100,
      max_monthly_conversations: null,
      max_storage_bytes: 214_748_364_800,
      max_kb_articles: null,
      max_webhooks: 100,
      max_triggers: null,
      max_shortcuts: null,
      max_api_requests_per_day: 1_000_000,
      max_conversation_history_days: null,
    },
    flags: {
      feature_knowledge_base: true,
      feature_tickets: true,
      feature_triggers: true,
      feature_webhooks: true,
      feature_public_api: true,
      feature_remove_branding: true,
      feature_custom_roles: true,
      feature_file_attachments: true,
    },
  },
  /**
   * Enterprise is a real plan row with real entitlements, and deliberately not self-serve.
   *
   * `isContactSales` is what makes that honest rather than decorative: the pricing page shows
   * "Talk to us" instead of a price, and the API refuses a change request naming it. An operator
   * assigns it in the console after an actual conversation. A plan a customer could select and
   * then not be charged for would be exactly the fake button this project does not ship.
   */
  {
    code: 'enterprise',
    name: 'Enterprise',
    tagline: 'Volume, procurement, and an agreement written for you.',
    priceMonthlyCents: 0,
    priceYearlyCents: 0,
    isContactSales: true,
    sortOrder: 4,
    features: {
      max_properties: null,
      max_agents: null,
      max_monthly_conversations: null,
      max_storage_bytes: null,
      max_kb_articles: null,
      max_webhooks: null,
      max_triggers: null,
      max_shortcuts: null,
      max_api_requests_per_day: null,
      max_conversation_history_days: null,
    },
    flags: {
      feature_knowledge_base: true,
      feature_tickets: true,
      feature_triggers: true,
      feature_webhooks: true,
      feature_public_api: true,
      feature_remove_branding: true,
      feature_custom_roles: true,
      feature_file_attachments: true,
    },
  },
];

const ALL_PERMISSIONS = [
  'account:view',
  'account:update',
  'account:billing',
  'account:delete',
  'member:view',
  'member:invite',
  'member:update',
  'member:remove',
  'role:manage',
  'property:view',
  'property:create',
  'property:update',
  'property:delete',
  'widget:view',
  'widget:update',
  'conversation:view_assigned',
  'conversation:view_all',
  'conversation:reply',
  'conversation:assign',
  'conversation:transfer',
  'conversation:close',
  'conversation:delete',
  'conversation:note',
  'conversation:tag',
  'visitor:view',
  'contact:view',
  'contact:update',
  'contact:delete',
  'trigger:view',
  'trigger:manage',
  'shortcut:view',
  'shortcut:manage',
  'kb:view',
  'kb:manage',
  'ticket:view',
  'ticket:manage',
  'report:view',
  'webhook:manage',
  'apikey:manage',
  'audit:view',
];

const ROLE_PERMISSIONS: Record<string, string[]> = {
  owner: ALL_PERMISSIONS,
  admin: ALL_PERMISSIONS.filter((p) => p !== 'account:delete' && p !== 'account:billing'),
  manager: [
    'account:view',
    'member:view',
    'property:view',
    'widget:view',
    'widget:update',
    'conversation:view_all',
    'conversation:reply',
    'conversation:assign',
    'conversation:transfer',
    'conversation:close',
    'conversation:note',
    'conversation:tag',
    'visitor:view',
    'contact:view',
    'contact:update',
    'trigger:view',
    'trigger:manage',
    'shortcut:view',
    'shortcut:manage',
    'kb:view',
    'kb:manage',
    'ticket:view',
    'ticket:manage',
    'report:view',
  ],
  agent: [
    'property:view',
    'conversation:view_assigned',
    'conversation:reply',
    'conversation:close',
    'conversation:note',
    'conversation:tag',
    'visitor:view',
    'contact:view',
    'shortcut:view',
    'kb:view',
    'ticket:view',
  ],
};

async function seedPlans(): Promise<Map<string, string>> {
  const ids = new Map<string, string>();

  for (const plan of PLANS) {
    const record = await prisma.plan.upsert({
      where: { code: plan.code },
      // Every field is in `update` as well as `create`. A seed that only sets a column on first
      // insert silently stops maintaining it, and the price on an existing environment then
      // disagrees with the price in this file - which is the sort of drift nobody notices until a
      // customer is billed for it.
      update: {
        name: plan.name,
        tagline: plan.tagline,
        priceMonthlyCents: plan.priceMonthlyCents,
        priceYearlyCents: plan.priceYearlyCents,
        isContactSales: plan.isContactSales,
        sortOrder: plan.sortOrder,
      },
      create: {
        id: uuidv7(),
        code: plan.code,
        name: plan.name,
        description: `${plan.name} plan`,
        tagline: plan.tagline,
        priceMonthlyCents: plan.priceMonthlyCents,
        priceYearlyCents: plan.priceYearlyCents,
        isContactSales: plan.isContactSales,
        sortOrder: plan.sortOrder,
      },
    });
    ids.set(plan.code, record.id);

    for (const [key, limitValue] of Object.entries(plan.features)) {
      await prisma.planFeature.upsert({
        where: { planId_key: { planId: record.id, key } },
        update: { limitValue: limitValue === null ? null : BigInt(limitValue) },
        create: {
          id: uuidv7(),
          planId: record.id,
          key,
          limitValue: limitValue === null ? null : BigInt(limitValue),
        },
      });
    }

    for (const [key, boolValue] of Object.entries(plan.flags)) {
      await prisma.planFeature.upsert({
        where: { planId_key: { planId: record.id, key } },
        update: { boolValue },
        create: { id: uuidv7(), planId: record.id, key, boolValue },
      });
    }
  }

  console.log(`  plans: ${PLANS.map((p) => p.code).join(', ')}`);
  return ids;
}

async function seedPlatformAdmin(): Promise<void> {
  const email = process.env['SUPERADMIN_EMAIL'] ?? 'admin@smartchat.local';
  const password = process.env['SUPERADMIN_PASSWORD'] ?? 'ChangeMe!SuperAdmin1';

  await prisma.platformAdmin.upsert({
    where: { email },
    update: {},
    create: {
      id: uuidv7(),
      email,
      name: 'Platform Administrator',
      passwordHash: await hash(password, ARGON2),
      permissions: [
        'platform:account:view',
        'platform:account:suspend',
        'platform:plan:manage',
        'platform:usage:view',
        'platform:system:view',
        'platform:flag:manage',
        'platform:audit:view',
        'platform:settings:manage',
      ],
    },
  });

  console.log(`  platform admin: ${email}`);
}

async function seedDemoAccount(planIds: Map<string, string>): Promise<void> {
  const passwordHash = await hash(DEMO_PASSWORD, ARGON2);
  const now = new Date();

  const owner = await prisma.user.upsert({
    where: { email: 'owner@demo.test' },
    update: {},
    create: {
      id: uuidv7(),
      email: 'owner@demo.test',
      name: 'Dana Owner',
      passwordHash,
      emailVerifiedAt: now,
      timezone: 'Asia/Dhaka',
    },
  });

  const agent = await prisma.user.upsert({
    where: { email: 'agent@demo.test' },
    update: {},
    create: {
      id: uuidv7(),
      email: 'agent@demo.test',
      name: 'Alex Agent',
      passwordHash,
      emailVerifiedAt: now,
      timezone: 'Asia/Dhaka',
    },
  });

  const existing = await prisma.account.findUnique({ where: { slug: 'abc-digital' } });
  if (existing) {
    console.log('  demo account already present - leaving it untouched');
    return;
  }

  /**
   * One transaction for the whole demo account.
   *
   * An earlier version created the account, members and subscription as separate statements. When
   * a later one failed, the account existed without its property - and because the guard above
   * then saw an existing account, re-running the seed silently skipped the repair. Atomicity is
   * what makes "safe to run repeatedly" actually true.
   */
  const property = await prisma.$transaction(async (tx) => {
    const account = await tx.account.create({
      data: {
        id: uuidv7(),
        name: 'ABC Digital',
        slug: 'abc-digital',
        ownerUserId: owner.id,
        timezone: 'Asia/Dhaka',
        roles: {
          create: Object.entries(ROLE_PERMISSIONS).map(([key, permissions]) => ({
            id: uuidv7(),
            key,
            name: key.charAt(0).toUpperCase() + key.slice(1),
            description: `Default ${key} role`,
            permissions,
            isSystem: true,
          })),
        },
      },
      include: { roles: true },
    });

    const roleId = (key: string) => account.roles.find((role) => role.key === key)?.id ?? null;

    await tx.accountMember.createMany({
      data: [
        {
          id: uuidv7(),
          accountId: account.id,
          userId: owner.id,
          baseRole: 'owner',
          roleId: roleId('owner'),
          status: 'active',
          joinedAt: now,
        },
        {
          id: uuidv7(),
          accountId: account.id,
          userId: agent.id,
          baseRole: 'agent',
          roleId: roleId('agent'),
          status: 'active',
          joinedAt: now,
          title: 'Support Agent',
        },
      ],
    });

    await tx.subscription.create({
      data: {
        id: uuidv7(),
        accountId: account.id,
        planId: planIds.get('starter')!,
        status: 'active',
        currentPeriodStart: now,
        currentPeriodEnd: new Date(now.getTime() + 30 * 24 * 3600 * 1000),
      },
    });

    return tx.property.create({
      data: {
        id: uuidv7(),
        accountId: account.id,
        publicId: DEMO_PROPERTY_PUBLIC_ID,
        name: 'Demo Test Site',
        websiteUrl: 'http://localhost:3004',
        timezone: 'Asia/Dhaka',
        // accountId is part of the composite relation, so Prisma derives it from the parent -
        // passing it explicitly in a nested create is rejected.
        domains: {
          create: [
            { id: uuidv7(), pattern: 'localhost', isWildcard: false },
            { id: uuidv7(), pattern: '127.0.0.1', isWildcard: false },
          ],
        },
      },
    });
  });

  console.log(
    `  account: ABC Digital (owner@demo.test / agent@demo.test, password: ${DEMO_PASSWORD})`,
  );
  console.log(`  property: ${property.name} -> ${property.publicId}`);
}

async function main(): Promise<void> {
  console.log('Seeding SmartChat development data...');
  const planIds = await seedPlans();
  await seedPlatformAdmin();
  await seedDemoAccount(planIds);
  console.log('Done.');
}

main()
  .catch((error: unknown) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
