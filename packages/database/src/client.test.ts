import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';

/**
 * The id extension must know which models it may decorate. This pins the one exception so that a
 * new model keyed on something other than `id` is a deliberate change to this list, not a 400 in
 * production.
 */
describe('models keyed on something other than id', () => {
  it('is exactly the platform settings table', () => {
    const keyedOtherwise = Prisma.dmmf.datamodel.models
      .filter((model) => !model.fields.some((field) => field.name === 'id' && field.isId))
      .map((model) => model.name);
    expect(keyedOtherwise).toEqual(['PlatformSetting']);
  });
});
