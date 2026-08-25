/** Response shapes the dashboard consumes. These mirror the API's DTOs, not its database models. */

export interface PropertyDomainDto {
  id: string;
  pattern: string;
  isWildcard: boolean;
}

export interface PropertyDto {
  id: string;
  publicId: string;
  name: string;
  websiteUrl: string;
  status: 'active' | 'paused';
  timezone: string;
  locale: string;
  enforceDomains: boolean;
  installed: boolean;
  installedAt: string | null;
  lastWidgetRequestAt: string | null;
  domains: PropertyDomainDto[];
  createdAt: string;
}

export interface InstallationDto {
  publicId: string;
  loaderUrl: string;
  snippet: string;
  verified: boolean;
  lastRequestAt: string | null;
}

export interface MemberDto {
  id: string;
  userId: string;
  email: string;
  name: string;
  displayName: string | null;
  avatarUrl: string | null;
  role: string;
  status: string;
  availability: string;
  title: string | null;
  restrictedToProperties: boolean;
  propertyIds: string[];
  lastLoginAt: string | null;
  joinedAt: string | null;
}
