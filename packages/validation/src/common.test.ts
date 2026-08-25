import { describe, expect, it } from 'vitest';
import { domainPatternSchema, emailSchema, websiteUrlSchema } from './common.js';

describe('websiteUrlSchema', () => {
  it('adds a scheme when the customer omits one', () => {
    expect(websiteUrlSchema.parse('example.com')).toBe('https://example.com');
    expect(websiteUrlSchema.parse('  shop.example.com  ')).toBe('https://shop.example.com');
  });

  it('keeps an explicit scheme', () => {
    expect(websiteUrlSchema.parse('http://example.com/path')).toBe('http://example.com/path');
  });

  it('refuses schemes that would become an injection vector', () => {
    expect(websiteUrlSchema.safeParse('javascript:alert(1)').success).toBe(false);
    expect(websiteUrlSchema.safeParse('data:text/html,<script>').success).toBe(false);
    expect(websiteUrlSchema.safeParse('file:///etc/passwd').success).toBe(false);
  });

  it('requires something that looks like a real host', () => {
    expect(websiteUrlSchema.safeParse('not a url').success).toBe(false);
    expect(websiteUrlSchema.safeParse('localhost').success).toBe(false);
  });
});

describe('domainPatternSchema', () => {
  it('accepts exact hosts and a single leading wildcard', () => {
    expect(domainPatternSchema.parse('Example.COM')).toBe('example.com');
    expect(domainPatternSchema.parse('*.example.com')).toBe('*.example.com');
    expect(domainPatternSchema.parse('shop.example.co.uk')).toBe('shop.example.co.uk');
  });

  it('accepts development hosts so local installs work', () => {
    expect(domainPatternSchema.safeParse('localhost').success).toBe(true);
    expect(domainPatternSchema.safeParse('127.0.0.1').success).toBe(true);
  });

  it('rejects wildcards that would match far too much', () => {
    expect(domainPatternSchema.safeParse('*').success).toBe(false);
    // A wildcard on a public suffix would authorise an entire TLD.
    expect(domainPatternSchema.safeParse('*.com').success).toBe(false);
    expect(domainPatternSchema.safeParse('exa*mple.com').success).toBe(false);
    expect(domainPatternSchema.safeParse('*.*.example.com').success).toBe(false);
  });
});

describe('emailSchema', () => {
  it('normalises case and whitespace so one person is one account', () => {
    expect(emailSchema.parse('  Owner@Example.COM ')).toBe('owner@example.com');
  });

  it('rejects malformed addresses', () => {
    expect(emailSchema.safeParse('owner@').success).toBe(false);
    expect(emailSchema.safeParse('owner example.com').success).toBe(false);
  });
});
