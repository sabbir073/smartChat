/**
 * The seed.
 *
 * Idempotent: safe to run repeatedly against the same database.
 *
 * It does two different jobs and they have different rules. Creating the **platform
 * administrator** is a real bootstrap step that a production server needs. Creating the **demo
 * account** - two users with a password published in this repository, and a website pointed at
 * localhost - is a development fixture.
 *
 * The header used to say the demo credentials "must never appear in any other environment" and
 * nothing whatsoever enforced it, while the deployment guide told an operator to run this file.
 * That is the shape of defect this project keeps finding: a promise in a comment with no code
 * behind it. Now production seeds the administrator and refuses the fixtures, and refuses the
 * shipped default administrator password too.
 */
import 'dotenv/config';
import { hash } from '@node-rs/argon2';
import { PrismaClient } from '@prisma/client';
import { v7 as uuidv7 } from 'uuid';
import { ID_PREFIX, isPublicId } from '../src/ids.js';

const prisma = new PrismaClient();

const ARGON2 = { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1, outputLen: 32 };

const DEMO_PASSWORD = 'Demo!Passw0rd';

/** Development fixtures are skipped here, and the defaults below are refused outright. */
const IS_PRODUCTION = process.env['NODE_ENV'] === 'production';

/** The values shipped in `.env.example`. Fine locally; a published credential in production. */
const SHIPPED_ADMIN_EMAIL = 'admin@smartchat.local';
const SHIPPED_ADMIN_PASSWORD = 'ChangeMe!SuperAdmin1';

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

const ALL_PERMISSIONS = [
  'account:view',
  'account:update',
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
  admin: ALL_PERMISSIONS.filter((p) => p !== 'account:delete'),
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

async function seedPlatformAdmin(): Promise<void> {
  const email = process.env['SUPERADMIN_EMAIL'] ?? SHIPPED_ADMIN_EMAIL;
  const password = process.env['SUPERADMIN_PASSWORD'] ?? SHIPPED_ADMIN_PASSWORD;

  /**
   * The one account that can suspend every customer does not get a password from a public file.
   *
   * `loadConfig` refuses placeholder secrets, but this script reads `process.env` directly and
   * never goes through it - so without this check, `prisma db seed` on a production server with
   * no `SUPERADMIN_PASSWORD` set would quietly create the operator account with the password
   * printed in `.env.example`.
   */
  if (IS_PRODUCTION && (password === SHIPPED_ADMIN_PASSWORD || email === SHIPPED_ADMIN_EMAIL)) {
    throw new Error(
      'Refusing to create the platform administrator with the credentials from .env.example. ' +
        'Set SUPERADMIN_EMAIL and SUPERADMIN_PASSWORD to real values before seeding in production.',
    );
  }

  if (IS_PRODUCTION && password.length < 12) {
    throw new Error('SUPERADMIN_PASSWORD must be at least 12 characters in production.');
  }

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
        'platform:usage:view',
        'platform:system:view',
        'platform:flag:manage',
        'platform:audit:view',
        'platform:settings:manage',
        'platform:billing:manage',
      ],
    },
  });

  console.log(`  platform admin: ${email}`);
}

async function seedDemoAccount(): Promise<void> {
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
   * An earlier version created the account, its members and its property as separate statements.
   * When a later one failed, the account existed without its property - and because the guard
   * above then saw an existing account, re-running the seed silently skipped the repair.
   * Atomicity is what makes "safe to run repeatedly" actually true.
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

    // The demo account has two members and one website: put it on a plan that allows that,
    // so the seed does not produce an account that is locked for being over its limits.
    const demoPlan =
      (await tx.plan.findFirst({ where: { isActive: true, maxMembers: { gte: 2 } }, orderBy: { sortOrder: 'asc' } })) ??
      (await tx.plan.findFirst({ where: { isDefault: true } }));
    if (!demoPlan) throw new Error('No plans exist; run the migrations first');
    await tx.subscription.create({
      data: { id: uuidv7(), accountId: account.id, planId: demoPlan.id, status: 'none', provider: 'manual', note: 'seeded demo account' },
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
  if (IS_PRODUCTION) {
    console.log('Seeding SmartChat (production: platform administrator only)...');
    await seedPlatformAdmin();
    console.log('Skipping the demo account and demo website - development fixtures.');
    console.log('Done.');
    return;
  }

  console.log('Seeding SmartChat development data...');
  await seedPlatformAdmin();
  await seedDemoAccount();
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
