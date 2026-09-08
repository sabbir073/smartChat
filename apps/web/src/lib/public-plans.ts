import { readRuntimeConfig } from './runtime-config';
import type { PublicPlan } from '@/components/marketing/pricing';

/**
 * The plans for the public site, read server-side from the API.
 *
 * Cached for a minute by Next's fetch cache, so a burst of visitors is one request to the API
 * and a price change in the console reaches the site within the minute. When the API cannot be
 * reached the page says so rather than inventing numbers: a pricing page that guessed would be
 * wrong on exactly the day it mattered.
 */
export async function loadPublicPlans(): Promise<PublicPlan[] | null> {
  const { apiUrl } = readRuntimeConfig();
  try {
    const response = await fetch(`${apiUrl}/api/v1/billing/plans`, {
      headers: { accept: 'application/json' },
      next: { revalidate: 60 },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { success: boolean; data?: { plans: PublicPlan[] } };
    if (!body.success || !body.data) return null;
    return body.data.plans;
  } catch {
    return null;
  }
}
